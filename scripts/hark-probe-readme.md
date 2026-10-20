# hark.com DOM 标定探针（scripts/hark-dom-probe.js）

只读 DOM 探测工具：用 Chrome DevTools Protocol（Node 自带 WebSocket，不依赖 puppeteer/playwright）连到
`--remote-debugging-port` 上的 hark 标签页，在页面内执行一段自包含探测函数，导出适配器标定所需的
输入框、发送按钮、消息容器候选与页面结构事实。**不输入、不点击、不导航、不读取凭据。**

## 关键结论（先看这里）

1. **hark.com 是 Next.js App Router（RSC）+ CSS Modules**：`isNextJs: true`、`nextAppRouter: true`（`self.__next_f` 推送）、
   24 个 `/_next/` 静态资源、无 `__NEXT_DATA__`。类名是构建哈希，例如
   `auth-form-module-scss-module__8oHL4W__emailForm`、`button-module-scss-module__4QgQTW__container`、`_10qhyq25`、`phwvnh8`。
   **选择器只能靠 `data-testid` / DOM 结构 / 可见文本 / aria 属性，绝不能靠类名**——类名随构建变化。
2. 应用页 `app.hark.com` 未登录会 302 到 `/login`，该页**不是** Next.js（`assets.hark.com` + React root），
   但这一层**有稳定 data-testid**，登录入口与登录表单已标定（见下表）。
3. 登录前的两个页面**都没有对话 composer**：`chatComposers == 0`，可见输入框全是登录/邮箱框。
   对话输入框、发送键、消息列表都要登录后补标。

## 如何重跑探针

```bash
# 1) 用仓库自带部署脚本拉起常驻浏览器（已含 Xvfb + --remote-debugging-port=9222）
./deploy/start-linux.sh start
./deploy/start-linux.sh status          # 确认 chromium / Xvfb 都在跑

# 2) 跑探针（登录前先看入口页，登录后再跑一次同样的命令补标定）
node scripts/hark-dom-probe.js --port 9222 --url-prefix app.hark.com \
  --out scripts/hark-probe-result.json --timeout 60000 --settle 12000

# 需要 HTML 快照时加 --html（不要提交进仓库）
node scripts/hark-dom-probe.js --port 9222 --url-prefix hark.com --html /tmp/hark-page.html

# 3) 收工
./deploy/start-linux.sh stop
```

手动起浏览器（不走部署脚本时）：

```bash
Xvfb :77 -screen 0 1440x900x24 &
DISPLAY=:77 /usr/bin/chromium --remote-debugging-port=9222 --remote-allow-origins='*' \
  --user-data-dir=/tmp/hark-profile --no-sandbox --disable-gpu https://hark.com/ &
```

| 参数 | 作用 |
| --- | --- |
| `--port <n>` | Chromium 远程调试端口，默认 9222 |
| `--url-prefix <s>` | 按 URL 前缀选标签页，默认 `hark.com`；单独探测应用页用 `app.hark.com` |
| `--out <file>` | JSON 写文件；省略则写 stdout |
| `--html <file>` | 额外保存 `document.documentElement.outerHTML` 快照 |
| `--timeout <ms>` | CDP 连接 + 求值总超时，默认 30000 |
| `--settle <ms>` | 求值前等待输入框挂载的最长时间，默认 8000 |
| `--list` | 只列出调试端口上的页面目标 |

输出 JSON 顶层是 `{ tool, version, browser, protocol, target, elapsedMs, result }`，`result` 含：

- `composers` / `chatComposers`：`textarea`、`contenteditable`、`[role=textbox]`、文本类 `input` 候选
  （tag、class 前缀、aria-label、placeholder、data-testid、可见性+隐藏原因、rect、cssPath、父链、`closest(form)`）；
  `likelyAuthField` 标出登录/邮箱/手机号输入框，`chatComposers` 只留非登录输入框；
- `composerScopes` / `composerDetail`：输入框所属“输入区”祖先（优先 `closest(form)`，否则最近含 1..14 个按钮的祖先）
  及区内按钮清单，对应适配器的 `composerScope`；
