# 在 Debian 12 无头服务器上常驻运行 AIChat桥接

本目录提供把 `extension/`（Chrome MV3 扩展）跑在**没有显示器**的 Debian 12 服务器上的完整方案：

- `start-linux.sh` — 幂等启动脚本：Xvfb 虚拟显示 + **有头** Chromium + 固定 profile + 加载扩展
- `aichat-bridge.service` — systemd `--user` unit，开机自启 + 崩溃自动拉起
- 本文 — 依赖安装、首次登录、权限、日志、排错

> 实测环境：Debian GNU/Linux 12 (bookworm)，`Chromium 155.0.8059.39`，`Xvfb`（Debian 包），root 用户，扩展 id `icbogfapodmmniggkaonnhggfnbondmk`。

---

## 1. 为什么是「有头 Chromium + Xvfb」而不是 `--headless`

扩展的 `background` 是 `service_worker`（`extension/manifest.json`），业务重活完全依赖
`chrome.offscreen` 文档 + Service Worker 常驻（见 `extension/worker.js` 里
`chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'] })`）。

Chrome 的 headless 模式对这种组合仍有已知问题：Service Worker 生命周期被压缩、offscreen 文档
可能迟迟不创建，扩展「看着加载了但什么都不干」。所以这里用 **虚拟 X server（Xvfb）+ 真正的有头
Chromium**：浏览器认为自己在一个正常桌面会话里，MV3 SW 与 offscreen 文档的行为和普通桌面一致。

代价是需要多一个 Xvfb 进程和一个固定 profile 目录——脚本已经把这部分封好了。

---

## 2. 依赖安装

```bash
# root 或 sudo
apt-get update
apt-get install -y --no-install-recommends \
  chromium xvfb xauth curl jq ca-certificates fonts-noto-cjk

# 可选：想用 VNC 人工登录时
apt-get install -y --no-install-recommends x11vnc
```

确认：

```bash
/usr/bin/chromium --version     # Chromium 155.x built on Debian GNU/Linux 12
command -v Xvfb xvfb-run curl jq
```

> **字体很重要**：不装 `fonts-noto-cjk`，中文页面（QQ/飞书后台、设置页）会全是方块，
> 有些前端框架会因为布局塌陷导致点击坐标错位。

**不要用 root 跑生产**。下面默认假设用普通用户 `aichat`；本机实测用的是 root，
脚本检测到 uid=0 时会自动追加 `--no-sandbox`。

---

## 3. 快速开始

```bash
cd $HOME/aichat-bridge

./deploy/start-linux.sh start      # 启动（幂等，重复执行不会起第二个实例）
./deploy/start-linux.sh status     # 看状态 + DevTools 版本信息
./deploy/start-linux.sh stop       # 停止（TERM -> 等 10s -> KILL，只杀自己 pidfile 里的 pid）
./deploy/start-linux.sh restart
./deploy/start-linux.sh run        # 前台模式，给 systemd 用（exec chromium，MainPID 即 chromium）
```

脚本用到的关键 chromium 参数：

| 参数 | 作用 |
| --- | --- |
| `--user-data-dir=$BASE/profile` | 固定 profile，登录态/扩展存储都留在这里 |
| `--load-extension=$EXT_DIR` + `--disable-extensions-except=$EXT_DIR` | 以未打包方式加载 `extension/`，且只加载它 |
| `--remote-debugging-port=9222` / `--remote-debugging-address=127.0.0.1` | 暴露 CDP，用于验证与远程操作 |
| `--password-store=basic` | 无 keyring 的服务器上必须，否则 chromium 会卡在「解锁密钥环」 |
| `--no-first-run --no-default-browser-check --noerrdialogs --disable-session-crashed-bubble` | 无头环境里不弹窗、不卡首启向导 |
| `--disable-background-timer-throttling` | **保活核心**：后台标签页的 `setTimeout` 不被降频到 1 次/分钟 |
| `--disable-backgrounding-occluded-windows` | 窗口被遮挡（Xvfb 下永远「遮挡」）时不降级 |
| `--disable-renderer-backgrounding` | 渲染进程不因不可见被降优先级 |
| `--disable-features=CalculateNativeWinOcclusion,...` | 关掉原生窗口遮挡计算，避免 Chromium 自己把标签页判定为 hidden |
| `--window-size=1920,1080` | 与 Xvfb `-screen 0 1920x1080x24` 对齐，减少布局抖动 |

