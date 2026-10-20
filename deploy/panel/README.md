# AIChat桥接 局域网管理面板

给 Linux 常驻部署配的管理面板：不用 VNC、不用 curl 拼 CDP，在局域网里用浏览器就能看状态、改配置、绑群、取消任务。

## 它是什么，不是什么

**是**：一个很薄的 HTTP 网关。它在**已经在跑的扩展设置页里**执行 `chrome.runtime.sendMessage({ type: 'options:*' })`，把结果转成 JSON 给面板前端。

**不是**：不是把扩展改造成服务端，也不是新的权限面。面板只转发扩展设置页**本来就有的**操作，因此扩展自己的校验一条不少：

- 设置页来源校验（worker 只接受 options.html 发来的 options:*）
- 不同助手不能复用同一个平台 App ID
- 配置与切换的单飞（同一时刻一个写操作）
- 绑定查重（同一对话/标签页不能绑两个平台）
- 停用前必须没有未完成任务

白名单在 `server.js` 的 `ALLOWED_RPC`，只有 14 个 `options:*`。`bridge:*` 是页面与后台之间的内部通道，面板**永远碰不到**。

## 安全模型（刻意做窄）

| 项 | 做法 |
| --- | --- |
| CDP 端口 | 面板只连 `127.0.0.1:9222`，**绝不**把 CDP 暴露到局域网 |
| 面板监听 | 默认 `127.0.0.1`；要局域网访问必须显式 `PANEL_BIND=0.0.0.0` |
| 登录 | 口令换 `HttpOnly` + `SameSite=Strict` 会话 Cookie，12 小时过期 |
| 写操作 | 额外要求 `X-Panel-CSRF` 头（值由会话派生），并校验 `Origin` |
| 口令比较 | `crypto.timingSafeEqual`，长度不同也走常量时间路径 |
| 暴力破解 | 按来源 IP 限速：5 分钟内 6 次失败即拒绝 |
| 代理头 | **不信任** `X-Forwarded-For`，直接取 socket 地址 |
| 页面 | 严格 CSP、`X-Frame-Options: DENY`、`nosniff`、`no-store` |
| 静态文件 | 路径必须落在 `public/` 内，挡住目录穿越 |
| 凭据 | 面板不存凭据；`appSecret` 只进不出（`options:status` 本来就不返回它） |

口令常见来源：`PANEL_TOKEN` 环境变量，或 `~/.local/share/aichat-bridge/panel/token`（首次启动自动生成，权限 0600）。

## 快速开始

```sh
# 1) 先把浏览器跑起来（面板需要一个活的扩展设置页）
./deploy/start-linux.sh start

# 2) 生成口令
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))" \
  | install -D -m 600 /dev/stdin ~/.local/share/aichat-bridge/panel/token

# 3) 启动面板（局域网可访问）
PANEL_BIND=0.0.0.0 PANEL_PORT=8787 node deploy/panel/server.js
```

浏览器打开 `http://<服务器局域网 IP>:8787/`，输入口令。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PANEL_PORT` | `8787` | 监听端口 |
| `PANEL_BIND` | `127.0.0.1` | 监听地址；局域网用 `0.0.0.0` |
| `PANEL_TOKEN` | 空 | 直接指定口令，优先于文件 |
| `PANEL_TOKEN_FILE` | `~/.local/share/aichat-bridge/panel/token` | 口令文件 |
| `AICHAT_DEBUG_PORT` | `9222` | 浏览器调试端口（只连本机） |

### systemd

```sh
cp deploy/panel/aichat-panel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now aichat-panel
journalctl --user -u aichat-panel -f
```

unit 里已经设了 `PANEL_BIND=0.0.0.0`；只想本机用就改成 `127.0.0.1`。

## 能做什么

- 五个助手（ChatGPT / Claude / Gemini / Qwen / Hark）的状态一览，点卡片切换
- 助手总开关、QQ / 飞书通道开关
- 保存机器人 App ID / App Secret（密钥留空表示保留原值）
- 选择发现的群 + 已打开的对话，完成绑定 / 解除绑定
- 编辑关键词词表
- 运行记录、任务状态、耗时拆解；取消排队任务
- 清除已结束记录、清除历史提示

## 自愈设计

扩展设置页被关掉时（浏览器重启、误关标签页），面板下一次请求会**自己用调试端口重新打开它**，然后继续。不需要人工干预。

扩展 id 由扩展目录绝对路径决定，每个部署不同，所以面板从现场已有的扩展目标里读 id，不写死。

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 登录后一直显示「扩展后台不可用」 | 浏览器没跑，或不是用 `--load-extension` 启动的 | `./deploy/start-linux.sh status`，再看 `curl 127.0.0.1:9222/json/list` 里有没有 `chrome-extension://` 目标 |
| 「没有加载 AIChat桥接 扩展」 | 调试端口上没有扩展目标 | 确认启动参数里 `--load-extension` 指向 `extension/` 目录 |
| 改了配置但浏览器里没变 | 面板走的是扩展自己的 RPC，必有延迟 | 面板操作成功后会自动重读状态；仍旧不变得看扩展后台日志 |
| 局域网打不开 | 面板只绑了 `127.0.0.1`，或被防火墙挡住 | 设 `PANEL_BIND=0.0.0.0`，放行 8787 |
| 口令忘了 | — | 删掉 token 文件后重启面板会重新生成；或直接设 `PANEL_TOKEN` |

## 不要做的事

- 不要把 `8787` 映射到公网。它是为局域网设计的，只有单口令保护。
- 不要把 `PANEL_BIND` 和 `--remote-debugging-address=0.0.0.0` 一起放开：CDP 是**无鉴权**的，暴露它等于把浏览器交给任何能连上端口的人。
- 不要在不可信网络（咖啡厅 Wi-Fi、公共 VPS 的共享网段）里开 `0.0.0.0`。需要远程就用 SSH 隧道：

  ```sh
  ssh -L 8787:127.0.0.1:8787 user@server
  # 然后本地开 http://127.0.0.1:8787/
  ```
