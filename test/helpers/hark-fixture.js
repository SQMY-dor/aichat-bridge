// 合成 fixture：本文件不是线上页面快照，只用 data-testid 结构证明 hark-dom.js
// 的契约逻辑（就绪判定、提交确认、归属校验、完成判定、图片边界）。
// 真实 app.hark.com 登录后的 DOM 仍需用 scripts/hark-dom-probe.js 标定，
// 标定后把 extension/hark-dom.js 的 SELECTORS 换成实测值即可，本 fixture 同步更新。
import { JSDOM } from 'jsdom';

export const url = 'https://app.hark.com/chat/fixture-thread-0001';
export const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
export const payload = { mimeType: 'image/png', base64: png.toString('base64') };

export const composerHTML = `<div data-testid="composer"><div data-testid="composer-attachments"></div><div data-testid="composer-input" contenteditable="true" role="textbox"></div><button data-testid="composer-send" aria-label="发送"></button></div>`;

export function page(options = {}) {
  return new JSDOM(`<main><div data-testid="message-list"></div>${composerHTML}</main>`, { url, ...options });
}

export function signedOutPage(options = {}) {
  return new JSDOM('<main><div data-testid="auth-page-shell"><div data-testid="auth-card"><input data-testid="entry-input" type="text"></div></div></main>', { url: 'https://app.hark.com/login', ...options });
}

export function user(doc, prompt = 'Question', id = 'user-1') {
  doc.querySelector('[data-testid="message-list"]').insertAdjacentHTML('beforeend',
    `<div data-testid="message-user" data-message-id="${id}"><div data-testid="message-body"><p></p></div></div>`);
  const node = doc.querySelector('[data-message-id="' + id + '"]');
  node.querySelector('p').textContent = prompt;
  return node;
}

export function answer(doc, body = '<p>最终回复</p>', id = 'answer-1', { streaming = false } = {}) {
  doc.querySelector('[data-testid="message-list"]').insertAdjacentHTML('beforeend',
    `<div data-testid="message-assistant" data-message-id="${id}" data-state="${streaming ? 'streaming' : 'complete'}"><div data-testid="message-body">${body}</div>${streaming ? '' : '<div data-testid="message-actions"><button data-testid="message-copy" aria-label="Copy"></button></div>'}</div>`);
  return doc.querySelector('[data-message-id="' + id + '"]');
}

export function finish(doc, id = 'answer-1', body = '<p>最终回复</p>') {
  const node = doc.querySelector('[data-message-id="' + id + '"]');
  node.setAttribute('data-state', 'complete');
  node.querySelector('[data-testid="message-body"]').innerHTML = body;
  node.insertAdjacentHTML('beforeend', '<div data-testid="message-actions"><button data-testid="message-copy" aria-label="Copy"></button></div>');
  return node;
}

export function stopButton(doc) {
  const button = doc.createElement('button');
  button.dataset.testid = 'composer-stop';
  button.setAttribute('aria-label', 'Stop');
  doc.querySelector('[data-testid="composer"]').append(button);
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