- `buttons` / `sendButtonCandidates`：所有按钮的 aria-label / data-testid / 文本 / disabled / 是否在输入区内 /
  SVG `use` 图标 id / cssPath；候选按“在输入区内 + 发送信号条数”排序并排除 `stop`；
- `repeatedGroups` / `messageContainerCandidates`：同父下 >=3 个同构子节点的容器，按对话证据打分
  （绘制文本比例、可见比例、消息类属性个数、message/chat/turn 类名、是否同时含 user+assistant 角色、深度）；
- `messageListHints`：`role=log` / `data-message-list` / class 含 message-list|conversation|transcript|thread 的容器；
- `attributeInventory`：`data-testid`、`aria-label`、`placeholder`、`data-message-author-role` 等取值频次表；
- `framework`：是否 Next.js / App Router(RSC) / `__NEXT_DATA__` / react root、meta、脚本域名；
- `shadow`：逐层扫 open shadow root，给出宿主路径与 root 数；
- `iframes`：src / 可见性 / 是否同源 / 内部是否有输入框；
- `loginSignals`：password 输入框、登录/注册链接、`Continue with Google/Apple` 按钮、oauth 标记、dialog；
- `suggested`：由实测归纳的选择器建议（composer / composerScope / sendButton / messageList / messageRow）；
- `notes` / `warnings` / `counts`：结论性提示、风险提示与计数。

退出码：`0` 成功，`2` 传输/参数失败（中文错误 + “提示”给出下一步），探测函数内部异常同样走 `2` 并打印首行原因。

## 稳定性设计

- SPA 加载期重导航会销毁 execution context（实测首次连接即撞到 `Execution context was destroyed`）：
  传输层对 `Execution context was destroyed` / `Cannot find context` / `Inspected target navigated` 等做 4 次退避重试，
  求值前先轮询 `document.readyState`；
- 只按 `--url-prefix` 选标签页，不新开、不关闭、不激活页面；用完立刻关 socket；
- 探测函数整体 `toString()` 注入，页面内不能引用 Node 侧变量；正则字符类里的反斜杠转义改为字符码判断
  （`isIdentChar` / `flatten`），避免注入时被二次转义破坏。

## 真机实测结果（未登录，Chrome 155.0.8059.39 / Xvfb 1440x900）

完整输出见 `scripts/hark-probe-result.json`（两个页面各一次 run，数组已按信噪比截断）。
**没有尝试登录，也没有提交任何凭据。**

### 1) https://hark.com/ —— 营销入口页

- `title: Hark`，`lang: en`，`readyState: interactive`（carousel 持续播放，`complete` 迟迟不到，探针按当前 DOM 继续）；
- Next.js App Router/RSC，脚本域名 `hark.com` / `static.cloudflareinsights.com` / `www.googletagmanager.com`；
- 正文以 `Continue with Google` / `Continue with Apple` / `or` / `Continue` 开头，之后才是产品介绍；
- 可见输入框 2 个，均为登录邮箱框：`input[name=email][aria-label="Email address or phone number"]`
  （首屏 y=482 与下方 sign-up 区块 y=7515），**不是对话输入框**；
- 发送按钮候选 2 个，均为登录提交键 `button[type=submit]` 文案 `Continue`（首屏 disabled），**不是对话发送键**；
- 其余可见控件全是营销/页脚链接：`Learn more`、`Manifesto`、`Careers`、`Pricing`、`Get on App Store`、`Instagram`；
- 消息容器：`repeatedGroups` 11 组全是营销重复结构（`div.section-module-scss-module__Kf2ava__container` x11、
  carousel `...promptPosition` x10、页脚链接组），`messageListHints` 为空，`hasMessageAttributes` 全 false；
- iframe：1 个跨域 YouTube 播放器 + 1 个空 src 隐藏同源 iframe，输入区不在其中；
- shadow：1 个 open shadow root，宿主 `body > next-route-announcer`（Next.js 路由播报器），与输入区无关；
- Cloudflare（`server: cloudflare`、`cf-ray`）+ Vercel（`x-vercel-cache`、`x-nextjs-prerender`）。

