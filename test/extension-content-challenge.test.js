import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as dom from '../extension/dom.js';
import * as shared from '../extension/shared.js';

const source = (await readFile(new URL('../extension/content.js', import.meta.url), 'utf8'))
  .replace("await import(chrome.runtime.getURL('dom.js'))", 'globalThis.__testDom')
  .replace("await import(chrome.runtime.getURL('shared.js'))", 'globalThis.__testShared')
  .replaceAll('location.reload();', 'globalThis.__testReload();');
const url = 'https://chatgpt.com/c/challenge-fixture';
const tick = () => new Promise(resolve => setImmediate(resolve));
const failedTurn = '<div data-turn-key="current"><div data-talvt-turn-state="error"><div data-message-author-role="user" data-message-id="current-user"><div class="whitespace-pre-wrap">Hello</div></div><div class="failure"><span>cloudflare_challenge</span><button>重试</button></div></div></div>';
const checkpoint = { userKey: 'message:current-user', prompt: 'Hello', imageSources: [] };
async function fixture({ recovery = false, verification = false, outcome = 'success', draft = '', changed = false, recoveryCardDelayMs = 0 } = {}) {
  const page = new JSDOM(`<main>${recovery ? failedTurn : ''}</main><form><textarea id="prompt-textarea"></textarea><button type="button" data-testid="send-button">Send</button></form>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = page.window; const doc = win.document; const messages = []; const timers = new Map();
  let now = 1000; let serial = 0; let reloads = 0; let sends = 0; let retries = 0; let offered = false;
  const schedule = (fn, ms, repeat = 0) => { const id = ++serial; timers.set(id, { fn, at: now + ms, repeat }); return id; };
  win.Date = class extends Date { static now() { return now; } };
  win.setTimeout = (fn, ms) => schedule(fn, ms); win.clearTimeout = id => timers.delete(id);
  win.setInterval = (fn, ms) => schedule(fn, ms, ms); win.clearInterval = id => timers.delete(id);
  win.__testDom = dom; win.__testShared = shared; win.__testReload = () => { reloads++; };
  const input = doc.querySelector('textarea'); input.value = draft;
  if (verification) doc.body.insertAdjacentHTML('beforeend', '<div id="challenge-stage">Manual verification</div>');
  if (changed) doc.querySelector('.whitespace-pre-wrap').textContent = 'Changed';
  const wireRetry = () => doc.querySelector('.failure button').addEventListener('click', () => {
    retries++;
    if (outcome === 'failure') return;
    doc.querySelector('.failure').remove();
    const state = doc.querySelector('[data-talvt-turn-state]'); state.dataset.talvtTurnState = 'streaming';
    schedule(() => {
      state.dataset.talvtTurnState = 'complete';
      state.insertAdjacentHTML('beforeend', '<div data-message-author-role="assistant" data-message-id="recovered-answer"><div data-markdown-text-style="assistant-message">Recovered answer</div></div><div class="turn-action-controls"><button aria-label="Copy">Copy</button></div>');
    }, 1000);
  });
  if (recovery) wireRetry();
  if (recovery && recoveryCardDelayMs > 0) {
    const failure = doc.querySelector('.failure'); failure.remove();
    schedule(() => doc.querySelector('[data-talvt-turn-state]').append(failure), recoveryCardDelayMs);
  }
  doc.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
    sends++; input.value = ''; doc.querySelector('main').innerHTML = failedTurn; wireRetry();
  });
  const job = { id: 'test-job', assistant: 'chatgpt', platform: 'qq', conversationUrl: url, timeoutMs: 20000 };
  win.chrome = { runtime: {
    id: 'challenge-test', getURL: path => `chrome-extension://challenge-test/${path}`, onMessage: { addListener() {} },
    async sendMessage(message) {
      messages.push(message); let data = { ok: true };
      if (message.type === 'bridge:challenge-resume') data = { job: recovery ? { ...job, recovery: checkpoint } : null };
      if (message.type === 'bridge:poll') { data = { job: !offered && !recovery ? { ...job, prompt: 'Hello' } : null }; offered = true; }
      return { ok: true, data };
    }
  } };
  const advance = async ms => {
    const target = now + ms; await tick();
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; now = timer.at;
      if (timer.repeat) timer.at += timer.repeat; else timers.delete(id);
      timer.fn(); await tick();
    }
    now = target; await tick();
  };
  win.eval(source); await tick();
  return { doc, messages, advance, close: () => page.window.close(), get reloads() { return reloads; }, get sends() { return sends; }, get retries() { return retries; } };
}

