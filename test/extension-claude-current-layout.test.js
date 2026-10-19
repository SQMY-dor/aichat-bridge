import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as dom from '../extension/claude-dom.js';
import * as shared from '../extension/shared.js';

const base = await readFile(new URL('./fixtures/claude-conversation.html', import.meta.url), 'utf8');
const reply = await readFile(new URL('./fixtures/claude-nested-actions.html', import.meta.url), 'utf8');
const content = (await readFile(new URL('../extension/content.js', import.meta.url), 'utf8'))
  .replace("await import(chrome.runtime.getURL('claude-dom.js'))", 'globalThis.__adapter')
  .replace("await import(chrome.runtime.getURL('shared.js'))", 'globalThis.__shared');
function fixture() {
  const { window } = new JSDOM(base, { url: 'https://claude.ai/chat/11111111-1111-4111-8111-111111111111', runScripts: 'outside-only' });
  const doc = window.document, baseline = dom.snapshot(doc);
  doc.querySelector('main').insertAdjacentHTML('beforeend', '<div data-testid="transcript-row" data-perf-row="user"><div data-testid="user-message"><p>Question</p></div></div>');
  const user = dom.findSubmittedUser(doc, baseline, 'Question');
  doc.querySelector('main').insertAdjacentHTML('beforeend', reply);
  const message = dom.turns(doc, 'assistant').at(-1);
  return { window, doc, baseline, user, message, bar: message.querySelector('[role="toolbar"]'), body: message.querySelector('.standard-markdown'), result: () => dom.finalCandidate(doc, baseline, user) };
}

test('observed Claude nested toolbar permits the next lease and extracts the transcript-engine prose', () => {
  const x = fixture();
  try {
    assert.equal(dom.assertReady(x.doc), dom.composer(x.doc));
    assert.equal(x.result()?.text, 'Current Claude answer.');
    assert.deepEqual(x.result()?.images, []);
  } finally { x.window.close(); }
});

test('content script polls for queued work when the previous Claude reply uses the current layout', async () => {
  const x = fixture(), sent = [];
  try {
    x.window.__adapter = dom; x.window.__shared = shared;
    // Hold page timers to verify that the initial ready check itself succeeds.
    x.window.setTimeout = x.window.setInterval = () => 1;
    x.window.clearTimeout = x.window.clearInterval = () => {};
    x.window.chrome = { runtime: {
      id: 'fixture-extension', getURL: path => `chrome-extension://fixture-extension/${path}`,
      onMessage: { addListener() {} },
      async sendMessage(message) { sent.push(message); return { ok: true, data: { job: null } }; },
    } };
    x.window.eval(content);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.filter(message => message.type === 'bridge:poll').length, 1);
    assert.equal(sent.filter(message => message.type === 'bridge:error').length, 0);
    assert.doesNotMatch(x.doc.body.textContent, /上一条 Claude 网页提问尚未明确完成/);
  } finally { x.window.close(); }
});

test('current Claude prose keeps formatting and excludes action labels, time, headings and reasoning', () => {
  const x = fixture();
  try {
    x.body.innerHTML = '<h2>Answer</h2><p><strong>Done</strong></p><pre><code class="language-js">print(1)</code></pre>';
    x.message.insertAdjacentHTML('afterbegin', '<div data-testid="TurnStatus"><div data-transcript-engine-root><div data-cds="Prose"><div class="standard-markdown">PRIVATE THOUGHT</div></div></div></div>');
    const text = x.result()?.text;
    assert.match(text, /## Answer/); assert.match(text, /\*\*Done\*\*/); assert.match(text, /```js\nprint\(1\)\n```/);
    assert.doesNotMatch(text, /PRIVATE|复制|重试|分钟前|fixture heading|icon/);
  } finally { x.window.close(); }
});

for (const scenario of ['streaming', 'row-streaming', 'missing-copy', 'missing-retry', 'disabled-copy', 'disabled-fieldset', 'duplicate-copy', 'duplicate-toolbar', 'toolbar-in-prose', 'toolbar-before-prose', 'toolbar-in-thinking', 'toolbar-in-other-message', 'hidden-toolbar', 'unknown-copy-label', 'unknown-body', 'duplicate-body']) {
  test(`current Claude layout rejects ${scenario}`, () => {
    const x = fixture();
    try {
      const copy = x.bar.querySelector('[aria-label="复制"]');
      if (scenario === 'streaming') x.message.dataset.isStreaming = 'true';
      if (scenario === 'row-streaming') x.message.closest('[data-testid="transcript-row"]').dataset.perfRowStreaming = 'true';
      if (scenario === 'missing-copy') copy.remove();
      if (scenario === 'missing-retry') x.bar.querySelector('[data-testid="action-bar-retry"]').remove();
      if (scenario === 'disabled-copy') copy.disabled = true;
      if (scenario === 'disabled-fieldset') { const fieldset=x.doc.createElement('fieldset'); fieldset.disabled=true; x.bar.before(fieldset); fieldset.append(x.bar); }
      if (scenario === 'duplicate-copy') copy.after(copy.cloneNode(true));
      if (scenario === 'duplicate-toolbar') x.bar.after(x.bar.cloneNode(true));
      if (scenario === 'toolbar-in-prose') x.body.append(x.bar);
      if (scenario === 'toolbar-before-prose') x.message.prepend(x.bar);
      if (scenario === 'toolbar-in-thinking') { const thinking=x.doc.createElement('details'); x.bar.before(thinking); thinking.append(x.bar); }
      if (scenario === 'toolbar-in-other-message') dom.turns(x.doc, 'assistant')[0].append(x.bar);
      if (scenario === 'hidden-toolbar') x.bar.hidden = true;
      if (scenario === 'unknown-copy-label') copy.setAttribute('aria-label', 'Copy code');
      if (scenario === 'unknown-body') x.body.parentElement.removeAttribute('data-cds');
      if (scenario === 'duplicate-body') x.body.after(x.body.cloneNode(true));
      assert.equal(x.result(), null);
      assert.throws(() => dom.assertReady(x.doc), { name: 'PageSafetyError' });
    } finally { x.window.close(); }
  });
}