### 2) https://app.hark.com/ —— 未登录 302 到 /login

- 最终 URL `https://app.hark.com/login`，`title: Hark — Sign in`；**不是 Next.js**（无 `/_next/`），React root + `assets.hark.com`；
- 类名哈希（`mr6c8q0`、`_10qhyq25`、`phwvnh8`），但这一层有稳定 data-testid（见下表）；
- 可见输入框 1、可见按钮 3，全部是认证元素，`chatComposers == 0`；
- 左栏是 `auth-side-image` + `campaign-videos`（4 个 `video[data-testid="campaign-video"]`），所以 `repeatedGroups` 只命中这一组；
- 正文含 `This wallpaper needs WebGL, which isn’t available in your browser.`——Xvfb 软件渲染既有现象，只影响背景动画；
- 无 password 输入框（当前是“先填手机号/邮箱再 Continue”入口步骤），无 dialog，无跨域 iframe 承载输入区，无 open shadow root。

### 登录入口（登录前已标定，可直接用）

| 用途 | 选择器 |
| --- | --- |
| 登录入口（Google）| `button[data-testid="google-sign-in"]` |
| 登录入口（Apple）| `button[data-testid="apple-sign-in"]` |
| 登录标识输入 | `input[data-testid="entry-input"]`（placeholder `Mobile number or email address`，autocomplete=username）|
| 登录提交 | `button[data-testid="entry-continue"]`（空值 disabled）|
| 是否在登录页 | 存在 `[data-testid="auth-page-shell"]` 或路径为 `/login` |

## 登录后必须补标的清单

登录前拿不到下面任何一项，**这 7 类必须用已登录标签页重跑探针**（`--url-prefix app.hark.com --settle 12000`），
对着 `chatComposers` / `sendButtonCandidates` / `repeatedGroups` / `attributeInventory` 四段填：

1. **对话 composer**：输入框本体（`textarea` / `contenteditable` / `[role=textbox]`）、它的 `data-testid`/aria-label/placeholder、
   以及 `composerScope`（是否 `closest('form')`、容器 `data-testid`）、`composerText` 的取文本方式；
2. **send 按钮**：发送键的 `aria-label` / `data-testid` / `type=submit` / SVG `use` 图标 id，`disabled` 语义，
   以及 `insertPrompt` 后按钮是否变可用；
3. **消息列表 / 消息行**：`turns(doc,'user')` 与 `turns(doc,'assistant')` 的选择器、稳定 id 属性
   （`data-message-id` / `data-turn` / 其他）、会话是否懒加载历史、新提问的乐观 id 是否被服务端 id 替换；
4. **完成标记 / 停止生成按钮**：流式中发送键如何变 stop（`aria-label`、`data-is-streaming` 之类），
   以及回答完成后出现的 copy / regenerate 按钮 aria-label（`completedMessage` 判定依据）；
5. **代码块**：`pre`/`code` 结构、语言标签位置、复制按钮、是否需要展开，决定 `markdownText` 实现；
6. **图片**：`img.src` 的 host（`assets.hark.com` 还是对象存储/CDN）、是否 `blob:`、尺寸与加载完成标志，
   决定 `readAnswerImage` 的来源白名单；同时补 `hasAttachments` / `attachInputImage` 需要的附件入口
   （`input[type=file]` 的 id 与 multiple、预览卡片选择器、移除按钮 aria-label）；
7. **流式结束判定**：`generating` 的完整信号（stop 按钮 + 任何 streaming 属性），以及
   `pageChallengeActive`（是否出现 Cloudflare challenge / 二次验证弹层）、会话 URL 形态（`/c/<id>`? `/chat/<id>`?）。

补齐后 `suggested` 段会直接给出候选选择器串，再据此写 `extension/hark-dom.js`。

## 复现与清理

实测用的 Chromium/Xvfb 由 PID 精确停止（`kill -TERM <pid>`，确认退出后再 `kill -KILL`；未用 `pkill`/`killall`），
结束后确认 9222 端口关闭、`/tmp/hark-profile` 已删除、无残留进程。