### 可配置的环境变量

全部都有默认值，改环境变量即可覆盖（systemd 场景也可写进 `~/.config/aichat-bridge/env`）：

| 变量 | 默认值 |
| --- | --- |
| `AICHAT_EXT_DIR` | `<repo>/extension` |
| `AICHAT_DISPLAY` | `:99` |
| `AICHAT_SCREEN` | `1920x1080x24` |
| `AICHAT_WINDOW_SIZE` | `1920,1080` |
| `AICHAT_DEBUG_PORT` | `9222` |
| `AICHAT_BASE_DIR` | `$HOME/.local/share/aichat-bridge` |
| `AICHAT_USER_DATA_DIR` | `$BASE/profile` |
| `AICHAT_RUN_DIR` / `AICHAT_LOG_DIR` | `$BASE/run` / `$BASE/logs` |
| `AICHAT_CHROME_BIN` / `AICHAT_XVFB_BIN` | 自动 `command -v` 探测 |
| `AICHAT_EXTRA_FLAGS` | 空，追加到 chromium 参数前面 |

```bash
# 例：换显示号与端口（同机跑多份时必做）
AICHAT_DISPLAY=:98 AICHAT_DEBUG_PORT=9333 ./deploy/start-linux.sh start
```

---

## 4. 目录布局与权限

```
$HOME/.local/share/aichat-bridge/
├── profile/      # chromium user-data-dir：登录 Cookie、扩展 storage、缓存（约 5MB 起）
├── run/          # chromium.pid / xvfb.pid
└── logs/         # chromium.log / xvfb.log
```

- 脚本会 `mkdir -p` 上述目录，并把 `$BASE` 与 `profile/` 设成 `700`。
- **profile 里有 ChatGPT / 飞书 / QQ 的登录 Cookie，等同于凭据**，务必只给运行用户可读：
  ```bash
  chmod 700 ~/.local/share/aichat-bridge ~/.local/share/aichat-bridge/profile
  ```
- 多次运行请用**不同** `AICHAT_BASE_DIR` 或不同 `AICHAT_USER_DATA_DIR`，
  同一个 user-data-dir 被两个 chromium 同时打开会直接退出（profile lock）。
- 别把 `profile/` 放进 git：仓库 `.gitignore` 之外的位置由你自己保证。

---

## 5. 首次登录（关键步骤）

扩展本身不做登录，**登录态属于网页 Cookie**，必须先在 profile 里登录一次：

1. 启动：`./deploy/start-linux.sh start`
2. 打开页面（本机实测命令，注意 Chrome 111+ `/json/new` 必须用 **PUT**）：

   ```bash
   curl -s -X PUT 'http://127.0.0.1:9222/json/new?https://chatgpt.com/'
   ```

3. 两种登录方式，任选：

   **A. VNC（推荐，能看见画面、能过验证码）**

   ```bash
   apt-get install -y x11vnc
   x11vnc -display :99 -localhost -rfbport 5900 -nopw -forever -shared
   # 本地建隧道后连上：ssh -L 5900:127.0.0.1:5900 user@server，VNC 客户端连 127.0.0.1:5900
   ```
   用 VNC 里的 chromium 窗口正常登录 chatgpt.com / claude.ai / gemini.google.com / chat.qwen.ai。

   **B. CDP（只适合已登录过、或能纯脚本完成的场景）**

   ```bash
   # 拿页面 ws 地址
   curl -s http://127.0.0.1:9222/json/list | jq -r '.[] | select(.url|test("chatgpt.com")) | .webSocketDebuggerUrl'
   ```
   再用任意 CDP 客户端（puppeteer / chromedp / websocat）填表提交。
   注意：Cloudflare 人机校验在纯 CDP 下经常过不去，验证码场景请走 VNC。

4. 登录完成后再回去配置扩展的 QQ/飞书参数：
   `curl -s -X PUT 'http://127.0.0.1:9222/json/new?chrome-extension://<EXT_ID>/options.html'`
   或直接在 VNC 里点扩展图标。`<EXT_ID>` 可从 `/json/list` 里的 `chrome-extension://<id>/worker.js` 读出来。

登录态保存在 `profile/`，只要不删目录，重启机器/重启服务都不用重新登录。

---

## 6. systemd --user 常驻

