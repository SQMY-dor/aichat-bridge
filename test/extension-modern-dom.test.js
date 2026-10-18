import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { assertReady, composer, composerText, composerScope, composerInteraction, generating, hasAttachments, snapshot, turns, newUsers, findSubmittedUser, finalCandidate, sendButton, insertPrompt, markdownText, visible } from '../extension/dom.js';
function unit(id, role, text) {
  return `<div data-chatgpt-search-unit-key="fixture-${id}:0:${role}" data-chatgpt-search-message-ids="message-${id} message-${id}"><div data-content-search-unit-key="fixture-${id}:0:${role}">${role === 'user' ? `<div data-user-message-bubble="true">${text}</div><button aria-label="复制消息">Not message content</button>` : `<div data-chatgpt-selection-message-id="message-${id}"><div data-markdown-text-style="assistant-message">${text}</div></div>`}</div></div>`;
}
function turn(id, prompt, answer = '', state = 'complete', controls = true) {
  return `<div data-turn-key="turn-${id}"><div data-talvt-turn-state="${state}">${unit(`${id}-user`, 'user', prompt)}<div data-channel="analysis">PRIVATE REASONING</div>${answer ? unit(`${id}-assistant`, 'assistant', answer) : ''}${controls ? '<div class="turn-action-controls"><button aria-label="复制">Copy</button></div>' : ''}</div></div>`;
}
function page(history = '') {
  return new JSDOM(`<!doctype html><main>${history}</main><div data-composer-surface-variant="default"><div data-composer-body><div data-composer-attachments hidden></div><button aria-label="添加文件等内容">Attach</button><div><div contenteditable="true" data-composer-markdown role="textbox"><p><br></p></div></div><button aria-label="开始语音">Voice</button></div></div>`, { url: 'https://chatgpt.com/c/fixture-conversation' }).window.document;
}
function add(doc, html) { doc.querySelector('main').insertAdjacentHTML('beforeend', html); }

test('observed completed image-only historical turn allows the next prompt without treating its image as an attachment', async () => {
  const fixture = await readFile(new URL('./fixtures/chatgpt-modern-generated-image.html', import.meta.url), 'utf8');
  const doc = page(fixture);
  assert.equal(turns(doc, 'assistant').length, 1);
  assert.ok(assertReady(doc));
  assert.equal(hasAttachments(composer(doc)), false);
  doc.querySelector('.turn-action-controls button').remove();
  assert.throws(() => assertReady(doc), /尚未明确完成/);
});

test('modern empty composer and complete latest turn work despite an older cancelled turn', () => {
  const doc = page(turn('old-cancelled', 'Cancelled question', '', 'cancelled') + turn('old-complete', 'Initialization', '<p>Ready.</p>'));
  assert.equal(generating(doc), false);
  const input = assertReady(doc);
  assert.equal(input.hasAttribute('data-composer-markdown'), true);
  assert.equal(composerScope(input), doc.querySelector('[data-composer-body]'));
  assert.equal(hasAttachments(input), false);
  assert.equal(sendButton(doc, input), null); // Empty real composer shows voice, never assume a send button.
  doc.body.insertAdjacentHTML('beforeend', '<button type="submit" aria-label="发送">Outside</button>');
  assert.equal(sendButton(doc, input), null);
  composerScope(input).insertAdjacentHTML('beforeend', '<button type="submit" aria-label="发送">Send</button>');
  assert.equal(sendButton(doc, input).textContent, 'Send');
  assert.equal(composerInteraction(input.firstElementChild, input), true);
  assert.equal(composerInteraction(sendButton(doc, input), input), true);
});

test('modern attachments and multiline drafts are detected without treating attachment controls as files', () => {
  const doc = page(); const input = composer(doc);
  assert.ok(assertReady(doc));
  input.innerHTML = '<p>line one</p><p>line two</p>';
  assert.equal(composerText(input), 'line one\nline two');
  assert.throws(() => assertReady(doc), /草稿/);
  input.innerHTML = '<p><br></p>';
  const attachments = doc.querySelector('[data-composer-attachments]');
  attachments.hidden = false; attachments.innerHTML = '<div>private-file.pdf</div>';
  assert.throws(() => assertReady(doc), /附件/);
});