test('new group task saves a checkpoint and refreshes only once without failing or re-submitting', async () => {
  const x = await fixture();
  try {
    await x.advance(10000);
    assert.equal(x.sends, 1); assert.equal(x.reloads, 1); assert.equal(x.retries, 0);
    assert.equal(x.messages.filter(m => m.type === 'bridge:challenge-prepare').length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(x.messages.find(m => m.type === 'bridge:challenge-prepare').checkpoint)), checkpoint);
    assert.equal(x.messages.some(m => m.type === 'bridge:error' || m.type === 'bridge:result'), false);
  } finally { x.close(); }
});
test('after refresh the original failure is retried once and its complete answer is delivered without a new prompt', async () => {
  const x = await fixture({ recovery: true });
  try {
    await x.advance(5000);
    assert.equal(x.retries, 1); assert.equal(x.reloads, 0); assert.equal(x.sends, 0);
    assert.equal(x.messages.filter(m => m.type === 'bridge:challenge-retry').length, 1);
    assert.equal(x.messages.filter(m => m.type === 'bridge:result').length, 1);
    assert.equal(x.messages.find(m => m.type === 'bridge:result').text, 'Recovered answer');
    assert.equal(x.messages.some(m => ['bridge:started', 'bridge:error', 'bridge:input-image', 'bridge:challenge-prepare'].includes(m.type)), false);
  } finally { x.close(); }
});
test('recovery waits for a delayed error card instead of mistaking an incomplete DOM for recovered generation', async () => {
  const x = await fixture({ recovery: true, recoveryCardDelayMs: 800 });
  try {
    await x.advance(500);
    assert.equal(x.retries, 0); assert.equal(x.messages.some(m => m.type === 'bridge:error'), false);
    await x.advance(4500);
    assert.equal(x.retries, 1); assert.equal(x.sends, 0); assert.equal(x.reloads, 0);
    assert.equal(x.messages.filter(m => m.type === 'bridge:challenge-retry').length, 1);
    assert.equal(x.messages.filter(m => m.type === 'bridge:result').length, 1);
    assert.equal(x.messages.find(m => m.type === 'bridge:result').text, 'Recovered answer');
    assert.equal(x.messages.some(m => m.type === 'bridge:error'), false);
  } finally { x.close(); }
});
test('a reloaded answer that completes without an error card is delivered without using the retry', async () => {
  const x = await fixture({ recovery: true, recoveryCardDelayMs: 30000 });
  try {
    await x.advance(500);
    const state = x.doc.querySelector('[data-talvt-turn-state]'); state.dataset.talvtTurnState = 'complete';
    state.insertAdjacentHTML('beforeend', '<div data-message-author-role="assistant" data-message-id="already-recovered"><div data-markdown-text-style="assistant-message">Already recovered</div></div><div class="turn-action-controls"><button aria-label="Copy">Copy</button></div>');
    await x.advance(2000);
    assert.equal(x.retries, 0); assert.equal(x.sends, 0); assert.equal(x.reloads, 0);
    assert.equal(x.messages.filter(m => m.type === 'bridge:result').length, 1);
    assert.equal(x.messages.find(m => m.type === 'bridge:result').text, 'Already recovered');
    assert.equal(x.messages.some(m => m.type === 'bridge:challenge-retry' || m.type === 'bridge:error'), false);
  } finally { x.close(); }
});
test('incomplete recovery DOM stays bounded by the original deadline and a late error card cannot retry an expired job', async () => {
  const x = await fixture({ recovery: true, recoveryCardDelayMs: 25000 });
  try {
    await x.advance(30000);
    assert.equal(x.retries, 0); assert.equal(x.sends, 0); assert.equal(x.reloads, 0);
    assert.equal(x.messages.filter(m => m.type === 'bridge:error').length, 1);
    assert.match(x.messages.find(m => m.type === 'bridge:error').error, /超时/);
    assert.equal(x.messages.some(m => m.type === 'bridge:challenge-retry' || m.type === 'bridge:result'), false);
  } finally { x.close(); }
});
test('persistent challenge failure stops after the single retry and never enters a refresh loop', async () => {
  const x = await fixture({ recovery: true, outcome: 'failure' });
  try {
    await x.advance(15000);
    assert.equal(x.retries, 1); assert.equal(x.reloads, 0); assert.equal(x.sends, 0);
    assert.equal(x.messages.filter(m => m.type === 'bridge:error').length, 1);
    assert.match(x.messages.find(m => m.type === 'bridge:error').error, /已刷新并重试一次/);
    assert.equal(x.messages.some(m => m.type === 'bridge:result'), false);
  } finally { x.close(); }
});
test('visible verification waits for manual completion before retry; drafts and changed turns stop recovery', async () => {
  const x = await fixture({ recovery: true, verification: true });
  try {
    await x.advance(2000); assert.equal(x.retries, 0); assert.equal(x.reloads, 0);
    x.doc.querySelector('#challenge-stage').remove(); await x.advance(3000);
    assert.equal(x.retries, 1); assert.equal(x.messages.filter(m => m.type === 'bridge:result').length, 1);
  } finally { x.close(); }
  for (const options of [{ draft: 'Human draft' }, { changed: true }]) {
    const y = await fixture({ recovery: true, ...options });
    try {
      await y.advance(1000); assert.equal(y.retries, 0); assert.equal(y.sends, 0); assert.equal(y.reloads, 0);
      assert.equal(y.messages.filter(m => m.type === 'bridge:error').length, 1);
      if (options.draft) assert.equal(y.doc.querySelector('textarea').value, options.draft);
    } finally { y.close(); }
  }
});
