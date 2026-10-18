import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { snapshot, findSubmittedUser, finalCandidate, visible } from '../extension/dom.js';

function turn(id, prompt, answer) {
  return `<div data-turn-key="turn-${id}"><div data-talvt-turn-state="complete"><div data-chatgpt-search-unit-key="${id}:0:user" data-chatgpt-search-message-ids="${id}-u"><div data-user-message-bubble="true">${prompt}</div></div><div data-chatgpt-search-unit-key="${id}:0:assistant" data-chatgpt-search-message-ids="${id}-a"><div data-markdown-text-style="assistant-message">${answer}</div></div><div class="turn-action-controls"><button aria-label="复制">Copy</button></div></div></div>`;
}
function fixture(answer) {
  const window = new JSDOM(`<!doctype html><style>.hidden-by-class { display: none; }</style><main>${Array.from({ length: 20 }, (_, i) => turn(`old${i}`, 'old', '<p>Old answer</p>')).join('')}</main>`, { url: 'https://chatgpt.com/c/synthetic-dom-performance' }).window;
  const doc = window.document; const baseline = snapshot(doc);
  doc.querySelector('main').insertAdjacentHTML('beforeend', turn('current', 'Question', answer));
  const user = findSubmittedUser(doc, baseline, 'Question');
  const current = doc.querySelector('[data-turn-key="turn-current"]');
  const original = window.getComputedStyle.bind(window); const reads = new Map();
  window.getComputedStyle = element => { reads.set(element, (reads.get(element) ?? 0) + 1); return original(element); };
  return { window, doc, current, reads, scan: () => finalCandidate(doc, baseline, user) };
}

test('a long final answer samples each element style once within a synchronous scan', t => {
  const f = fixture(Array.from({ length: 200 }, (_, i) => `<p><strong>项目 ${i}</strong><span>：这是离线合成的分析文本。</span></p>`).join(''));
  t.after(() => f.window.close());
  const result = f.scan();
  assert.match(result.text, /项目 0/); assert.match(result.text, /项目 199/);
  const count = [...f.reads.values()].reduce((sum, value) => sum + value, 0);
  // This fixture required 5,305 computed-style reads before per-scan caching.
  assert.ok(count < 1000, `expected at least 80% fewer style reads; received ${count}`);
  assert.equal(Math.max(...f.reads.values()), 1);
  f.reads.clear();
  assert.equal(f.scan().text, result.text);
  assert.equal([...f.reads.values()].reduce((sum, value) => sum + value, 0), count, 'a second scan must sample again');
});

test('class, inline style and hidden changes between scans are always resampled', t => {
  const f = fixture('<p>Public answer.</p><section id="changing"><p>Conditional detail.</p></section>');
  t.after(() => f.window.close());
  const changing = f.doc.querySelector('#changing');
  for (const [hide, reveal] of [
    [() => { changing.className = 'hidden-by-class'; }, () => { changing.className = ''; }],
    [() => { changing.style.visibility = 'hidden'; }, () => { changing.style.visibility = ''; }],
    [() => { changing.style.display = 'none'; }, () => { changing.style.display = ''; }],
    [() => { changing.hidden = true; }, () => { changing.hidden = false; }],
    [() => changing.setAttribute('aria-hidden', 'true'), () => changing.removeAttribute('aria-hidden')],
  ]) {
    assert.match(f.scan().text, /Conditional detail/);
    hide(); assert.equal(f.scan().text, 'Public answer.');
    reveal(); assert.match(f.scan().text, /Conditional detail/);
  }
});

test('completion and ancestor visibility cannot be reused from an earlier successful scan', t => {
  const f = fixture('<p>Final answer.</p>'); t.after(() => f.window.close());
  assert.equal(f.scan().text, 'Final answer.');
  const control = f.current.querySelector('.turn-action-controls');
  control.classList.add('hidden-by-class'); assert.equal(f.scan(), null);
  control.classList.remove('hidden-by-class'); assert.equal(f.scan().text, 'Final answer.');
  f.current.style.display = 'none'; assert.equal(f.scan(), null);
  f.current.style.display = ''; assert.equal(f.scan().text, 'Final answer.');
  f.current.querySelector('[data-talvt-turn-state]').setAttribute('data-talvt-turn-state', 'streaming'); assert.equal(f.scan(), null);
  f.current.querySelector('[data-talvt-turn-state]').setAttribute('data-talvt-turn-state', 'complete'); assert.equal(f.scan().text, 'Final answer.');
  control.style.display = 'none';
  assert.equal(visible(control), false, 'visibility calls outside finalCandidate must not retain its cache');
});

test('a failed scan releases cached styles before independent checks or later scans', t => {
  const f = fixture('<p>Final answer.</p><div data-dil-render-failed>Render failure</div>'); t.after(() => f.window.close());
  const failure = f.current.querySelector('[data-dil-render-failed]');
  assert.throws(() => f.scan(), /网页回复加载失败/);
  failure.className = 'hidden-by-class';
  assert.equal(visible(failure), false, 'finally must release styles even when extraction throws');
  assert.equal(f.scan().text, 'Final answer.');
  failure.className = '';
  assert.throws(() => f.scan(), /网页回复加载失败/);
});
