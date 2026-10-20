# Hark 接入说明（Hark Pro · app.hark.com）

本文记录把 Hark 作为第五个助手接进本扩展的完整链路、已核实的事实、以及登录后才能完成的那一步标定。

## 1. 一句话现状

扩展侧链路已全部接好并有测试覆盖（来源校验、URL 规则、适配器加载、设置页、错误兜底）；只剩登录后的对话 DOM 未标定。
在未标定状态下，Hark 通道的任何任务都会停在「Hark 对话页结构尚未标定」并停止，不会误点按钮、不会误发提问。

## 2. 站点事实（实测，2026-10）

| 事实 | 证据 |
| --- | --- |
| 产品在 app.hark.com，营销站在 hark.com | hark.com 是 Next.js App Router；app.hark.com 是另一套 React 应用 |
| 未登录时除登录页外全部 401 | app.hark.com 的 /、/chat、/settings 均返回 401，浏览器里跳 /login?redirectTo=… |
| 登录路由表（取自登录页 bundle） | /chat、/chat/:messageId、/project/:projectId、/project/:projectId/:messageId、/room/:roomId、/rooms、/projects、/settings/** |
| 类名不可用 | 两个站点都用 CSS Modules 哈希类名（biwpmn0、_10qhyq2a），随发布变化；选择器只能靠 data-testid / 结构 / 文本 |
| 登录页有稳定 data-testid | auth-page-shell、auth-card、entry-input、entry-continue、google-sign-in、apple-sign-in、phone-code 等 |
| 输入区不在 iframe / shadow root 里 | 探针实测：hark.com 仅 1 个 open shadow root（next-route-announcer，与输入区无关），app 页 0 个 |

## 3. 改了哪些文件

| 文件 | 作用 |
| --- | --- |
| extension/hark-dom.js（新增） | Hark 适配器。对外导出与其它助手相同的契约（composer、assertReady、findSubmittedUser、finalCandidate 等），内部只认 SELECTORS 登记表 |
| extension/shared.js | 注册助手 hark、名称、源 https://app.hark.com 、会话 URL 规则与保留路径 |
| extension/content.js | 按页面源选择适配器时新增 hark-dom.js 分支 |
| extension/manifest.json | 增加 https://app.hark.com/* 的 host、content_scripts、web_accessible_resources matches 与 CSP connect-src |
| extension/options.html / options.js / assets/hark.svg | 设置页第五张助手卡片、绑定提示文案 |
| extension/worker.js / qq-store.js / feishu-store.js | 来源校验与绑定报错文案涵盖 Hark |
| test/extension-hark-dom.test.js、test/helpers/hark-fixture.js（新增） | 适配器契约测试与合成 DOM 夹具 |
| scripts/hark-dom-probe.js、scripts/hark-probe-result.json、scripts/hark-probe-readme.md（新增） | 只读 CDP 探针，标定用 |
| deploy/（新增） | Linux 常驻运行，见 deploy/README.md |

## 4. 会话 URL 规则

只允许三类真实会话路径，其它一律拒绝（不会被当成可绑定的对话）：

```
https://app.hark.com/chat/<消息 ID>
https://app.hark.com/project/<项目 ID>/<消息 ID>
https://app.hark.com/room/<房间 ID>
```

根路径、/login、/chat（无 ID）、/projects、/rooms、/settings/**、/plans、/profile 等入口页都在 shared.js 的 HARK_RESERVED_PATHS 里。
营销站 hark.com 不是助手源，assistantForUrl 直接返回 null。

## 5. 登录后必须完成的标定（7 项）

登录后（见 deploy/README.md 第 5 节的 VNC / CDP 方式），在同一浏览器里跑探针：

```sh
# 1) 启动常驻浏览器（Xvfb + 有头 Chromium）
./deploy/start-linux.sh start

# 2) 人工登录并打开一个真实会话（这一步只能人工做）

# 3) 只读探测当前会话页
node scripts/hark-dom-probe.js --port 9222 --url-prefix app.hark.com --out /tmp/hark-thread.json --html /tmp/hark-thread.html
```

要补的钩子，逐一填进 extension/hark-dom.js 的 SELECTORS：

| 键 | 用途 | 怎么认 |
| --- | --- | --- |
| composer | 对话输入框 | composers[] 中可见、可输入、在消息区底部的那一个 |
| scope | 输入区容器 | composerScopes[] |
| send | 发送按钮 | sendButtonCandidates[] 里未 disabled 的那个 |
| stop | 生成中的停止按钮 | 触发一次生成后重新探测 |
| user / assistant | 两侧消息节点 | repeatedGroups[] 里结构相同的行 |
| answerBody | 回复正文容器 | 助手消息里的 markdown 根节点 |
| completion | 完成标记（复制/重新生成） | 回复完成后才出现的操作栏 |
| attachment | 输入区附件卡片 | 上传一张图片后重新探测 |

填完后：

```sh
npm run check && npm test
# 再按 test/helpers/hark-fixture.js 的结构把合成夹具同步成实测结构
```

## 6. 兼容性设计（为什么没标定也能安全启用）

- 失败关闭：所有查询失败都抛 PageSafetyError，消息里直接点名缺哪个钩子并指向本文件。
- 不会误点：sendButton 要求输入区里恰好一个可见且可用的发送控件，否则返回 null，content.js 就不会点击。
- 归属校验：只接受与本次群提问正文完全一致的新提问；出现第二个新消息、或已确认的消息被替换，立即停止。
- 完成判定：必须有本轮唯一的、带完成标记（completion）的回复；流式中或出现多个回复都返回 null。
- 登录态与验证：signedOut 命中登录页结构、或出现 Cloudflare 验证，会明确要求人工处理，不会尝试绕过。

## 7. 已知限制

- Hark Pro 需要付费账号；扩展只复用网页登录态，不处理账号与订阅。
- 图片域名目前按 app.hark.com 与 assets.hark.com 放行，标定时若图片来自其它 CDN，需要在 answerImageSource 与 manifest.json 的 connect-src 同步放行。
- 登录页 data-testid 已实测；对话页的 data-testid 是否存在取决于 Hark 的工程习惯，若对话页没有 data-testid，则用结构与稳定文本组成选择器，仍然只改 SELECTORS 一张表。
- 这是网页自动化，不是 Hark 官方 API；页面改版会失效，失效后表现为明确的中文报错而不是静默错误。