```bash
mkdir -p ~/.config/systemd/user
cp deploy/aichat-bridge.service ~/.config/systemd/user/

# 仓库不在 $HOME/aichat-bridge 的话，改 WorkingDirectory / ExecStart 路径
$EDITOR ~/.config/systemd/user/aichat-bridge.service

systemctl --user daemon-reload
systemctl --user enable --now aichat-bridge
systemctl --user status aichat-bridge
```

**必须开 linger**，否则 SSH 一退出，user manager 连同服务一起被回收：

```bash
loginctl enable-linger "$(id -un)"     # 需要 root / polkit 授权，只需执行一次
loginctl show-user "$(id -un)" | grep Linger    # 期望 Linger=yes
```

unit 要点：

- `ExecStart=... start-linux.sh run` —— `run` 会 `exec` chromium，所以 **MainPID 就是 chromium 本体**，
  `Restart=always` 才能感知到浏览器崩溃（如果用 `start` 子命令，脚本 fork 完就退出，
  systemd 会认为服务已结束）。
- `ExecStop=... stop` 走 pidfile + cmdline 校验的优雅停止。
- `KillMode=control-group` 兜底：chromium 挂了残留的 Xvfb 会被一起清理。
- `RestartSec=5`，`TimeoutStopSec=30`。
- 换端口/显示号：`~/.config/aichat-bridge/env` 里写 `AICHAT_DEBUG_PORT=9333` 等（unit 已 `EnvironmentFile`）。

常用：

```bash
journalctl --user -u aichat-bridge -f          # 实时日志
systemctl --user restart aichat-bridge
systemctl --user disable --now aichat-bridge
```

---

## 7. 日志位置

| 日志 | 位置 |
| --- | --- |
| chromium stdout/stderr | `$BASE/logs/chromium.log`（默认 `~/.local/share/aichat-bridge/logs/chromium.log`） |
| Xvfb | `$BASE/logs/xvfb.log` |
| systemd 方式运行 | `journalctl --user -u aichat-bridge`（脚本自身的 log 行也进 journal） |
| 扩展自己的日志 | chromium 内 DevTools，或 VNC 里开 `chrome://extensions` 的「服务工作进程 / 检查视图」 |

日志不会自动轮转，长期跑建议加 logrotate（**不改 /etc**，放用户级）：

```bash
mkdir -p ~/.config/logrotate.d
cat > ~/.config/logrotate.d/aichat-bridge <<'EOF'
$HOME/.local/share/aichat-bridge/logs/*.log {
    weekly
    rotate 4
    missingok
    notifempty
    copytruncate
}
EOF
# cron 里加: 0 4 * * 0 logrotate -s ~/.local/share/aichat-bridge/logrotate.state ~/.config/logrotate.d/aichat-bridge
```

---

## 8. 验证

以下均为**本机真实执行**的命令与输出片段（2026-10-20，Debian 12，Chromium 155）。

### 8.1 启动

```console
$ ./deploy/start-linux.sh start
[2026-10-20 03:21:22] 启动 Xvfb :99 -screen 0 1920x1080x24
[2026-10-20 03:21:22] Xvfb 就绪 (pid=517030)
[2026-10-20 03:21:22] 启动 chromium (/usr/bin/chromium) display=:99 ext=$HOME/aichat-bridge/extension
[2026-10-20 03:21:22] chromium 就绪 (pid=517040), DevTools: http://127.0.0.1:9222
```

### 8.2 `/json/version` 有输出

```console
$ curl -s http://127.0.0.1:9222/json/version
{
   "Browser": "Chrome/155.0.8059.39",
   "Protocol-Version": "1.3",
   "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
   "V8-Version": "15.5.35.20",
   "WebKit-Version": "537.36 (@3ff7ac5a9224be9156d7f8703a06e22890aafd34)",
   "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/4c09a5a1-449e-49db-ab2f-5607a1cae642"
}
```

### 8.3 扩展的 service_worker / background_page 目标存在

