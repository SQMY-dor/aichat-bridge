// 合成 fixture，按 2026-10 在 app.hark.com/project/<id> 上实测到的真实结构写：
//
//   div[data-testid="message-list"]
//     div[data-message-id][data-entry-kind="message"]
//       div[data-testid="message-bubble"]
//         div._151xtfxf._151xtfxg   ← 用户
//         div._151xtfxf._151xtfxh   ← 助手
//           div[data-testid="message-text"]
//
// 用户与助手行本身同构，只有气泡内层类名不同，因此夹具必须保留这层。
// 输入框是 textarea[data-testid="chat-input"]；发送键只在有内容时出现，
// aria-label="Send message"（空输入框时 data-testid="send-button" 落在听写键上）。
import { JSDOM } from 'jsdom';

export const url = 'https://app.hark.com/project/fixture-project-0001';
export const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
export const payload = { mimeType: 'image/png', base64: png.toString('base64') };

export const USER_CLASS = '_151xtfxf _151xtfxg';
export const ASSISTANT_CLASS = '_151xtfxf _151xtfxh';

export const composerHTML = '<div data-testid="composer"><div data-testid="composer-attachments"></div>' +
  '<textarea data-testid="chat-input" aria-label="Message input" autocomplete="off"></textarea>' +
  '<button type="button" aria-label="Add attachment"></button>' +
  '<button type="button" data-testid="send-button" aria-label="Start dictation"></button>' +
  '</div>';

export function page(options = {}) {
  return new JSDOM('<main><div data-testid="message-list"></div>' + composerHTML + '</main>', { url, ...options });
}

export function signedOutPage(options = {}) {
  return new JSDOM('<main><div data-testid="auth-page-shell"><div data-testid="auth-card"><input data-testid="entry-input" type="text"></div></div></main>',
    { url: 'https://app.hark.com/login', ...options });
}

function row(doc, id, className, text) {
  const list = doc.querySelector('[data-testid="message-list"]');
  list.insertAdjacentHTML('beforeend',
    '<div data-message-id="' + id + '" data-entry-kind="message" data-transcript-row="">' +
    '<div><div data-testid="message-bubble">' +
    '<div class="' + className + '">' +
    '<div><div data-testid="message-text"></div></div>' +
    '</div></div></div></div>');
  const node = doc.querySelector('[data-message-id="' + id + '"]');
  // 真机上 message-text 直接持有文本（流式写入），不是包一层 <p>。
  node.querySelector('[data-testid="message-text"]').textContent = text;
  return node;
}

export function user(doc, prompt = 'Question', id = 'user-1') {
  return row(doc, id, USER_CLASS, prompt);
}

export function answer(doc, body = '最终回复', id = 'answer-1') {
  return row(doc, id, ASSISTANT_CLASS, body);
}

export function finish(doc, id = 'answer-1', body = '最终回复') {
  const node = doc.querySelector('[data-message-id="' + id + '"]');
  const text = node?.querySelector('[data-testid="message-text"]');
  if (!text) throw new Error('fixture: 找不到消息正文节点 ' + id);
  text.textContent = body;
  return node;
}

// Hark 只在有内容时出现发送键；这是适配器唯一认的发送控件。
export function sendButton(doc) {
  let button = doc.querySelector('button[aria-label="Send message"]');
  if (!button) {
    button = doc.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', 'Send message');
    doc.querySelector('[data-testid="composer"]').append(button);
  }
  return button;
}

export function stopButton(doc) {
  let button = doc.querySelector('button[aria-label="Stop"]');
  if (!button) {
    button = doc.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', 'Stop');
    doc.querySelector('[data-testid="composer"]').append(button);
  }
  return button;
}

export function loaded(image, values = {}) {
  Object.defineProperties(image, Object.fromEntries(Object.entries({ complete: true, naturalWidth: 640, naturalHeight: 480, ...values })
    .map(([key, value]) => [key, { value, configurable: true }])));
}

export function attachment(doc, name) {
  const card = doc.createElement('div');
  card.dataset.testid = 'composer-attachment';
  card.innerHTML = '<img><span></span>';
  const image = card.querySelector('img');
  image.alt = name;
  image.src = 'https://assets.hark.com/test/' + encodeURIComponent(name);
  loaded(image);
  card.querySelector('span').textContent = name;
  doc.querySelector('[data-testid="composer-attachments"]').append(card);
  return card;
}
