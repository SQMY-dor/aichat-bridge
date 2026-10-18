import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as dom from '../extension/dom.js';
import * as shared from '../extension/shared.js';

const url = 'https://chatgpt.com/c/qq-completion-fixture';
const source = (await readFile(new URL('../extension/content.js', import.meta.url), 'utf8'))
  .replace("await import(chrome.runtime.getURL('dom.js'))", 'globalThis.__testDom')
  .replace("await import(chrome.runtime.getURL('shared.js'))", 'globalThis.__testShared');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); };

async function fixture({ state = 'complete', controls = true, imageCount = 0, imagesLoaded = true, readDelay = 0, failImage = -1 } = {}) {
  const page = new JSDOM('<main></main><div data-composer-body><textarea id="prompt-textarea"></textarea><button type="submit" aria-label="发送"></button></div>', { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = page.window, doc = win.document;
  const timers = new Map(), observers = new Set(), messages = [], reads = [];
  let now = 1000, serial = 0, clicks = 0, candidateCalls = 0, hidden = false, timerClamp = 0;
  const imageStates = Array.from({ length: imageCount }, () => ({ loaded: imagesLoaded, width: 512, height: 512 }));
  Object.defineProperty(doc, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' });
  win.Date = class extends Date { static now() { return now; } };
  win.setTimeout = (fn, ms) => { const id = ++serial; timers.set(id, { fn, at: now + Math.max(Number(ms), Number(ms) <= 250 ? timerClamp : 0) }); return id; };
  win.clearTimeout = id => timers.delete(id);
  win.setInterval = () => 0;
  const NativeObserver = win.MutationObserver;
  win.MutationObserver = class {
    constructor(callback) { this.inner = new NativeObserver(callback); }
    observe(...args) { observers.add(this); this.inner.observe(...args); }
    disconnect() { observers.delete(this); this.inner.disconnect(); }
  };
  win.__testShared = shared;
  win.__testDom = { ...dom,
    finalCandidate(...args) { candidateCalls++; return dom.finalCandidate(...args); },
    async readAnswerImage(image) {
      const index = Number(image.src.match(/file-completion-(\d+)/)[1]); reads.push(index);
      if (readDelay) await new Promise(resolve => win.setTimeout(resolve, readDelay));
      if (index === failImage) throw new Error('Fixture image read failed');
      return { mimeType: 'image/png', base64: 'fixture-image-' + index, byteLength: 16 };
    }
  };
  doc.querySelector('button').addEventListener('click', () => {
    clicks++;
    assert.equal(doc.querySelector('textarea').value, 'Question');
    doc.querySelector('textarea').value = '';
    const images = Array.from({ length: imageCount }, (_, index) => `<img src="https://chatgpt.com/backend-api/estuary/content?id=file-completion-${index}">`).join('');
    doc.querySelector('main').innerHTML = `<div data-turn-key="new"><div data-talvt-turn-state="${state}"><div data-chatgpt-search-unit-key="new:0:user" data-chatgpt-search-message-ids="new-user"><div data-user-message-bubble="true">Question</div></div><div data-chatgpt-search-unit-key="new:1:assistant" data-chatgpt-search-message-ids="new-assistant"><div data-markdown-text-style="assistant-message"><p>Final answer</p>${images}</div></div>${controls ? '<div class="turn-action-controls"><button aria-label="复制">Copy</button></div>' : ''}</div></div>`;
    [...doc.querySelectorAll('main img')].forEach((image, index) => Object.defineProperties(image, {
      complete: { get: () => imageStates[index].loaded }, naturalWidth: { get: () => imageStates[index].width }, naturalHeight: { get: () => imageStates[index].height }
    }));
  });
  win.chrome = { runtime: { id: 'completion-fixture', getURL: path => path, onMessage: { addListener() {} }, async sendMessage(message) {
    messages.push({ ...message, at: now });
    let data = { ok: true };
    if (message.type === 'bridge:poll') data = { job: messages.filter(item => item.type === 'bridge:poll').length === 1 ? { id: 'job-fixture', prompt: 'Question', conversationUrl: url, timeoutMs: 60000, images: [] } : null };
    if (message.type === 'bridge:image') data = { imageId: String(message.index + 1).repeat(64) };
    return { ok: true, data };
  } } };
  win.eval(source); await flush();
  const advance = async ms => {
    const target = now + ms;
    let count = 0;
    while (true) {
      await flush();
      const [id, entry] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] || [];
      if (!entry || entry.at > target) break;
      assert.ok(++count < 1000, 'timer loop did not settle');
      now = entry.at; timers.delete(id); entry.fn();
    }
    now = target; await flush();
  };
  return {
    win, doc, messages, reads, imageStates, advance, close: () => page.window.close(),
    get now() { return now; }, get clicks() { return clicks; }, get candidateCalls() { return candidateCalls; },
    get observers() { return observers.size; }, get timers() { return timers.size; },
    get result() { return messages.find(message => message.type === 'bridge:result'); },
    get error() { return messages.find(message => message.type === 'bridge:error'); },
    async mutate(fn) { fn(doc); await flush(); },
    async hide(clamp = 0) { hidden = true; timerClamp = clamp; doc.dispatchEvent(new win.Event('visibilitychange')); await flush(); }
  };
}

test('text completion waits 800 ms and cleans completion observers and RPC timers', async () => {
  const x = await fixture();
  try {
    await x.advance(700); assert.equal(x.clicks, 1);
    await x.advance(799); assert.equal(x.result, undefined);
    await x.advance(1);
    assert.equal(x.result.text, 'Final answer');
    assert.equal(x.result.timing.confirmationMs, 800);
    assert.equal(x.result.timing.inputPreparationMs, 700);
    assert.equal(x.result.timing.imagePreparationMs, 0);
    assert.equal(x.result.timing.background, false);
    assert.equal(x.observers, 0); assert.equal(x.timers, 0);
    const calls = x.candidateCalls;
    await x.mutate(doc => { doc.querySelector('main p').textContent = 'After completion'; });
    assert.equal(x.candidateCalls, calls);
  } finally { x.close(); }
});

test('late answer changes reset the stability window and only the full latest text is returned', async () => {
  const x = await fixture();
  try {
    await x.advance(700 + 600);
    await x.mutate(doc => { doc.querySelector('main p').textContent = 'Final answer with late detail'; });
    await x.advance(799); assert.equal(x.result, undefined);
    await x.advance(1);
    assert.equal(x.result.text, 'Final answer with late detail');
    assert.equal(x.result.timing.confirmationMs, 1400);
    assert.equal(x.clicks, 1);
  } finally { x.close(); }
});

test('stable text without generation-complete and scoped action controls is never returned', async () => {
  const x = await fixture({ state: 'streaming', controls: false });
  try {
    await x.advance(700 + 3000); assert.equal(x.result, undefined);
    await x.mutate(doc => doc.querySelector('[data-talvt-turn-state]').setAttribute('data-talvt-turn-state', 'complete'));
    await x.advance(2000); assert.equal(x.result, undefined);
    await x.mutate(doc => doc.querySelector('[data-talvt-turn-state]').insertAdjacentHTML('beforeend', '<div class="turn-action-controls"><button aria-label="复制">Copy</button></div>'));
    await x.advance(799); assert.equal(x.result, undefined);
    await x.advance(1); assert.equal(x.result.text, 'Final answer');
  } finally { x.close(); }
});

test('an additional user turn interrupts completion and clears every wait resource', async () => {
  const x = await fixture();
  try {
    await x.advance(700 + 400);
    await x.mutate(doc => doc.querySelector('main').insertAdjacentHTML('beforeend', '<div data-message-author-role="user" data-message-id="manual">Manual question</div>'));
    assert.equal(x.result, undefined); assert.match(x.error.error, /其他消息|内容被替换/);
    assert.equal(x.clicks, 1); assert.equal(x.observers, 0); assert.equal(x.timers, 0);
  } finally { x.close(); }
});

test('fallback catches conversation navigation even without a DOM mutation', async () => {
  const x = await fixture();
  try {
    await x.advance(700 + 100);
    x.win.history.replaceState({}, '', '/c/a-different-conversation');
    await x.advance(150);
    assert.match(x.error.error, /切换了对话/); assert.equal(x.result, undefined);
    assert.equal(x.observers, 0); assert.equal(x.timers, 0);
  } finally { x.close(); }
});

test('image load events wake detection and image source or dimensions reset the 1200 ms window', async () => {
  const x = await fixture({ imageCount: 1, imagesLoaded: false });
  try {
    await x.advance(700 + 300);
    x.imageStates[0].loaded = true;
    await x.mutate(doc => doc.querySelector('main img').dispatchEvent(new x.win.Event('load')));
    await x.advance(1000); assert.equal(x.result, undefined);
    x.imageStates[0].width = 1024;
    await x.mutate(doc => doc.querySelector('main img').dispatchEvent(new x.win.Event('load')));
    await x.advance(1199); assert.equal(x.result, undefined);
    await x.advance(1);
    assert.equal(x.result.timing.confirmationMs, 2200);
    assert.deepEqual(x.messages.filter(message => message.type === 'bridge:image').map(message => message.index), [0]);
    assert.equal(x.clicks, 1);
  } finally { x.close(); }
});

test('DOM events can finish a hidden-page confirmation before a throttled fallback fires', async () => {
  const x = await fixture();
  try {
    await x.advance(700); await x.hide(2000);
    await x.advance(800); assert.equal(x.result, undefined);
    await x.mutate(doc => doc.querySelector('main p').setAttribute('data-render-complete', 'true'));
    assert.equal(x.result.timing.confirmationMs, 800);
    assert.equal(x.result.timing.background, true);
    assert.equal(x.observers, 0); assert.equal(x.timers, 0);
  } finally { x.close(); }
});

test('the extension badge outside body does not wake or loop completion detection', async () => {
  const x = await fixture();
  try {
    await x.advance(700);
    const calls = x.candidateCalls;
    await x.mutate(doc => {
      const badge = [...doc.documentElement.children].find(node => !['HEAD', 'BODY'].includes(node.tagName));
      assert.ok(badge); badge.setAttribute('data-fixture-status', 'changed');
    });
    assert.equal(x.candidateCalls, calls);
    await x.advance(800); assert.ok(x.result); assert.equal(x.clicks, 1);
  } finally { x.close(); }
});

test('concurrent image read failure settles readers and sends neither partial images nor a final result', async () => {
  const x = await fixture({ imageCount: 4, readDelay: 120, failImage: 0 });
  try {
    await x.advance(700 + 1200 + 120);
    assert.equal(x.result, undefined); assert.match(x.error.error, /Fixture image read failed/);
    assert.deepEqual(x.reads, [0, 1]);
    assert.equal(x.messages.some(message => message.type === 'bridge:image'), false);
    assert.equal(x.observers, 0); assert.equal(x.timers, 0);
    assert.equal(x.clicks, 1);
  } finally { x.close(); }
});