```console
$ curl -s http://127.0.0.1:9222/json/list | jq -r '.[] | [.type,.url] | @tsv'
background_page	chrome-extension://icbogfapodmmniggkaonnhggfnbondmk/offscreen.html
page	chrome-extension://icbogfapodmmniggkaonnhggfnbondmk/options.html
page	https://chatgpt.com/
page	about:blank
browser_ui	chrome://omnibox-popup.top-chrome/
browser_ui	chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html
service_worker	chrome-extension://icbogfapodmmniggkaonnhggfnbondmk/worker.js
worker	

$ curl -s http://127.0.0.1:9222/json/list \
    | jq '[.[] | select(.type=="service_worker" or .type=="background_page") | {type,url,title}]'
[
  {
    "type": "background_page",
    "url": "chrome-extension://icbogfapodmmniggkaonnhggfnbondmk/offscreen.html",
    "title": "AIChat桥接 · 后台"
  },
  {
    "type": "service_worker",
    "url": "chrome-extension://icbogfapodmmniggkaonnhggfnbondmk/worker.js",
    "title": "Service Worker chrome-extension://icbogfapodmmniggkaonnhggfnbondmk/worker.js"
  }
]
```

两个关键目标都在。

> **时序注意**：`service_worker` 是 chromium 一启动就有的；`background_page(offscreen.html)`
> 要等 SW 跑到 `chrome.offscreen.createDocument()` 才出现，通常 1–3 秒。启动后立刻查可能只看到
> `service_worker`，这是正常的，等几秒再查。实测两种时刻都出现过：

```console
# 刚启动 1s：只有 worker
$ curl -s http://127.0.0.1:9222/json/list | jq -r '[.[] | select(.url|test("chrome-extension://")) | .type] | @tsv'
service_worker

# 约 10s 后：worker + offscreen 文档
$ curl -s http://127.0.0.1:9222/json/list | jq -r '[.[] | select(.url|test("chrome-extension://")) | .type] | @tsv'
background_page	page	service_worker
```

所以**判活标准是「`service_worker` 目标存在」**，offscreen 出现只是加分项。
一条命令搞定启动 + 判活：

```bash
./deploy/start-linux.sh start
for i in $(seq 1 30); do
  T=$(curl -s http://127.0.0.1:9222/json/list \
      | jq -r '[.[] | select(.type=="service_worker") | .url] | .[0] // empty')
  [ -n "$T" ] && { echo "OK: $T"; break; }
  sleep 1
done
```


- `service_worker` → `chrome-extension://<id>/worker.js`（MV3 后台）
- `background_page` → `chrome-extension://<id>/offscreen.html`（`chrome.offscreen` 文档已经创建，
  说明 worker 里 `createDocument` 那条路走通了）

扩展未打包加载时，id 由扩展目录的**绝对路径**决定（`sha256(路径)[:32]`，每 4 bit 映射到 a–p）。
也就是说：仓库换目录 = 换 id = `chrome.storage` 里的旧配置看起来「丢了」（网页 Cookie 不受影响）。

```sh
python3 -c "import hashlib;p='$HOME/aichat-bridge/extension';h=hashlib.sha256(p.encode()).hexdigest()[:32];print(''.join(chr(ord('a')+int(c,16)) for c in h))"
```

拿这条命令的输出和你 `json/list` 里看到的 `chrome-extension://<id>/worker.js` 比对，一致就说明加载的正是这个目录。
搬仓库后网页登录 Cookie 还在 profile 里，但 `chrome.storage` 里的配置需要重新配一次。

### 8.4 打开 chatgpt.com 标签页后出现在列表里

```console
$ curl -s -X PUT 'http://127.0.0.1:9222/json/new?https://chatgpt.com/'
{
   "description": "",
   "devtoolsFrontendUrl": "https://chrome-devtools-frontend.appspot.com/serve_rev/@3ff7ac5a9224be9156d7f8703a06e22890aafd34/inspector.html?ws=127.0.0.1:9222/devtools/page/B27EC47DB441B7D41937B6C1A03C7926",
   "id": "B27EC47DB441B7D41937B6C1A03C7926",
   "title": "",
   "type": "page",
   "url": "https://chatgpt.com/"
}

$ curl -s http://127.0.0.1:9222/json/list \
    | jq -r '.[] | select(.url|test("chatgpt.com")) | "\(.type) | \(.url) | \(.title)"'
page | https://chatgpt.com/ | ChatGPT: Chat, Work, Create &amp; Code with AI
```

### 8.5 停止与清理