test('sanitized detached text keeps paragraph and BR boundaries even with browser innerText available', () => {
  const doc = page(); const copy = doc.createElement('div');
  copy.innerHTML = '<p>first line</p><p>second line<br>third line</p>';
  // Chromium exposes this concatenated value for unrendered clones. JSDOM
  // has no native innerText, so provide the observed behavior explicitly.
  Object.defineProperty(copy, 'innerText', { value: 'first linesecond linethird line' });
  assert.equal(composerText(copy), 'first line\nsecond line\nthird line');
});

test('normal modern contenteditable insertion preserves multiline input and never clicks send', () => {
  const doc = page(); const input = composer(doc); let inputEvents = 0; let clicks = 0;
  composerScope(input).insertAdjacentHTML('beforeend', '<button type="submit" aria-label="发送">Send</button>');
  sendButton(doc, input).addEventListener('click', () => clicks++);
  input.addEventListener('input', () => inputEvents++);
  doc.execCommand = (command, showUI, text) => { assert.equal(command, 'insertText'); input.replaceChildren(...text.split('\n').map(line => { const p = doc.createElement('p'); p.textContent = line; return p; })); return true; };
  insertPrompt(doc, input, 'first line\nsecond line');
  assert.equal(composerText(input), 'first line\nsecond line');
  assert.equal(inputEvents, 1); assert.equal(clicks, 0);
  assert.throws(() => insertPrompt(doc, input, 'second submission'), /草稿/);
});

