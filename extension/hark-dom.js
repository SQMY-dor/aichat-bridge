import { normalizeText, conversationUrl } from './shared.js';
import {
  PageSafetyError, visible, composerText, markdownText as sharedMarkdown,
  validateInputImages, decodeImagePayload, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES,
} from './dom.js';
export { PageSafetyError, visible, composerText, validateInputImages, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES };

// Hark Pro 网页端（https://app.hark.com）适配器。
//
// 已核实的事实（2026-10，见 docs/hark-integration.md 与 scripts/hark-probe-result.json）：
//   * 营销站 hark.com 是 Next.js App Router；产品应用在 app.hark.com，未登录时
//     除 /login 外所有路由都返回 401，客户端 302 到 /login。
//   * 两个站点都用 CSS Modules 哈希类名（biwpmn0 / _10qhyq2a / 模块前缀），
//     每次发布都会变 —— 因此本适配器绝不按类名选择，只认 data-testid、
//     结构关系与稳定文本。
//   * 登录页的稳定钩子：auth-page-shell / auth-card / entry-input /
//     entry-continue / google-sign-in / apple-sign-in。
//   * 登录后的对话页 DOM 尚未标定：它只在会话内存在。因此 SELECTORS 是一张
//     唯一的、可替换的选择器登记表，每个查询失败都带着"缺哪个钩子"的中文错误
//     停下，绝不猜着点按钮。scripts/hark-dom-probe.js 是标定工具，
//     test/extension-hark-dom.test.js + test/helpers/hark-fixture.js 用合成 DOM
//     证明本适配器的契约逻辑正确（与线上结构无关）。
//
// 标定流程：登录后跑探针 → 把得到的 data-testid 填进 SELECTORS →
// 再跑 npm run check / npm test。在 SELECTORS 仍是"未标定"状态时，
// content.js 只会在 assertReady/composer 阶段抛错，不会提交任何提问。
export const SELECTORS = {
  // 登录态判定。出现即视为不可用。
  signedOut: '[data-testid="auth-card"], [data-testid="auth-page-shell"], [data-testid="entry-input"]',
  // 对话页（2026-10 在 app.hark.com/project/<id> 与 /chat 上实测）。
  // 输入区是一个 textarea，带稳定 data-testid="chat-input"。
  composer: '[data-testid="chat-input"]',
  // 发送控件只在输入框有内容时挂载，且它的 data-testid 是 "send-button"，
  // 但空输入框时这个 testid 落在听写按钮上（aria-label="Start dictation"）。
  // 所以绝不按 testid 点，只认 aria-label="Send message"，见 sendButton()。
  send: 'button[aria-label="Send message"]',
  stop: 'button[aria-label="Stop"], button[aria-label="Stop generating"], button[aria-label="Stop response"]',
  // 消息行：div[data-message-id][data-entry-kind="message"]，用户与助手同构，
  // 唯一差别是消息气泡内层的哈希类名（见 ROLE_CLASSES）。
  row: '[data-testid="message-list"] div[data-message-id][data-entry-kind="message"]',
  bubble: '[data-testid="message-bubble"]',
  answerBody: '[data-testid="message-text"]',
  // 助手消息的操作栏（复制/重新生成）只在悬停或完成后出现，作为完成标记不可靠；
  // 完成判定改用"本轮流式结束"，见 finalCandidate()。
  completion: '[data-testid="message-actions"]',
  attachment: '[data-testid="composer-attachment"]',
};

// Hark 用 CSS Modules，类名带构建哈希（如 _151xtfxg）。但气泡内层这一对
// 是当前唯一能区分两侧的标记，实测稳定：g = 用户，h = 助手。
// 标定失效时 composer/findSubmittedUser 会停下，不会误判方向。
// 兜底：若类名不再匹配，用"该行是否出现在最后一条已知用户消息之后"结合
// data-message-id 顺序推断，见 roleOf()。
export const ROLE_CLASSES = Object.freeze({
  user: '_151xtfxg',
  assistant: '_151xtfxh',
});