```console
$ ./deploy/start-linux.sh stop
[2026-10-20 03:21:29] chromium: 发送 TERM 到 pid=517040
[2026-10-20 03:21:29] chromium: 已退出 (TERM 生效)
[2026-10-20 03:21:29] xvfb: 发送 TERM 到 pid=517030
[2026-10-20 03:21:29] xvfb: 已退出 (TERM 生效)

$ (curl -s --max-time 2 http://127.0.0.1:9222/json/version >/dev/null && echo 仍在监听) || echo 9222 已关闭
9222 已关闭
```

### 8.6 幂等性与「只杀自己」的验证

```console
$ ./deploy/start-linux.sh start
[2026-10-20 03:20:33] chromium 已在运行 (pid=514971), 无需重复启动 (幂等)
[2026-10-20 03:20:33] DevTools 可用: http://127.0.0.1:9222/json/version

# 故意把无关进程的 pid 塞进 xvfb.pid，验证不会误杀
$ sleep 300 & FAKE=$!; echo "$FAKE" > ~/.local/share/aichat-bridge/run/xvfb.pid
$ ./deploy/start-linux.sh stop
[2026-10-20 03:20:33] chromium: 发送 TERM 到 pid=514971
[2026-10-20 03:20:33] chromium: 已退出 (TERM 生效)
[2026-10-20 03:20:33] xvfb: pid=515111 的 cmdline 不含 'Xvfb :99', 判定为无关进程, 跳过
PASS: 无关进程 515111 仍存活
```

脚本里**没有任何 `killall` / `pkill`**。`stop` 的判定链是：
读 pidfile → `kill -0` 存活 → `/proc/<pid>/cmdline` 里必须含 `--user-data-dir=<本目录>`
（Xvfb 则必须同时含 `Xvfb` 与 `<显示号>`）→ 才 TERM，10s 不退再 KILL。

---

## 9. 常见排错

### 9.1 扩展没加载（`json/list` 里没有 `chrome-extension://` 目标）

1. 看 `$BASE/logs/chromium.log` 有没有
   `Failed to load extension` / `Manifest file is missing or unreadable` / `Could not load manifest`。
2. 确认 `--load-extension` 指向**绝对路径**且末尾是含 `manifest.json` 的目录：
   `ls $AICHAT_EXT_DIR/manifest.json`。
3. Debian 的 `/usr/bin/chromium` 是个 wrapper，会追加 `/etc/chromium.d/*` 里的 flags，
   包括一条 `--load-extension=/usr/share/chromium/extensions/*`。这不影响我们，但如果你看到
   命令行里 `--load-extension=` 空了一项，就是 `/etc/chromium.d/extensions` 在 `ls` 空目录，
   可以不管。
4. 目录权限：chromium 进程的运行用户必须能读 `extension/` 全部文件。
5. 换了仓库路径 → 扩展 id 变了，不是没加载，用新 id 去查。

### 9.2 标签页被冻结 / 定时器被降频（消息进来但半天没反应）

症状：`content.js` 的轮询和 `worker.js` 的 `alarms` 都"睡着了"，手动切一下标签页就恢复。

- 确认启动参数里有 `--disable-background-timer-throttling`、`--disable-renderer-backgrounding`、
  `--disable-backgrounding-occluded-windows`、
  `--disable-features=CalculateNativeWinOcclusion`（脚本默认全带）。
- 只有**一个**标签页时容易被判为 hidden，可以多留一个 `about:blank`（脚本默认就开了）。
- 还不行：`chrome://settings/performance` 关掉「内存节省/节能模式」——
  CDP 里 `Page.setWebLifecycleState` 也可以强制 `active`：
  ```bash
  # 简化做法：用 CDP 把页面标记为 active（需 websocket 客户端）
  # ws://127.0.0.1:9222/devtools/page/<id>  send: {"id":1,"method":"Page.setWebLifecycleState","params":{"state":"active"}}
  ```
- 机器内存小（<2G）时 chromium 会主动丢弃后台标签页，加 swap 或用 `--disable-dev-shm-usage`（脚本已带）。

### 9.3 `chrome.offscreen` 报错

| 日志里的样子 | 含义 / 处理 |
| --- | --- |
| `Only a single offscreen document may be created` | 重复 `createDocument`；`worker.js` 应先 `hasDocument()` 再创建。SW 重启后通常自愈。 |
| `Cannot create offscreen document ... reasons` | manifest 里缺 `offscreen` 权限（本仓库已有）。 |
| `Error: No current offscreen document` | offscreen.html 被回收了；SW 里重新 `createDocument` 即可。 |
| `background_page ... offscreen.html` 在 `json/list` 里**不存在** | 先分清两种情况：(a) 刚启动 1–3 秒内——正常，offscreen 文档还没创建，等一下再查；(b) 长时间没有——worker 起来了但 `createDocument` 失败，去 `chrome://extensions` 的「服务工作进程」里看 console 报错，或看 `chromium.log`。完全看不到 `service_worker` 才是真的没加载。 |

