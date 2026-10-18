import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as dom from '../extension/dom.js';

const failure = '<div class="failure"><span>cloudflare_challenge</span><button>重试</button></div>';
const question = '<div data-message-author-role="user" data-message-id="current-user"><div class="whitespace-pre-wrap">Hello</div></div>';
function fixture(modern = true) {
  const doc = new JSDOM('<main></main><form><textarea id="prompt-textarea"></textarea></form>', { url: 'https://chatgpt.com/c/challenge-test' }).window.document;
  const baseline = dom.snapshot(doc);
  doc.querySelector('main').innerHTML = modern ? `<div data-turn-key="current"><div data-talvt-turn-state="streaming">${question}${failure}</div></div>` : `<article>${question}</article><article>${failure}</article>`;
  return { doc, baseline, user: dom.findSubmittedUser(doc, baseline, 'Hello') };
}
test('current compact Cloudflare retry card fails before generation or assistant markers exist', () => {
  for (const modern of [true, false]) {
    const { doc, baseline, user } = fixture(modern);
    assert.throws(() => dom.finalCandidate(doc, baseline, user), { code: 'CHATGPT_CLOUDFLARE_CHALLENGE' });
    assert.throws(() => dom.assertReady(doc), /cloudflare_challenge/);
    assert.equal(dom.challengeRetryButton(doc, user).textContent, '重试');
  }
});
test('normal model prose/code, quoted controls, hidden cards and historical failures are not challenge errors', () => {
  for (const body of ['<p>cloudflare_challenge</p>', '<pre><code>cloudflare_challenge</code></pre>', failure, '<div role="alert">cloudflare_challenge</div>']) {
    const { doc, baseline, user } = fixture();
    doc.querySelector('.failure').remove();
    const state = doc.querySelector('[data-talvt-turn-state]'); state.dataset.talvtTurnState = 'complete';
    state.insertAdjacentHTML('beforeend', `<div data-message-author-role="assistant" data-message-id="answer"><div data-markdown-text-style="assistant-message">${body}</div></div><div class="turn-action-controls"><button aria-label="Copy"></button></div>`);
    doc.querySelector('main').insertAdjacentHTML('afterbegin', `<div data-turn-key="historical">${failure}</div>`);
    state.insertAdjacentHTML('beforeend', `<div hidden>${failure}</div><div data-channel="analysis">${failure}</div>`);
    assert.match(dom.finalCandidate(doc, baseline, user).text, /cloudflare_challenge/);
    assert.ok(dom.assertReady(doc));
    assert.equal(dom.challengeRetryButton(doc, user), null);
  }
});
test('actual verification iframe blocks retry and completion but is never clicked', () => {
  const { doc, baseline, user } = fixture();
  doc.body.insertAdjacentHTML('beforeend', '<iframe src="https://challenges.cloudflare.com/test"></iframe>');
  assert.equal(dom.pageChallengeActive(doc), true);
  assert.equal(dom.challengeRetryButton(doc, user), null);
  assert.throws(() => dom.finalCandidate(doc, baseline, user), /手动完成验证/);
});
test('checkpoint reidentifies the exact latest message across reload without requiring old virtualized history', () => {
  const { doc, baseline, user } = fixture();
  baseline.imageSources.add('https://chatgpt.com/old-image');
  const checkpoint = dom.challengeCheckpoint(doc, baseline, user, 'Hello');
  const reloaded = fixture(); const context = dom.restoreChallengeContext(reloaded.doc, checkpoint);
  assert.equal(context.user.dataset.messageId, 'current-user');
  assert.ok(context.baseline.imageSources.has('https://chatgpt.com/old-image'));
  assert.throws(() => dom.finalCandidate(reloaded.doc, context.baseline, context.user), { code: 'CHATGPT_CLOUDFLARE_CHALLENGE' });
  reloaded.user.querySelector('.whitespace-pre-wrap').textContent = 'Changed question';
  assert.throws(() => dom.finalCandidate(reloaded.doc, context.baseline, context.user), /内容被替换/);
  assert.throws(() => dom.restoreChallengeContext(reloaded.doc, checkpoint), /消息已变化/);
});