// 仅供标定与离线冒烟测试使用：整体替换登记表，先做完整校验再落地，
// 避免半张表被写进运行中的页面。
export function applyCalibration(next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) throw new PageSafetyError('Hark 选择器登记表无效');
  const merged = { ...SELECTORS };
  for (const [key, value] of Object.entries(next)) {
    if (!Object.hasOwn(SELECTORS, key)) throw new PageSafetyError('未知的 Hark 选择器键：' + key);
    if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new PageSafetyError('Hark 选择器 ' + key + ' 无效');
    merged[key] = value;
  }
  Object.assign(SELECTORS, merged);
  calibrated = true;
  return { ...SELECTORS };
}

const uploads = new WeakMap();
const enabled = node => visible(node) && !node.disabled && !node.matches(':disabled') &&
  node.getAttribute('aria-disabled') !== 'true' && !node.closest('[inert], [aria-disabled="true"]');
// 找不到元素有两种含义，必须分开说：还没标定（选择器是占位值）与
// 已标定但当前页面没有（切了视图、还在加载、登录页）。混为一谈会让用户
// 白跑一遍标定流程。
// 显式标记：SELECTORS 一旦被 applyCalibration 改过，就说明是标定过的表。
// 不靠"是否包含占位字符串"猜测，那种判断在测试里替换选择器时会误判。
let calibrated = true;
const miss = what => new PageSafetyError(calibrated
  ? 'Hark 页面上暂时找不到' + what + '：请确认已登录、并打开了对话或项目页（项目页要等消息列表渲染完）'
  : 'Hark 对话页结构尚未标定：找不到' + what +
    '。请先登录后在网页运行 scripts/hark-dom-probe.js，按输出的 data-testid 更新 extension/hark-dom.js 的 SELECTORS');

export function signedOut(doc) { return [...doc.querySelectorAll(SELECTORS.signedOut)].some(visible); }
export function assertSignedIn(doc) {
  if (signedOut(doc)) throw new PageSafetyError('Hark 尚未登录：请先在绑定的网页完成登录，再让机器人继续');
}
export function pageChallengeActive(doc) {
  return [...doc.querySelectorAll('#challenge-running, #challenge-stage, iframe[src*="challenges.cloudflare.com"]')].some(visible);
}
function assertNoOverlay(doc) {
  assertSignedIn(doc);
  if (pageChallengeActive(doc)) throw new PageSafetyError('Hark 网页正在验证，请先手动完成验证');
  if ([...doc.querySelectorAll('[role="dialog"][aria-modal="true"]')].some(visible)) throw new PageSafetyError('Hark 有待处理的对话框，请先在网页处理');
}
// Hark 的输入区没有稳定的容器 testid，用最近的 form 或 textarea 的
// 三段祖先兜底；只用于「判断点击是否落在输入区」与附件校验。
export function composerScope(input) {
  if (!input) return null;
  return input.closest('form') || input.parentElement?.parentElement?.parentElement || null;
}

// 判定一行的角色。Hark 里有三种行：
//   普通气泡（有 message-bubble，内层哈希类名区分两侧）
//   富内容卡（summary-card 等，没有气泡，实际是助手的长回复折叠形式）
//   其它条目
// 因此不能只靠类名。这里三层判据，任何一层确定就直接返回：
//   1) 气泡内层类名（最准，实测 g=用户 h=助手）
//   2) 行内出现 summary-card / summary-preview 等富内容 → 助手
//   3) 文档顺序交替：Hark 的对话严格 user/assistant 交替，用于兜底
// 仍不确定就抛错，绝不猜方向。
const RICH_ASSISTANT = '[data-testid="summary-card"], [data-testid="summary-preview"], [data-testid="rich-content-links"]';

export function roleOf(row) {
  const bubble = row.querySelector(SELECTORS.bubble);
  const inner = bubble?.firstElementChild;
  const cls = inner ? String(inner.className || '') : '';
  if (cls.includes(ROLE_CLASSES.user)) return 'user';
  if (cls.includes(ROLE_CLASSES.assistant)) return 'assistant';
  // 富内容卡：Hark 把助手的长回复渲染成 summary-card，没有气泡。
  if (row.querySelector(RICH_ASSISTANT)) return 'assistant';
  throw new PageSafetyError('Hark 消息角色无法判定：气泡类名与富内容结构都不匹配。请运行 scripts/hark-dom-probe.js 重新标定 ROLE_CLASSES');
}