排查入口（VNC 里或远程 CDP）：
`chrome://extensions` → 打开「开发者模式」→ 点扩展卡片上的「服务工作进程 / Service Worker」
直接看 console。

### 9.4 Xvfb / DISPLAY 相关

| 现象 | 处理 |
| --- | --- |
| `Missing X server or $DISPLAY` | 脚本自己会 `DISPLAY=:99` 传给 chromium；手工起 chromium 时要先 `export DISPLAY=:99`。 |
| `Server is already active for display 99` | 显示号被别的 X server 占用。脚本会明确报错并让你换号：`AICHAT_DISPLAY=:98 ./deploy/start-linux.sh start`。 |
| `Xvfb 超时未就绪` | 看 `$BASE/logs/xvfb.log`；常见是 `/tmp/.X11-unix` 权限或磁盘满。 |
| 截图全黑/尺寸不对 | `-screen 0 1920x1080x24` 与 `--window-size=1920,1080` 必须匹配；改一个就同步改另一个。 |
| `xdpyinfo -display :99` 报错 | Xvfb 没起来或被 kill 了，`./deploy/start-linux.sh status` 先确认。 |

### 9.5 root / 沙箱 / dbus 噪音

- root 下 chromium 必须 `--no-sandbox`，脚本检测到 `uid=0` 会自动加。
- `Failed to connect to the bus: Could not parse server address` 在容器/服务器上是**正常噪音**，
  不影响扩展；要消掉就装 `dbus` 并起 `dbus-daemon --system`。
- `Registration response error message: DEPRECATED_ENDPOINT`（GCM）也是无害噪音。

### 9.6 服务起来又立刻退出

```bash
journalctl --user -u aichat-bridge -n 80 --no-pager
```
- `AIChat 找不到 chromium` → 装 `chromium` 或设 `AICHAT_CHROME_BIN`。
- profile lock → 上一个实例没退干净：`./deploy/start-linux.sh stop` 后确认
  `pgrep -af aichat-bridge/profile` 为空再启。
- `Linger=no` → SSH 断开后服务被回收，`loginctl enable-linger` 补上。

---

## 10. Linux 上仍然存在的限制（实测结论）

1. **登录态靠 profile，不是「一次配好永远有效」**。ChatGPT/Claude/Gemini 的 Cookie 会过期，
   Cloudflare 人机校验在纯 CDP 下经常过不去，届时必须 VNC 进去手动点一次。
   服务器 IP 被判定为高风险时还可能要求邮箱验证码。
2. **有头不等于有 GPU**。脚本刻意带 `--disable-gpu`（Xvfb 没有 GPU），
   重度依赖 WebGL/Canvas 的前端可能渲染异常；本扩展的功能是 DOM 操作，不受影响。
3. **不能真的 headless**。MV3 SW + offscreen 在 `--headless` 下不稳定，
   所以必须维持 Xvfb 这个额外进程；换机器/容器要注意 `/tmp/.X11-unix` 可写。
4. **标签页保活是「尽力而为」**。chromium 在内存压力下仍可能丢弃后台标签页；
   多标签时被丢弃的页会重新加载，导致 `content.js` 重新注入、进行中的回复丢失。
   长跑建议给机器留足内存，别顺手开一堆网页。
5. **一个 profile 只能一个实例**。要并行多份必须分 `AICHAT_BASE_DIR` + `AICHAT_DISPLAY` + `AICHAT_DEBUG_PORT`。
6. **扩展 id 与路径绑定**（未打包加载）。搬目录 = 新 id = 扩展存储配置「丢失」（Cookie 不受影响）。
7. **systemd `--user` 依赖 linger**。没开 linger，SSH 一断服务就没了；
   开 linger 需要 root/polkit 授权。
8. **远程调试端口是明文无鉴权**。脚本绑 `127.0.0.1`，不要改成 `0.0.0.0`，
   真要跨机访问走 SSH 隧道。
