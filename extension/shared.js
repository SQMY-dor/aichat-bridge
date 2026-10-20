export const ASSISTANTS = Object.freeze(['chatgpt', 'claude', 'gemini', 'qwen', 'hark']);
export const ASSISTANT_NAMES = Object.freeze({ chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', qwen: 'Qwen', hark: 'Hark' });
export const ASSISTANT_ORIGINS = Object.freeze({ chatgpt: 'https://chatgpt.com', claude: 'https://claude.ai', gemini: 'https://gemini.google.com', qwen: 'https://chat.qwen.ai', hark: 'https://app.hark.com' });
// app.hark.com 的会话路由取自登录页加载的前端 bundle（路由表里含
// /chat/:messageId、/project/:projectId/:messageId、/room/:roomId），未登录时
// 服务端对这些路径一律 401 并跳到 /login?redirectTo=…。能被绑定的只有带消息
// 标识的会话页；入口页、登录页与设置页都在下面的保留名单里，绑定会被明确拒绝。
export const HARK_RESERVED_PATHS = Object.freeze([
  '/', '/login', '/waitlist', '/set-password', '/enroll-2fa', '/verify-age', '/verify-card', '/verify-email',
  '/accept-invite', '/slack-install', '/preview/billing-notice', '/chat', '/projects', '/projects/new',
  '/rooms', '/settings', '/settings/profile', '/settings/security', '/settings/billing', '/plans',
  '/profile', '/soul', '/connect', '/docs/realtime',
]);
export function assistantId(value) {
  if (!ASSISTANTS.includes(value)) throw Object.assign(new Error('请选择 ChatGPT、Claude、Gemini、Qwen 或 Hark 助手'), { status: 400 });
  return value;
}
export function assistantForUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    return ASSISTANTS.find(id => url.origin === ASSISTANT_ORIGINS[id]) ?? null;
  } catch { return null; }
}
export function conversationUrl(value, assistant = 'chatgpt') {
  try {
    const url = new URL(value);
    if (assistantForUrl(value) !== assistantId(assistant)) return null;
    const path = url.pathname.replace(/\/+$/, '');
    const pattern = assistant === 'hark' ? /^\/(?:chat\/[A-Za-z0-9_-]{6,}|project\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{6,}|room\/[A-Za-z0-9_-]{6,})$/
      : assistant === 'qwen' ? /^\/c\/[A-Za-z0-9_-]{8,}$/
      : assistant === 'gemini' ? /^\/(?:u\/\d+\/)?app\/[A-Za-z0-9_-]{8,}$/
      : assistant === 'claude' ? /^\/chat\/[A-Za-z0-9_-]{8,}$/ : /^\/(?:[^/]+\/)*c\/[A-Za-z0-9_-]{8,}$/;
    if (!pattern.test(path)) return null;
    if (assistant === 'hark' && HARK_RESERVED_PATHS.includes(path.toLowerCase())) return null;
    return url.origin + path;
  } catch { return null; }
}
export function normalizeText(value) { return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(); }
export function safeError(error) {
  const text = String(error?.message || error || '未知错误');
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').slice(0, 240);
}
export function isOptionsSender(sender, runtimeId, optionsUrl) {
  return sender.id === runtimeId && sender.url === optionsUrl;
}
export function validSession(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{12,100}$/.test(value); }

export function validChallengeCheckpoint(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.userKey === 'string' && value.userKey.startsWith('message:') && value.userKey.length > 8 && value.userKey.length <= 2048 &&
    typeof value.prompt === 'string' && Boolean(value.prompt.trim()) && value.prompt.length <= 12000 && value.prompt === normalizeText(value.prompt) &&
    Array.isArray(value.imageSources) && value.imageSources.length <= 2000 &&
    value.imageSources.every(source => typeof source === 'string' && source.length <= 8192) && JSON.stringify(value).length <= 150000;
}

// Call only for trusted events inside the composer. Focus/selection and OS
// shortcuts are not edits. Actual input/paste remains authoritative, including
// IME, dictation and clipboard shortcuts whose key names vary by platform.
export function interruptsComposer(event, submissionClicked = false) {
  if (['beforeinput', 'input', 'paste'].includes(event.type)) return true;
  if (event.type === 'pointerdown') return !submissionClicked;
  if (event.type !== 'keydown') return false;
  if (['Enter', 'Backspace', 'Delete'].includes(event.key) || event.isComposing) return true;
  return typeof event.key === 'string' && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
}

// Diagnostics are optional and never alter authorization, deadlines or answer
// contents. Copy only bounded durations; never retain arbitrary page fields.
export function resultTiming(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (!['confirmationMs', 'imagePreparationMs'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 300000) || typeof value.background !== 'boolean') return undefined;
  return { confirmationMs: value.confirmationMs, imagePreparationMs: value.imagePreparationMs, background: value.background,
    ...(Number.isSafeInteger(value.inputPreparationMs) && value.inputPreparationMs >= 0 && value.inputPreparationMs <= 600000 ? { inputPreparationMs: value.inputPreparationMs } : {}),
  };
}

// Local troubleshooting only: no URLs, message text, tokens or arbitrary keys.
export function pageDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const durations = ['pageAgeMs', 'bridgeIdleMs'];
  if (!durations.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 2592000000) ||
    !['visible', 'hidden'].includes(value.visibility) || !['prepare', 'idle-refresh', 'submit', 'answer', 'challenge-recovery', 'delivery'].includes(value.phase)) return undefined;
  return { pageAgeMs: value.pageAgeMs, bridgeIdleMs: value.bridgeIdleMs, visibility: value.visibility, phase: value.phase };
}
