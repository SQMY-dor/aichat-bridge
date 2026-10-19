// A local simulated website + runtime around the real content script/adapters.
// No platform requests, logged-in sessions or real messages are used.
import fixtures from '/fixtures.js';
const provider = ({ 'chatgpt.com': 'chatgpt', 'claude.ai': 'claude', 'gemini.google.com': 'gemini', 'chat.qwen.ai': 'qwen' })[location.hostname];
const mode = new URL(location.href).searchParams.get('mode');
const lateQwen = provider === 'qwen' && ['late-hydrate', 'late-mismatch', 'late-id-change', 'late-row-replacement'].includes(mode);
const confirmedQwenIdChange = provider === 'qwen' && mode === 'confirmed-id-change';
document.body.innerHTML = fixtures[provider];
const dom = await import(`/extension/${provider === 'chatgpt' ? 'dom' : provider + '-dom'}.js`);
const input = dom.composer(document), button = dom.sendButton(document, input);
const prompt = lateQwen || ['hydrate', 'incomplete'].includes(mode) ? '123' : '第一行\nsecond line';
const messages = [];
let clicks = 0, polled = false, sentAt = null, lateMutationAt = null;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const paragraphs = (element, text) => element.replaceChildren(...text.split('\n').map(line => { const p = document.createElement('p'); p.textContent = line; return p; }));
const clone = selector => document.querySelector(selector).cloneNode(true);
const templates = provider === 'claude' ? [clone('[data-perf-row="user"]'), clone('[data-perf-row="assistant"]')] : provider === 'gemini' ? [clone('.conversation-container')] : [];
function mountTurn() {
  let userBody, complete;
  if (provider === 'qwen') {
    const row = document.createElement('div'); row.className = 'qwen-chat-message-select-turn';
    row.innerHTML = `<div class="qwen-chat-message-user"><div class="chat-user-message-container" data-msg-id="new-user" data-chat-id="fixture-conversation"><div class="chat-user-message"><div class="chunked-text-renderer-root"></div></div></div></div>`;
    document.querySelector('#chat-message-container').append(row);
    userBody = row.querySelector('.chunked-text-renderer-root');
    button.querySelector('use').setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#qwpcicon-stop');
    complete = () => {
      row.insertAdjacentHTML('beforeend', '<div class="qwen-chat-message-assistant"><div class="chat-response-message" id="chat-response-message-new-answer"><div class="response-message-content phase-answer"><div class="custom-qwen-markdown"><div class="qwen-markdown"><p>Audit answer</p></div></div></div><div class="response-message-footer"><div class="qwen-chat-package-comp-new-action-control" data-msg-id="new-answer" data-chat-id="fixture-conversation"><button class="qwen-chat-package-comp-new-action-control-container-copy">Copy</button><button class="qwen-chat-package-comp-new-action-control-container-regenerate">Retry</button></div></div></div></div>');
      button.querySelector('use').setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#qwpcicon-sendChat');
    };
  } else if (provider === 'claude') {
    const user = templates[0].cloneNode(true), answer = templates[1].cloneNode(true);
    user.dataset.messageId = 'new-user'; answer.dataset.messageId = 'new-answer';
    userBody = user.querySelector('[data-testid="user-message"]'); userBody.replaceChildren();
    answer.querySelector('[data-perf-reply-text]').innerHTML = '<p>Audit answer</p>';
    document.querySelector('main').append(user);
    complete = () => document.querySelector('main').append(answer);
  } else if (provider === 'gemini') {
    const row = templates[0].cloneNode(true), answer = row.querySelector('model-response');
    row.id = 'new-turn'; answer.remove();
    userBody = row.querySelector('.query-text'); userBody.replaceChildren();
    answer.querySelector('.markdown-main-panel').innerHTML = '<p>Audit answer</p>';
    document.querySelector('main').append(row); complete = () => row.append(answer);
  } else {
    const row = document.createElement('div'); row.dataset.turnKey = 'new-turn';
    row.innerHTML = '<div data-talvt-turn-state="streaming"><div data-chatgpt-search-unit-key="new:0:user" data-chatgpt-search-message-ids="new-user"><div data-content-search-unit-key="new:0:user"><div data-user-message-bubble="true"></div></div></div></div>';
    userBody = row.querySelector('[data-user-message-bubble]'); document.querySelector('main').append(row);
    complete = () => {
      const state = row.firstElementChild; state.dataset.talvtTurnState = 'complete';
      state.insertAdjacentHTML('beforeend', '<div data-chatgpt-search-unit-key="new:0:assistant" data-chatgpt-search-message-ids="new-answer"><div data-content-search-unit-key="new:0:assistant"><div data-chatgpt-selection-message-id="new-answer"><div data-markdown-text-style="assistant-message"><p>Audit answer</p></div></div></div></div><div class="turn-action-controls"><button aria-label="复制">Copy</button></div>');
    };
  }
  const text = mode === 'mismatch' ? 'Other question' : prompt;
  if (lateQwen) {
    setTimeout(() => paragraphs(userBody, '12'), 100);
    setTimeout(() => {
      lateMutationAt = performance.now();
      let currentBody = userBody;
      if (mode === 'late-row-replacement') {
        const row = userBody.closest('.qwen-chat-message-select-turn'), replacement = row.cloneNode(true);
        row.replaceWith(replacement); currentBody = replacement.querySelector('.chunked-text-renderer-root');
      }
      if (['late-id-change', 'late-mismatch', 'late-row-replacement'].includes(mode)) currentBody.closest('.chat-user-message-container').dataset.msgId = 'server-user-id';
      paragraphs(currentBody, mode === 'late-mismatch' ? 'Other question' : prompt);
    }, 26000);
  } else if (mode === 'incomplete') {
    if (provider === 'qwen') setTimeout(() => paragraphs(userBody, '12'), 100);
  } else if (mode === 'hydrate') {
    if (provider === 'qwen') { setTimeout(() => paragraphs(userBody, '1'), 50); setTimeout(() => paragraphs(userBody, '12'), 100); }
    setTimeout(() => paragraphs(userBody, text), 200);
  } else paragraphs(userBody, text);
  if (confirmedQwenIdChange) setTimeout(() => {
    lateMutationAt = performance.now();
    userBody.closest('.chat-user-message-container').dataset.msgId = 'server-confirmed-id';
  }, 800);
  setTimeout(complete, 400);
}
button.addEventListener('click', () => {
  try {
    clicks++;
    sentAt = performance.now();
    check(dom.composerText(input).replace(/\s+/g, ' ').trim() === prompt.replace(/\s+/g, ' '), 'submitted text differs from job');
    if (input.tagName === 'TEXTAREA') input.value = ''; else input.replaceChildren();
    mountTurn();
    if (mode === 'remount') input.replaceWith(input.cloneNode(true));
  } catch (error) { window.regressionResult = { provider, mode, error: error.stack }; }
});
window.chrome = { runtime: {
  id: 'browser-audit', getURL: name => '/extension/' + name, onMessage: { addListener() {} },
  async sendMessage(message) {
    messages.push(message);
    if (message.type === 'bridge:poll') {
      const job = polled ? null : { id: 'audit-job', assistant: provider, platform: mode === 'hydrate' ? 'feishu' : 'qq', prompt, conversationUrl: location.origin + location.pathname, timeoutMs: lateQwen ? 45000 : mode === 'incomplete' ? 2500 : 12000, images: [] };
      polled = true; return { ok: true, data: { job } };
    }
    if (message.type === 'bridge:result' || message.type === 'bridge:error') {
      setTimeout(() => {
        try {
          check(clicks === 1, 'must click exactly once');
          if (lateQwen) check(lateMutationAt !== null && lateMutationAt - sentAt >= 25000, 'pending Qwen turn must survive the old 20-second confirmation limit before reaching its late mutation');
          if (confirmedQwenIdChange) check(lateMutationAt !== null, 'confirmed Qwen identity must be promoted before forwarding');
          const results = messages.filter(m => m.type === 'bridge:result'), errors = messages.filter(m => m.type === 'bridge:error');
          if (['mismatch', 'incomplete', 'late-mismatch', 'late-row-replacement'].includes(mode)) check(results.length === 0 && errors.length === 1, 'unconfirmed prompt must never be forwarded');
          else check(errors.length === 0 && results.length === 1 && results[0].text === 'Audit answer', 'expected one complete result: ' + (errors[0]?.error || JSON.stringify(results)));
          window.regressionResult = { provider, mode, clicks, results: results.length, errors: errors.length, ...(lateQwen ? { elapsedMs: Math.round(performance.now() - sentAt) } : {}) };
        } catch (error) { window.regressionResult = { provider, mode, error: error.stack }; }
      }, 50);
    }
    return { ok: true, data: {} };
  }
} };
await import('/extension/content.js');