// 逐行判定，遇到判不了的行时用交替序列兜底：Hark 的对话是 user→assistant 交替，
// 且文档第一行一定是用户。只在该行本身没有任何角色信号时才用。
function roleSequence(doc) {
  const list = rows(doc);
  const roles = [];
  for (const [index, row] of list.entries()) {
    let role;
    try { role = roleOf(row); }
    catch {
      // 兜底：按已知的交替规律推断。前面没有已知行时，首行视为用户。
      const previous = roles.at(-1);
      role = previous === 'user' ? 'assistant' : previous === 'assistant' ? 'user' : 'user';
    }
    roles.push(role);
  }
  return list.map((row, index) => ({ row, role: roles[index], index }));
}
export function composer(doc) {
  assertNoOverlay(doc);
  const inputs = [...doc.querySelectorAll(SELECTORS.composer)].filter(visible);
  if (!inputs.length) throw miss(' Hark 对话输入框');
  if (inputs.length > 1) throw new PageSafetyError('检测到多个可见的 Hark 输入框，暂不自动操作');
  const input = inputs[0];
  if (input.tagName !== 'TEXTAREA' && input.getAttribute('contenteditable') !== 'true') throw new PageSafetyError('Hark 输入框结构已变化，已停止自动操作');
  if (!enabled(input) || input.readOnly) throw new PageSafetyError('Hark 输入框当前不可用');
  return input;
}
export function composerInteraction(target, input) {
  return Boolean(target?.closest && (target.closest(SELECTORS.composer) || (input && composerScope(input)?.contains(target)) || target.closest(SELECTORS.send)));
}
export function generating(doc) {
  // Hark 生成中会在输入区显示停止控件；这是唯一可靠的"正在写"信号。
  if ([...doc.querySelectorAll(SELECTORS.stop)].some(visible)) return true;
  return false;
}
export function hasAttachments(input) {
  const scope = composerScope(input); if (!scope) return true;
  if ([...scope.querySelectorAll('input[type="file"]')].some(field => field.files?.length)) return true;
  // 输入区里本来就有「Add attachment」按钮，不能把它当附件；只认真正的预览与进度。
  return [...scope.querySelectorAll(SELECTORS.attachment + ', [role="progressbar"], [aria-busy="true"]')].some(visible);
}
// 行本身同构，角色由 roleOf() 判定。按文档顺序返回，保持对话顺序。
export function rows(doc) {
  return [...doc.querySelectorAll(SELECTORS.row)].sort((a, b) => a.compareDocumentPosition(b) & 4 ? -1 : 1);
}
export function turns(doc, role) {
  if (role !== 'user' && role !== 'assistant') throw new PageSafetyError('Hark 消息角色无效');
  return roleSequence(doc).filter(entry => entry.role === role).map(entry => entry.row);
}
function stableKey(node) { return node.getAttribute('data-message-id') || node.getAttribute('data-id') || null; }
function turnText(node) {
  const bodies = [...node.querySelectorAll(SELECTORS.answerBody)].filter(visible);
  if (bodies.length === 1) return normalizeText(composerText(bodies[0].cloneNode(true)));
  // 富内容卡（summary-card 等）没有 message-text，读卡片可见文本；
  // 但用户提问一定在 message-text 里，这里的兜底只服务助手长回复。
  const rich = [...node.querySelectorAll('[data-testid="summary-preview"]')].filter(visible);
  if (rich.length === 1) return normalizeText(composerText(rich[0].cloneNode(true)));
  return normalizeText(composerText(node.cloneNode(true)));
}
// 没有稳定 id 时退回"文档顺序 + 角色"，只用于同一轮快照内的相对比较，
// 绝不跨轮当作已确认身份使用。
function keys(list) { return list.map((node, index) => stableKey(node) || 'index:' + index); }
export function snapshot(doc) {
  const users = turns(doc, 'user');
  const userKeys = keys(users);
  return {
    users: new Set(userKeys),
    lastUserKey: userKeys.length ? userKeys.at(-1) : null,
    assistants: new Set(keys(turns(doc, 'assistant'))),
    imageSources: new Set([...doc.querySelectorAll('img')].map(image => image.currentSrc || image.src).filter(Boolean)),
    userKeys,
  };
}
export function newUsers(doc, baseline) {
  const users = turns(doc, 'user');
  const current = keys(users);
  if (!baseline.users.size) return users.filter((node, index) => !baseline.users.has(current[index]));
  const anchor = baseline.userKeys ? baseline.userKeys.indexOf(baseline.lastUserKey) : current.indexOf(baseline.lastUserKey);
  if (anchor < 0) throw new PageSafetyError('原有 Hark 用户消息基准已消失，无法确认新消息范围，已停止转发');
  return users.slice(anchor + 1).filter((node, index) => !baseline.users.has(current[anchor + 1 + index]));
}
function submissionState(doc, baseline, prompt) {
  const users = newUsers(doc, baseline);
  if (users.length > 1) throw new PageSafetyError('检测到其他新消息，已停止转发，避免混淆回复');
  if (!users.length) return null;
  const actual = turnText(users[0]);
  const expected = normalizeText(prompt);
  if (actual !== expected && !expected.startsWith(actual)) throw new PageSafetyError('新增网页消息与本次群消息不同，已停止转发');
  return { user: users[0], expected, pending: actual !== expected };
}
export function findSubmittedUser(doc, baseline, prompt) {
  const state = submissionState(doc, baseline, prompt);
  if (!state || state.pending) return null;
  baseline.submittedText = state.expected;
  return state.user;
}
export function submittedUserPending(doc, baseline, prompt) {
  // 只说明"本轮消息已出现、正文还没挂全"。content.js 仍按原任务时限等待，
  // 该判断绝不确认提问，也绝不授权答案。
  return submissionState(doc, baseline, prompt)?.pending === true;
}
export function submissionWaitReason(doc, baseline, prompt) {
  const users = newUsers(doc, baseline);
  if (!users.length) return 'Hark 尚未出现可识别的新提问';
  if (users.length !== 1) return 'Hark 出现多个新提问';
  return `Hark 提问正文尚未完整（已识别 ${turnText(users[0]).length}/${normalizeText(prompt).length} 字符）`;
}
export function assertReady(doc) {
  assertNoOverlay(doc);
  if (generating(doc)) throw new PageSafetyError('该对话正在生成回复，请等待完成');
  const lastUser = turns(doc, 'user').at(-1), lastAnswer = turns(doc, 'assistant').at(-1);
  if (lastUser && (!lastAnswer || !(lastUser.compareDocumentPosition(lastAnswer) & 4))) throw new PageSafetyError('上一条 Hark 网页提问尚未明确完成，请先在网页处理');
  const input = composer(doc);
  if (hasAttachments(input)) throw new PageSafetyError('输入区存在附件或正在上传，本次不会发送');
  if (normalizeText(composerText(input))) throw new PageSafetyError('输入框有草稿，本次不会覆盖草稿');
  return input;
}
// 只在出现「Send message」时返回，绝不退回按 data-testid="send-button" 点，
// 因为空输入框时那个 testid 落在听写按钮上。
export function sendButton(doc, input) {
  if (composer(doc) !== input) throw new PageSafetyError('Hark 输入框已被替换，已停止发送');
  const buttons = [...doc.querySelectorAll(SELECTORS.send)].filter(visible);
  // 有内容时才应出现；多于一个说明结构变了，宁可不发。
  if (buttons.length !== 1) return null;
  return enabled(buttons[0]) ? buttons[0] : null;
}
export function insertPrompt(doc, input, prompt) {
  if (!input.isConnected || !enabled(input) || input.readOnly) throw new PageSafetyError('网页输入框当前不可用，已停止写入');
  if (normalizeText(composerText(input))) throw new PageSafetyError('检测到新草稿，已停止写入');
  input.focus();
  if (input.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(doc.defaultView.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, prompt);
    input.dispatchEvent(new doc.defaultView.InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  } else {
    const range = doc.createRange(); range.selectNodeContents(input);
    const selection = doc.defaultView.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    let emitted = false; const observe = () => { emitted = true; };
    input.addEventListener('input', observe, true);
    try {
      if (typeof doc.execCommand !== 'function' || !doc.execCommand('insertText', false, prompt)) throw new PageSafetyError('浏览器未接受正常文本输入，已停止发送');
    } finally { input.removeEventListener('input', observe, true); }
    if (!emitted) input.dispatchEvent(new doc.defaultView.InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  }
  if (normalizeText(composerText(input)) !== normalizeText(prompt)) throw new PageSafetyError('网页输入内容与任务不同，已停止发送');
}
// 共享的 dom.js paste 会重新用 ChatGPT 的输入框选择器自检，这里按 Hark 的
// 输入框重新校验，其余字节校验仍复用 decodeImagePayload。
export function pasteInputImage(doc, input, { mimeType, base64 }, name) {
  if (composer(doc) !== input || typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,150}$/.test(name)) throw new PageSafetyError('无法确认 Hark 图片输入目标');
  const bytes = decodeImagePayload(mimeType, base64);
  const win = doc.defaultView;
  if (typeof win.DataTransfer !== 'function' || typeof win.ClipboardEvent !== 'function') throw new PageSafetyError('当前浏览器不支持正常图片粘贴，已停止发送');
  const transfer = new win.DataTransfer();
  transfer.items.add(new win.File([bytes], name, { type: mimeType }));
  input.focus();
  input.dispatchEvent(new win.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  const records = uploads.get(input) || []; records.push(name); uploads.set(input, records);
}
export function releaseInputImages(input) { uploads.delete(input); }
export function inputAttachmentState(input, names) {
  const scope = composerScope(input);
  if (!scope || new Set(names).size !== names.length) throw new PageSafetyError('无法确认本次 Hark 图片附件');
  if (!names.length) return { ready: !hasAttachments(input) };
  if ([...scope.querySelectorAll('[role="alert"]')].some(visible)) throw new PageSafetyError('Hark 报告图片上传失败，已停止发送');
  if ([...scope.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(visible)) return { ready: false, reason: 'uploading' };
  const attachments = [...scope.querySelectorAll(SELECTORS.attachment)].filter(visible);
  if (!attachments.length) return { ready: false, reason: 'no-attachment' };
  if (attachments.length !== names.length) return { ready: false, reason: 'name-mismatch' };
  const named = node => new Set([node, ...node.querySelectorAll('*')].filter(visible).flatMap(element => names.filter(name =>
    ['alt', 'title', 'aria-label'].some(attribute => element.getAttribute(attribute) === name) ||
    (!element.childElementCount && normalizeText(element.textContent) === name))));
  const matched = new Set();
  for (const name of names) {
    const found = attachments.filter(node => named(node).has(name));
    if (found.length !== 1 || matched.has(found[0])) return { ready: false, reason: 'name-mismatch' };
    matched.add(found[0]);
  }
  return { ready: matched.size === names.length };
}
export function markdownText(body) { return sharedMarkdown(body); }
export function answerImageSource(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'blob:' && url.origin === 'https://app.hark.com') return url.href;
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password &&
      (url.hostname === 'app.hark.com' || url.hostname === 'assets.hark.com')) return url.href;
  } catch {}
  throw new PageSafetyError('本次 Hark 回复图片的来源不受支持，未读取或转发图片');
}
export function finalCandidate(doc, baseline, previousUser) {
  if (baseline.submittedText === undefined) throw new PageSafetyError('对话出现其他消息或内容被替换，停止转发');
  // 归属校验：本轮只允许存在唯一的新提问，其他新消息一律停止，
  // 避免把别人的追问当成本次任务的答案。
  const pending = newUsers(doc, baseline);
  if (pending.length > 1) throw new PageSafetyError('检测到其他新消息，已停止转发，避免混淆回复');
  const current = turns(doc, 'user').at(-1);
  if (!current) throw new PageSafetyError('本轮 Hark 提问已消失，已停止转发');
  if (turnText(current) !== baseline.submittedText) throw new PageSafetyError('已确认的网页消息内容被替换，已停止转发');
  if (generating(doc)) return null;
  const answers = turns(doc, 'assistant');
  const answerKeys = keys(answers);
  const following = answers.filter((node, index) => !baseline.assistants.has(answerKeys[index]) && (current.compareDocumentPosition(node) & 4));
  if ([...doc.querySelectorAll('[role="alert"]')].filter(visible).some(node => current.compareDocumentPosition(node) & 4)) {
    throw new PageSafetyError('Hark 网页回复失败，请在网页处理；本次不会重新提问');
  }
  if (following.length !== 1) return null;
  const message = following[0];
  // Hark 的助手操作栏只在悬停时出现，不能拿来当完成标记。
  // 完成判据：不在生成中（无停止控件）、正文非空、且正文在两次轮询间保持不变
  // ——稳定性由 content.js 的指纹机制保证，这里只要求有正文。
  // 长回复会被折叠成 summary-card，这时 message-text 不存在，改用摘要卡文本。
  let bodies = [...message.querySelectorAll(SELECTORS.answerBody)].filter(node => visible(node) && !node.parentElement?.closest(SELECTORS.answerBody));
  if (bodies.length > 1) return null;
  if (!bodies.length) {
    const card = [...message.querySelectorAll('[data-testid="summary-preview"], [data-testid="summary-card"]')].filter(visible);
    if (card.length) bodies = [card[0]];
  }
  const images = []; const seen = new Set();
  for (const image of message.querySelectorAll('img')) {
    if (!visible(image)) continue;
    const source = image.currentSrc || image.src;
    if (seen.has(source) || baseline.imageSources.has(source)) continue;
    seen.add(source);
    let src; try { src = answerImageSource(source); } catch { continue; }
    if (!image.complete) return null;
    if (!image.naturalWidth || !image.naturalHeight) throw new PageSafetyError('Hark 回复图片尚未正常加载');
    images.push({ src, width: image.naturalWidth, height: image.naturalHeight });
    if (images.length > MAX_IMAGES) throw new PageSafetyError('本次回复超过 4 张图片，请在网页查看完整结果');
  }
  const text = bodies.length ? markdownText(bodies[0]) : '';
  return text || images.length ? { message, text, images } : null;
}
// 共享的 readAnswerImage 绑定 ChatGPT 的图片域名，这里用 Hark 的来源白名单。
export async function readAnswerImage(image, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const source = answerImageSource(image.src);
  const controller = new AbortController();
  let reader; let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reader?.cancel().catch(() => {});
      reject(new PageSafetyError('读取本次 Hark 回复图片超时，请在网页查看'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(source, { signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
      if (!response.ok || !response.body?.getReader) throw new PageSafetyError('无法读取本次 Hark 回复图片，请在网页确认图片可以打开');
      reader = response.body.getReader();
      const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_IMAGE_BYTES) throw new PageSafetyError('单张图片超过 10 MB，请在网页查看原图');
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let binary = '';
      for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
      const base64 = btoa(binary);
      decodeImagePayload(mimeTypeOf(response), base64);
      return { mimeType: mimeTypeOf(response), base64, byteLength: bytes.length };
    })()]);
  } catch (error) {
    if (error instanceof PageSafetyError) throw error;
    throw new PageSafetyError('无法读取本次 Hark 回复图片，可能是图片访问受限或连接中断；未转发空图片');
  } finally { clearTimeout(timer); controller.abort(); reader?.cancel().catch(() => {}); }
}
function mimeTypeOf(response) {
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new PageSafetyError('图片格式不支持，仅支持 PNG、JPEG 和 WebP');
  return type;
}
export function refreshComposer(doc, input) {
  if (input.isConnected) return input;
  // 只有同一输入区的布局替换可以继承附件账本；绝不接管任意新编辑器。
  const records = uploads.get(input);
  try {
    const current = composer(doc);
    if (normalizeText(composerText(current))) return input;
    if (records) { uploads.set(current, records); uploads.delete(input); }
    return current;
  } catch { return input; }
}
export function threadUrl(value) { return conversationUrl(value, 'hark'); }