test('restored challenge ownership survives same-text replacement but rejects edited replacement', () => {
  const original = fixture(); const checkpoint = dom.challengeCheckpoint(original.doc, original.baseline, original.user, 'Hello');
  const reloaded = fixture(); const context = dom.restoreChallengeContext(reloaded.doc, checkpoint);
  const replacement = context.user.cloneNode(true); context.user.replaceWith(replacement);
  assert.throws(() => dom.finalCandidate(reloaded.doc, context.baseline, context.user), { code: 'CHATGPT_CLOUDFLARE_CHALLENGE' });
  replacement.querySelector('.whitespace-pre-wrap').textContent = 'Different question';
  assert.throws(() => dom.finalCandidate(reloaded.doc, context.baseline, context.user), /内容被替换/);
});
test('extra messages, drafts, attachments, ambiguous and disabled retry buttons cannot authorize a retry', () => {
  const x = fixture(); const checkpoint = dom.challengeCheckpoint(x.doc, x.baseline, x.user, 'Hello');
  x.doc.querySelector('textarea').value = 'human draft';
  assert.throws(() => dom.challengeCheckpoint(x.doc, x.baseline, x.user, 'Hello'), /草稿/);
  assert.throws(() => dom.challengeRetryButton(x.doc, x.user), /草稿/);
  x.doc.querySelector('textarea').value = '';
  x.doc.querySelector('.failure').insertAdjacentHTML('beforeend', '<button>Retry</button>');
  assert.equal(dom.challengeRetryButton(x.doc, x.user), null);
  x.doc.querySelector('.failure button').remove(); x.doc.querySelector('.failure button').disabled = true;
  assert.equal(dom.challengeRetryButton(x.doc, x.user), null);
  x.doc.querySelector('main').insertAdjacentHTML('beforeend', '<div data-message-author-role="user" data-message-id="human-next">Manual next turn</div>');
  assert.throws(() => dom.restoreChallengeContext(x.doc, checkpoint), /消息已变化/);
});

test('ChatGPT unavailable model control blocks polling and submit and defers original-turn retry', () => {
  const {doc,user}=fixture();const form=doc.querySelector('form');
  form.insertAdjacentHTML('beforeend','<button role="combobox">无法加载 ChatGPT 模型</button><button data-testid="send-button">发送</button>');
  assert.throws(()=>dom.assertReady(doc),/模型尚未加载/);
  assert.throws(()=>dom.sendButton(doc,dom.composer(doc)),/模型尚未加载/);
  assert.equal(dom.challengeRetryButton(doc,user),null);
  form.querySelector('[role=combobox]').textContent='GPT';
  assert.ok(dom.sendButton(doc,dom.composer(doc)));
  assert.equal(dom.challengeRetryButton(doc,user).textContent,'重试');
});
test('ChatGPT model loading guard ignores answer text, hidden controls and ordinary model labels', () => {
  const {doc}=fixture();doc.querySelector('main').replaceChildren();
  doc.querySelector('main').innerHTML='<p>无法加载 ChatGPT 模型</p><button>无法加载 ChatGPT 模型</button>';
  doc.querySelector('form').insertAdjacentHTML('beforeend','<button hidden>无法加载 ChatGPT 模型</button><button role="combobox">GPT</button>');
  assert.ok(dom.assertReady(doc));
});
test('ChatGPT clean conversation waits until its model selector has recovered', () => {
  const {doc}=fixture();doc.querySelector('main').replaceChildren();const form=doc.querySelector('form');
  form.insertAdjacentHTML('beforeend','<button role="combobox" aria-label="Unable to load ChatGPT models"></button>');
  assert.throws(()=>dom.assertReady(doc),/模型尚未加载/);form.querySelector('button').setAttribute('aria-label','Choose model');assert.ok(dom.assertReady(doc));
});

test('reload waits for the known message text to mount completely before restoring retry ownership', () => {
  const x = fixture(); const checkpoint = dom.challengeCheckpoint(x.doc, x.baseline, x.user, 'Hello');
  const body = x.user.querySelector('.whitespace-pre-wrap');
  for (const text of ['', 'Hel']) {
    body.textContent = text;
    assert.equal(dom.restoreChallengeContext(x.doc, checkpoint), null);
  }
  body.textContent = 'Hello';
  assert.ok(dom.restoreChallengeContext(x.doc, checkpoint));
  body.textContent = 'Hello different';
  assert.throws(() => dom.restoreChallengeContext(x.doc, checkpoint), /消息已变化/);
});