test('contenteditable insertion does not duplicate native input events', () => {
  const doc = page(); const input = composer(doc); const events = [];
  input.addEventListener('input', event => events.push(event.inputType));
  doc.execCommand = (_command, _showUI, text) => {
    input.textContent = text;
    input.dispatchEvent(new doc.defaultView.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return true;
  };
  insertPrompt(doc, input, 'Native edit');
  assert.deepEqual(events, ['insertText']);
  assert.equal(composerText(input), 'Native edit');
});

test('modern completion waits for an available copy control', () => {
  for (const [name, mutate] of [
    ['hidden', button => { button.hidden = true; }],
    ['disabled', button => { button.disabled = true; }],
    ['aria-disabled', button => button.setAttribute('aria-disabled', 'true')],
    ['inert', button => button.parentElement.setAttribute('inert', '')],
  ]) {
    const doc = page(); const baseline = snapshot(doc);
    add(doc, turn('control', 'question', '<p>answer</p>'));
    const user = findSubmittedUser(doc, baseline, 'question');
    mutate(doc.querySelector('.turn-action-controls button'));
    assert.equal(finalCandidate(doc, baseline, user), null, name);
    assert.throws(() => assertReady(doc), /尚未明确完成/, name);
  }
});

test('modern user and assistant share a turn; only the new completed final body is extracted', () => {
  const doc = page(turn('old', 'Old prompt', '<p>PRIVATE OLD REPLY</p>'));
  const before = snapshot(doc);
  // Rendering may deduplicate the same ID or renumber search indexes; identity stays stable.
  doc.querySelectorAll('[data-chatgpt-search-message-ids]').forEach(node => { node.setAttribute('data-chatgpt-search-message-ids', node.getAttribute('data-chatgpt-search-message-ids').split(' ')[0]); node.setAttribute('data-chatgpt-search-unit-key', node.getAttribute('data-chatgpt-search-unit-key').replace('fixture-', 'renumbered-')); });
  add(doc, turn('new', '<p>First line</p><p>Second line</p>', '<p>Final answer</p><pre><code class="language-js">1 + 1</code></pre>'));
  const user = findSubmittedUser(doc, before, 'First line\nSecond line');
  assert.ok(user); assert.equal(turns(doc, 'user').length, 2);
  const candidate = finalCandidate(doc, before, user);
  assert.match(candidate.text, /^Final answer/); assert.match(candidate.text, /```js\n1 \+ 1\n```/);
  assert.doesNotMatch(candidate.text, /PRIVATE|Not message content/);
});

test('a mounted empty user body waits for text while preserving mismatch and additional-user guards', () => {
  const doc = page(); const before = snapshot(doc);
  add(doc, turn('pending-text', '', '', 'streaming', false));
  assert.equal(findSubmittedUser(doc, before, 'Question'), null);
  const body = doc.querySelector('[data-user-message-bubble="true"]');
  const parent = body.parentElement; body.remove();
  assert.equal(findSubmittedUser(doc, before, 'Question'), null, 'action-control text cannot become the submitted prompt');
  parent.prepend(body);
  body.textContent = 'Question';
  assert.ok(findSubmittedUser(doc, before, 'Question'));
  body.textContent = 'Different question';
  assert.throws(() => findSubmittedUser(doc, before, 'Question'), /不同/);
  body.textContent = '';
  add(doc, turn('manual', 'Question', '', 'streaming', false));
  assert.throws(() => findSubmittedUser(doc, before, 'Question'), /其他新消息/);
});

test('modern completion needs complete state, scoped assistant actions and exactly one final body', () => {
  const doc = page(); const before = snapshot(doc);
  add(doc, turn('new', 'Question', '<p>Partial</p>', 'streaming'));
  const user = findSubmittedUser(doc, before, 'Question');
  assert.equal(generating(doc), true); assert.equal(finalCandidate(doc, before, user), null);
  const state = doc.querySelector('[data-talvt-turn-state]');
  for (const value of ['cancelled', 'unknown']) { state.setAttribute('data-talvt-turn-state', value); assert.equal(finalCandidate(doc, before, user), null); }
  state.removeAttribute('data-talvt-turn-state'); assert.equal(finalCandidate(doc, before, user), null);
  state.setAttribute('data-talvt-turn-state', 'complete');
  const control = doc.querySelector('.turn-action-controls'); control.className = ''; assert.equal(finalCandidate(doc, before, user), null);
  control.className = 'turn-action-controls'; assert.equal(finalCandidate(doc, before, user).text, 'Partial');
  doc.querySelector('[data-chatgpt-search-unit-key$=":assistant"]').insertAdjacentHTML('beforeend', '<div data-markdown-text-style="assistant-message">Ambiguous second body</div>');
  assert.equal(finalCandidate(doc, before, user), null);
});

test('modern thought/tool units and an answer in a different turn cannot be mistaken for this answer', () => {
  const doc = page(); const before = snapshot(doc);
  add(doc, turn('new', 'Question', '', 'complete'));
  const user = findSubmittedUser(doc, before, 'Question');
  const state = doc.querySelector('[data-talvt-turn-state]');
  state.insertAdjacentHTML('beforeend', '<div data-chatgpt-search-unit-key="fixture:1:analysis"><div data-markdown-text-style="assistant-message">SECRET THOUGHT</div></div><div data-chatgpt-search-unit-key="fixture:2:tool"><div data-markdown-text-style="assistant-message">TOOL OUTPUT</div></div>');
  add(doc, `<div data-turn-key="unrelated"><div data-talvt-turn-state="complete">${unit('unrelated', 'assistant', '<p>Other answer</p>')}<div class="turn-action-controls"><button aria-label="复制">Copy</button></div></div></div>`);
  assert.equal(finalCandidate(doc, before, user), null);
});

test('a second modern user turn is detected as human interference', () => {
  const doc = page(); const before = snapshot(doc);
  add(doc, turn('first', 'Group question', '<p>Answer</p>'));
  const user = findSubmittedUser(doc, before, 'Group question');
  add(doc, turn('manual', 'Human question', '', 'cancelled'));
  assert.throws(() => findSubmittedUser(doc, before, 'Group question'), /其他新消息/);
  assert.throws(() => finalCandidate(doc, before, user), /其他消息/);
});


test('visible render failure is a page error even when the new turn is complete and copy is available', () => {
  const doc = page(); const before = snapshot(doc);
  const failed = '<div data-dil-source-message-id="fixture-source" data-chatgpt-copy-reference="0" data-markdown-copy="contents"><div><div hidden>HIDDEN INTERNAL TEXT</div><div data-theme="dark"><div data-d-inline-reveal data-d-direction="col" data-dil-message-id="fixture-message"><div role="status" data-dil-render-failed>无法加载此回复</div></div></div></div></div>';
  add(doc, turn('failed-new', 'Group question', failed));
  const user = findSubmittedUser(doc, before, 'Group question');
  assert.throws(() => finalCandidate(doc, before, user), error => error.name === 'PageSafetyError' && /网页回复加载失败.*网页处理.*不会重新提问/.test(error.message));
  assert.equal(markdownText(doc.querySelector('[data-markdown-text-style="assistant-message"]')), '');
});

test('hidden failure UI is omitted, while ordinary answer text containing the same words remains valid', () => {
  const doc = page(); const before = snapshot(doc);
  add(doc, turn('ordinary', 'Explain this message', '<div hidden><span data-dil-render-failed>无法加载此回复</span>PRIVATE HIDDEN TEXT</div><p>“无法加载此回复”是一条错误提示。</p><pre><code>visible<span hidden>SECRET</span></code></pre>'));
  const user = findSubmittedUser(doc, before, 'Explain this message');
  const result = finalCandidate(doc, before, user);
  assert.match(result.text, /“无法加载此回复”是一条错误提示。/);
  assert.match(result.text, /```\nvisible\n```/);
  assert.doesNotMatch(result.text, /PRIVATE|SECRET/);
});

test('a historical render failure does not block or contaminate a new complete answer', () => {
  const doc = page(turn('old-failure', 'Old question', '<div role="status" data-dil-render-failed>无法加载此回复</div>'));
  assert.ok(assertReady(doc));
  const before = snapshot(doc);
  add(doc, turn('recovered', 'New question', '<p>Network recovered.</p>'));
  const user = findSubmittedUser(doc, before, 'New question');
  assert.equal(finalCandidate(doc, before, user).text, 'Network recovered.');
});

test('visible dynamic renderer answers exclude CSS-hidden sources and code helpers', () => {
  const doc = page(); const before = snapshot(doc);
  doc.head.insertAdjacentHTML('beforeend', '<style>.renderer-source { display: none; } .renderer-helper { visibility: hidden; }</style>');
  add(doc, turn('dynamic-visible', 'Group question', '<div data-dil-source-message-id="fixture-source"><div class="renderer-source"><p>PRIVATE SOURCE</p><span data-dil-render-failed>无法加载此回复</span></div><div class="renderer-helper"><span>PRIVATE HELPER</span></div><p>Visible renderer answer.</p><pre><code class="language-js">const ready = true;<span class="renderer-source">PRIVATE CODE SOURCE</span><span class="renderer-helper">PRIVATE CODE HELPER</span></code></pre></div>'));
  const user = findSubmittedUser(doc, before, 'Group question');
  const result = finalCandidate(doc, before, user);
  assert.equal(result.text, 'Visible renderer answer.\n\n```js\nconst ready = true;\n```');
  assert.doesNotMatch(result.text, /PRIVATE|无法加载/);
});

test('detached renderer fragments remain extractable without relaxing live-page visibility', () => {
  const doc = page();
  const fragment = doc.createElement('section');
  fragment.innerHTML = '<div data-dil-message-id="detached-fixture"><p>Detached visible answer.</p><div style="display:none"><span>PRIVATE SOURCE</span></div><pre><code>visible<span style="visibility:hidden">PRIVATE HELPER</span></code></pre></div>';
  assert.equal(visible(fragment), false);
  assert.equal(markdownText(fragment), 'Detached visible answer.\n\n```\nvisible\n```');
  const hiddenFragment = fragment.cloneNode(true);
  hiddenFragment.style.display = 'none';
  assert.equal(markdownText(hiddenFragment), '');
});

test('lazy history prepended before the baseline anchor is not a newly submitted user turn', () => {
  const doc = page(turn('anchor', 'Initialization', '<p>Ready.</p>'));
  const before = snapshot(doc);
  doc.querySelector('main').insertAdjacentHTML('afterbegin', turn('older', '1', '<p>Historical answer.</p>'));
  assert.deepEqual(newUsers(doc, before), []);
  assert.equal(findSubmittedUser(doc, before, 'Group question'), null);
  add(doc, turn('submitted', 'Group question', '<p>Current answer.</p>'));
  const user = findSubmittedUser(doc, before, 'Group question');
  // A further old turn arrives while this answer is being collected.
  doc.querySelector('main').insertAdjacentHTML('afterbegin', turn('even-older', 'Group question', '<p>Do not forward this older answer.</p>'));
  assert.equal(newUsers(doc, before).length, 1);
  assert.equal(finalCandidate(doc, before, user).text, 'Current answer.');
});

test('the anchor ignores older history without hiding a genuinely second new user turn', () => {
  const doc = page(turn('anchor', 'Initialization', '<p>Ready.</p>'));
  const before = snapshot(doc);
  add(doc, turn('submitted', 'Group question', '<p>Current answer.</p>'));
  const user = findSubmittedUser(doc, before, 'Group question');
  doc.querySelector('main').insertAdjacentHTML('afterbegin', turn('older', '1', '<p>Old answer.</p>'));
  add(doc, turn('manual-new', 'Human question', '', 'cancelled'));
  assert.equal(newUsers(doc, before).length, 2);
  assert.throws(() => findSubmittedUser(doc, before, 'Group question'), /其他新消息/);
  assert.throws(() => finalCandidate(doc, before, user), /其他消息/);
});

test('a missing nonempty baseline anchor fails instead of guessing another history boundary', () => {
  const doc = page(turn('earlier', 'Earlier question', '<p>Earlier answer.</p>') + turn('anchor', 'Initialization', '<p>Ready.</p>'));
  const before = snapshot(doc);
  add(doc, turn('submitted', 'Group question', '<p>Current answer.</p>'));
  const user = findSubmittedUser(doc, before, 'Group question');
  doc.querySelector('[data-turn-key="turn-anchor"]').remove();
  assert.throws(() => newUsers(doc, before), error => error.name === 'PageSafetyError' && /基准已消失/.test(error.message));
  assert.throws(() => findSubmittedUser(doc, before, 'Group question'), /基准已消失/);
  assert.throws(() => finalCandidate(doc, before, user), /基准已消失/);
});

test('stable user identities survive virtual DOM replacement and history search renumbering', () => {
  const doc = page(turn('anchor', 'Initialization', '<p>Ready.</p>'));
  const before = snapshot(doc);
  const anchor = doc.querySelector('[data-turn-key="turn-anchor"]');
  const replacement = anchor.cloneNode(true);
  replacement.querySelectorAll('[data-chatgpt-search-message-ids]').forEach(node => {
    node.setAttribute('data-chatgpt-search-message-ids', node.getAttribute('data-chatgpt-search-message-ids').split(' ')[0]);
    node.setAttribute('data-chatgpt-search-unit-key', node.getAttribute('data-chatgpt-search-unit-key').replace('fixture-', 'renumbered-'));
  });
  anchor.replaceWith(replacement);
  add(doc, turn('submitted', 'Group question', '<p>Current answer.</p>'));
  const user = findSubmittedUser(doc, before, 'Group question');
  const submitted = user.closest('[data-turn-key]');
  submitted.replaceWith(submitted.cloneNode(true));
  assert.equal(user.isConnected, false);
  assert.equal(finalCandidate(doc, before, user).text, 'Current answer.');
});

test('confirmed prompt text remains authoritative when the same user ID is edited or replaced', () => {
  for (const replacement of [false, true]) {
    const doc = page(); const baseline = snapshot(doc);
    add(doc, turn('submitted', 'Group question', '<p>Current answer.</p>'));
    const user = findSubmittedUser(doc, baseline, 'Group question');
    if (replacement) user.replaceWith(user.cloneNode(true));
    doc.querySelector('[data-user-message-bubble="true"]').textContent = 'Edited private question';
    assert.throws(() => finalCandidate(doc, baseline, user), /内容被替换/);
    assert.throws(() => findSubmittedUser(doc, baseline, 'Edited private question'), /内容被替换/, 'the same baseline cannot be rebound to an edited prompt');
  }
});
