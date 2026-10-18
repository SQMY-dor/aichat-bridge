import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as dom from '../extension/claude-dom.js';

const fixture = await readFile(new URL('./fixtures/claude-conversation.html', import.meta.url), 'utf8');
const clipboardAttachment = await readFile(new URL('./fixtures/claude-clipboard-attachment.html', import.meta.url), 'utf8');
const prefixedAttachment = await readFile(new URL('./fixtures/claude-prefixed-attachment.html', import.meta.url), 'utf8');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
function page() { return new JSDOM(fixture, { url: 'https://claude.ai/chat/11111111-1111-4111-8111-111111111111' }).window.document; }
function user(text = 'Question') { return `<div data-testid="transcript-row" data-perf-row="user"><div data-testid="user-message"><p>${text}</p></div></div>`; }
function answer(body = '<p>Final answer</p>', { streaming = 'false', actions = true } = {}) {
  return `<div data-testid="transcript-row" data-perf-row="assistant" data-perf-row-streaming="${streaming}"><div class="group group/message-row"><div class="contents"><div data-testid="assistant-message" data-is-streaming="${streaming}"><div class="font-claude-response"><div data-testid="TurnStatus" data-state="done"><div data-perf-reply-text class="standard-markdown">PRIVATE THOUGHT</div></div><div data-cds="Prose"><div data-perf-reply-text class="standard-markdown">${body}</div></div></div></div></div>${actions ? '<div data-testid="message-actions" role="toolbar"><button data-testid="action-bar-copy">Copy</button><button data-testid="action-bar-retry">Retry</button></div>' : ''}</div></div>`;
}
function add(doc, html) { doc.querySelector('main').insertAdjacentHTML('beforeend', html); }
function submitted(doc) { const baseline = dom.snapshot(doc); add(doc, user()); return { baseline, user: dom.findSubmittedUser(doc, baseline, 'Question') }; }
function loaded(image, state = {}) { Object.defineProperties(image, Object.fromEntries(Object.entries({ complete: true, naturalWidth: 640, naturalHeight: 480, ...state }).map(([key, value]) => [key, { configurable: true, value }]))); }
const candidate = (doc, state) => dom.finalCandidate(doc, state.baseline, state.user);

test('verified Claude composer structure is required and controls remain in its own scope', () => {
  const doc = page(); const input = dom.assertReady(doc);
  assert.equal(input.dataset.testid, 'chat-input');
  doc.body.insertAdjacentHTML('beforeend', '<button data-testid="chat-input-send">Unrelated</button>');
  assert.equal(dom.sendButton(doc, input).getAttribute('aria-label'), '发送消息');
  assert.equal(dom.composerInteraction(doc.querySelector('[data-testid="chat-input-send"]'), input), true);
  input.textContent = 'Private draft'; assert.throws(() => dom.assertReady(doc), /草稿/);
  assert.throws(() => dom.insertPrompt(doc, input, 'overwrite'), /草稿/); assert.equal(input.textContent, 'Private draft');
  input.textContent = ''; input.setAttribute('data-testid', 'unknown-editor');
  assert.throws(() => dom.composer(doc), /暂未找到 Claude 输入框，等待网页加载/);
});

test('Claude distinguishes a temporarily absent editor from multiple visible editors without relaxing hidden-copy checks', () => {
  const doc = page(); const input = dom.composer(doc);
  input.hidden = true;
  assert.throws(() => dom.composer(doc), { name: 'PageSafetyError', message: '暂未找到 Claude 输入框，等待网页加载' });
  input.hidden = false; const duplicate = input.cloneNode(true); input.after(duplicate);
  assert.throws(() => dom.composer(doc), { name: 'PageSafetyError', message: '检测到多个可见的 Claude 输入框，暂不自动操作' });
  duplicate.hidden = true;
  assert.throws(() => dom.composer(doc), /输入区结构已变化/);
  duplicate.remove(); assert.equal(dom.composer(doc), input);
  doc.body.insertAdjacentHTML('beforeend', '<div id="challenge-running"></div>');
  assert.throws(() => dom.assertReady(doc), /网页正在验证，请先手动完成验证/);
});

test('Claude refuses duplicate editors, missing composer boundaries, blocked inputs and challenges', () => {
  for (const change of [doc => dom.composer(doc).insertAdjacentHTML('afterend', '<div data-testid="chat-input" contenteditable="true"></div>'), doc => doc.querySelector('[data-cds="ChatComposer"]').removeAttribute('data-cds'), doc => dom.composer(doc).setAttribute('aria-disabled', 'true'), doc => doc.body.insertAdjacentHTML('beforeend', '<div id="challenge-running"></div>')]) {
    const doc = page(); change(doc); assert.throws(() => dom.assertReady(doc), { name: 'PageSafetyError' });
  }
});

test('Claude inherited disabled send controls cannot be selected or clicked', () => {
  for (const disabled of ['fieldset', 'aria-parent', 'inert-parent']) {
    const doc = page(); const input = dom.composer(doc); const button = dom.sendButton(doc, input);
    let clicks = 0; button.addEventListener('click', () => { clicks++; });
    if (disabled === 'fieldset') {
      button.closest('fieldset').disabled = true;
      assert.equal(button.disabled, false);
      assert.equal(button.matches(':disabled'), true);
      button.click(); assert.equal(clicks, 0);
    } else {
      const wrapper = doc.createElement('span'); button.before(wrapper); wrapper.append(button);
      wrapper.setAttribute(disabled === 'aria-parent' ? 'aria-disabled' : 'inert', 'true');
    }
    assert.equal(dom.sendButton(doc, input), null, disabled);
  }
});

test('Claude final output belongs only to the submitted turn and excludes thinking and action text', () => {
  const doc = page(); const state = submitted(doc); add(doc, answer('<h2>Answer</h2><p><strong>Done</strong> <a href="https://example.com">reference</a>.</p><pre><code class="language-js">const x = 1;\n</code></pre>'));
  const result = candidate(doc, state);
  assert.match(result.text, /## Answer/); assert.match(result.text, /\*\*Done\*\*/);
  assert.match(result.text, /\[reference\]\(https:\/\/example.com\)/); assert.match(result.text, /```js\nconst x = 1;\n```/);
  assert.doesNotMatch(result.text, /Earlier|PRIVATE|Copy|Retry/); assert.deepEqual(result.images, []);
});

test('Claude extraction preserves live ancestor-dependent visibility when stripping thinking', () => {
  const doc = page(); const state = submitted(doc);
  doc.head.insertAdjacentHTML('beforeend', '<style>[data-cds="Prose"] .private-helper { display: none; }</style>');
  add(doc, answer('<p>Public answer<span class="private-helper">PRIVATE HIDDEN HELPER</span></p><div data-testid="TurnStatus">PRIVATE NESTED THOUGHT</div>'));
  assert.equal(candidate(doc, state).text, 'Public answer');
});

test('Claude requires explicit stopped-stream state and both scoped completion actions', () => {
  for (const change of [doc => dom.turns(doc, 'assistant').at(-1).setAttribute('data-is-streaming', 'true'), doc => dom.turns(doc, 'assistant').at(-1).removeAttribute('data-is-streaming'), doc => doc.querySelector('main').lastElementChild.setAttribute('data-perf-row-streaming', 'true'), doc => doc.querySelector('main').lastElementChild.querySelector('[data-testid="action-bar-retry"]').remove(), doc => doc.querySelector('main').lastElementChild.querySelector('[data-testid="message-actions"]').hidden = true, doc => doc.querySelector('[data-cds="ChatComposer"]').insertAdjacentHTML('beforeend', '<button data-testid="chat-input-stop"></button>')]) {
    const doc = page(); const state = submitted(doc); add(doc, answer()); change(doc); assert.equal(candidate(doc, state), null);
  }
  const doc = page(); const state = submitted(doc); add(doc, answer('<pre><code>partial</code><button data-testid="action-bar-copy">Copy</button><button data-testid="action-bar-retry">Retry</button></pre>', { actions: false }));
  assert.equal(candidate(doc, state), null);
});

test('Claude pending user, incomplete response and rendering errors block leases or final forwarding', () => {
  const doc = page(); const state = submitted(doc); assert.throws(() => dom.assertReady(doc), /尚未明确完成/);
  add(doc, answer('partial', { actions: false })); assert.throws(() => dom.assertReady(doc), /尚未明确完成/);
  dom.turns(doc, 'assistant').at(-1).insertAdjacentHTML('beforeend', '<div role="alert">Failed</div>');
  assert.throws(() => candidate(doc, state), /回复失败/);
});

test('Claude hidden stale error UI does not leave a completed response waiting forever', () => {
  for (const hidden of ['hidden', 'style', 'aria-hidden']) {
    const doc = page(); const state = submitted(doc); add(doc, answer());
    const message = dom.turns(doc, 'assistant').at(-1);
    const error = doc.createElement('div'); error.setAttribute('role', 'alert'); error.textContent = 'stale error';
    if (hidden === 'style') error.style.display = 'none'; else error.setAttribute(hidden, 'true');
    message.append(error);
    assert.equal(candidate(doc, state)?.text, 'Final answer', hidden);
    assert.equal(dom.assertReady(doc), dom.composer(doc));
    error.removeAttribute('hidden'); error.removeAttribute('aria-hidden'); error.removeAttribute('style');
    assert.throws(() => candidate(doc, state), /回复失败/);
    assert.throws(() => dom.assertReady(doc), /尚未明确完成/);
  }
});

test('Claude prompt mismatch, edited submitted turn and human collisions never forward', () => {
  const doc = page(); const baseline = dom.snapshot(doc); add(doc, user('Different'));
  assert.throws(() => dom.findSubmittedUser(doc, baseline, 'Question'), /不同/);
  const submittedUser = dom.findSubmittedUser(doc, baseline, 'Different'); add(doc, answer());
  submittedUser.textContent = 'Changed after submission';
  assert.throws(() => dom.finalCandidate(doc, baseline, submittedUser), /内容被替换/);
  add(doc, user('Human turn')); assert.throws(() => dom.findSubmittedUser(doc, baseline, 'Question'), /其他新消息/);
});

test('Claude waits for an empty new user row to render before confirming exact text', () => {
  const doc = page(); const baseline = dom.snapshot(doc); add(doc, user(''));
  assert.equal(dom.findSubmittedUser(doc, baseline, 'Question'), null);
  assert.equal(baseline.submittedText, undefined);
  const current = dom.turns(doc, 'user').at(-1);
  current.querySelector('p').textContent = 'Question';
  assert.equal(dom.findSubmittedUser(doc, baseline, 'Question'), current);
  current.querySelector('p').textContent = 'Other';
  assert.throws(() => dom.findSubmittedUser(doc, baseline, 'Question'), /不同/);
});

test('Claude confirms and reads a background turn from its prompt DOM when rendered innerText is empty', () => {
  const doc = page(); const baseline = dom.snapshot(doc);
  Object.defineProperties(doc, { hidden: { value: true, configurable: true }, visibilityState: { value: 'hidden', configurable: true } });
  doc.hasFocus = () => false;
  add(doc, user('first line</p><p>second<br>third'));
  const current = dom.turns(doc, 'user').at(-1), prompt = 'first line\nsecond\nthird';
  Object.defineProperty(current, 'innerText', { value: '', configurable: true });
  assert.equal(dom.findSubmittedUser(doc, baseline, prompt), current);
  add(doc, answer('<p>Background answer</p>'));
  const message = dom.turns(doc, 'assistant').at(-1);
  const row = message.closest('[data-testid="transcript-row"]');
  row.style.contentVisibility = 'auto';
  row.querySelector('[data-testid="message-actions"]').style.opacity = '0';
  Object.defineProperty(message, 'innerText', { value: '', configurable: true });
  assert.equal(dom.finalCandidate(doc, baseline, current)?.text, 'Background answer');
  current.querySelector('p').textContent = 'Changed';
  assert.throws(() => dom.finalCandidate(doc, baseline, current), /内容被替换/);
});

test('Claude history loading preserves the anchor, but replacement without a stable identity fails closed', () => {
  const doc = page(); const state = submitted(doc);
  doc.querySelector('main').insertAdjacentHTML('afterbegin', user('Prepended history'));
  add(doc, answer()); assert.equal(candidate(doc, state).text, 'Final answer');
  const old = dom.turns(doc, 'user')[1]; old.replaceWith(old.cloneNode(true));
  assert.throws(() => candidate(doc, state), /基准已消失/);
});

test('Claude multiple assistant messages and multiple public prose bodies remain ambiguous', () => {
  const doc = page(); const state = submitted(doc); add(doc, answer()); add(doc, answer('Another answer')); assert.equal(candidate(doc, state), null);
  doc.querySelector('main').lastElementChild.remove();
  dom.turns(doc, 'assistant').at(-1).insertAdjacentHTML('beforeend', '<div data-perf-reply-text class="standard-markdown">Another public body</div>');
  assert.equal(candidate(doc, state), null);
});

test('Claude supports only actual loaded attached response images from its own origin', async () => {
  const doc = page(); const state = submitted(doc); add(doc, answer('<p>Attached chart</p><img src="https://claude.ai/api/organizations/test/files/chart/preview">'));
  const image = doc.querySelector('main').lastElementChild.querySelector('img'); loaded(image, { complete: false }); assert.equal(candidate(doc, state), null);
  loaded(image); const result = candidate(doc, state); assert.equal(result.images.length, 1);
  const payload = await dom.readAnswerImage(result.images[0], { fetchImpl: async (source, options) => {
    assert.equal(source, image.src); assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error');
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  } });
  assert.equal(payload.base64, png.toString('base64'));
  image.src = 'https://chatgpt.com/backend-api/image'; assert.throws(() => candidate(doc, state), /来源不受支持/);
  for (const source of ['blob:https://chatgpt.com/image', 'https://claude.ai.evil.test/image', 'https://user:pass@claude.ai/image', 'https://claude.ai:8443/image', 'http://claude.ai/image', 'data:image/png;base64,AA==']) assert.throws(() => dom.answerImageSource(source), /来源不受支持/);
  assert.equal(dom.answerImageSource('blob:https://claude.ai/image'), 'blob:https://claude.ai/image');
});

test('Claude image readers reject format mismatch, redirect/fetch failure, oversize and timeouts', async () => {
  const image = { src: 'https://claude.ai/api/files/example' };
  await assert.rejects(dom.readAnswerImage(image, { fetchImpl: async () => new Response('not png', { headers: { 'content-type': 'image/png' } }) }), /格式不一致/);
  await assert.rejects(dom.readAnswerImage(image, { fetchImpl: async () => { throw new Error('redirect'); } }), /无法读取/);
  await assert.rejects(dom.readAnswerImage(image, { fetchImpl: async () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(dom.MAX_IMAGE_BYTES + 1) } }) }), /超过 10 MB/);
  await assert.rejects(dom.readAnswerImage(image, { fetchImpl: async () => new Promise(() => {}), timeoutMs: 2 }), /超时/);
});

function attachment(doc, name, { pending = false, scope = doc.querySelector('[data-cds="ChatComposer"]') } = {}) {
  scope.insertAdjacentHTML('afterbegin', `<div data-testid="attachment-preview"><img alt="${name}" src="blob:https://claude.ai/${name}"><span>${name}</span><button aria-label="Remove attachment"></button>${pending ? '<div role="progressbar"></div>' : ''}</div>`);
  loaded(scope.querySelector('img'));
}
function outerComposer(doc, id) {
  const scope = doc.querySelector('[data-cds="ChatComposer"]');
  const existing = scope.closest('fieldset[data-perf-region="composer"]');
  if (existing) { existing.querySelector('input[type="file"]').id = id; return existing; }
  const fieldset = doc.createElement('fieldset');
  fieldset.setAttribute('data-perf-region', 'composer'); fieldset.setAttribute('data-cds-dock-group', '');
  // Observed on both conversation and new-chat pages. Attachment previews added
  // by these tests remain modeled; the outer file-input boundary is captured.
  fieldset.innerHTML = `<div data-cds-dock-group><input id="${id}" data-testid="file-upload" type="file" multiple accept="" aria-hidden="true" aria-label="上传文件"><div role="status" aria-live="polite"></div><div role="status" aria-live="polite"></div><div data-composer-card-holder></div></div>`;
  scope.before(fieldset); fieldset.querySelector('[data-composer-card-holder]').append(scope);
  return fieldset;
}
function nativeSelection(doc) {
  const field = doc.querySelector('input[data-testid="file-upload"]'); let files = [];
  doc.defaultView.DataTransfer = class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } };
  // jsdom lacks a constructible native FileList; model its assignment boundary
  // while exercising the production native-input selection and event logic.
  Object.defineProperty(field, 'files', { configurable: true, get: () => files, set: value => { files = [...value]; } });
  return { field, get files() { return files; }, set files(value) { files = value; } };
}
const imagePayload = () => ({ mimeType: 'image/png', base64: png.toString('base64') });

test('Claude native file upload uses the observed hidden input once and requires UI confirmation', () => {
  for (const id of ['chat-input-file-upload-bottom', 'chat-input-file-upload-onpage']) {
    const doc = page(); outerComposer(doc, id); const input = dom.composer(doc); const selected = nativeSelection(doc);
    const events = []; let pastes = 0; let focuses = 0;
    input.addEventListener('paste', () => pastes++); input.focus = () => focuses++;
    for (const type of ['input', 'change']) selected.field.addEventListener(type, event => events.push({ type, bubbles: event.bubbles, names: [...selected.field.files].map(file => file.name) }));
    dom.attachInputImage(doc, input, imagePayload(), 'bridge-one.png');
    assert.deepEqual(events, [{ type: 'input', bubbles: true, names: ['bridge-one.png'] }, { type: 'change', bubbles: true, names: ['bridge-one.png'] }]);
    assert.equal(selected.files[0].size, png.length); assert.equal(selected.files[0].type, 'image/png');
    assert.equal(dom.inputAttachmentState(input, ['bridge-one.png']).ready, false, 'FileList assignment is not an acknowledged attachment');
    attachment(doc, 'bridge-one.png'); assert.equal(dom.inputAttachmentState(input, ['bridge-one.png']).ready, true);
    dom.attachInputImage(doc, input, imagePayload(), 'bridge-two.png');
    assert.deepEqual(selected.files.map(file => file.name), ['bridge-two.png'], 'previous files are not replayed');
    assert.equal(dom.inputAttachmentState(input, ['bridge-one.png', 'bridge-two.png']).ready, false);
    attachment(doc, 'bridge-two.png'); assert.equal(dom.inputAttachmentState(input, ['bridge-one.png', 'bridge-two.png']).ready, true);
    selected.files = []; assert.equal(dom.inputAttachmentState(input, ['bridge-one.png', 'bridge-two.png']).ready, true, 'the page may clear its native selection');
    assert.throws(() => dom.attachInputImage(doc, input, imagePayload(), 'bridge-two.png'), /名称重复/);
    assert.equal(events.length, 4); assert.equal(pastes, 0); assert.equal(focuses, 0);
    dom.releaseInputImages(input);
  }
});

test('Claude native upload refuses missing, disabled, foreign or ambiguous file entries without paste fallback', () => {
  for (const change of [
    (doc, field) => field.remove(),
    (doc, field) => { field.id = 'unknown-file-input'; },
    (doc, field) => field.removeAttribute('data-testid'),
    (doc, field) => field.removeAttribute('multiple'),
    (doc, field) => field.after(field.cloneNode(true)),
    (doc, field) => { field.disabled = true; },
    (doc, field) => { field.closest('fieldset').disabled = true; },
    (doc, field) => field.setAttribute('inert', ''),
    (doc, field) => field.setAttribute('aria-disabled', 'true'),
    (doc, field) => doc.body.append(field),
    (doc, field) => { const scope = dom.composerScope(dom.composer(doc)); scope.closest('fieldset').replaceWith(scope); },
  ]) {
    const doc = page(); const input = dom.composer(doc); const selected = nativeSelection(doc); let events = 0; let pastes = 0;
    input.addEventListener('paste', () => pastes++);
    for (const type of ['input', 'change']) selected.field.addEventListener(type, () => events++);
    change(doc, selected.field);
    assert.throws(() => dom.attachInputImage(doc, input, imagePayload(), 'bridge-one.png'), { name: 'PageSafetyError' });
    assert.equal(events, 0); assert.equal(pastes, 0); assert.equal(selected.files.length, 0);
  }
});

test('Claude native upload preserves preexisting drafts and files and rejects replaced same-name selections', () => {
  for (const existing of ['draft', 'file']) {
    const doc = page(); const input = dom.composer(doc); const selected = nativeSelection(doc); let changes = 0;
    selected.field.addEventListener('change', () => changes++);
    const humanFile = new doc.defaultView.File([png], 'bridge-one.png', { type: 'image/png' });
    if (existing === 'draft') input.textContent = 'Human draft'; else selected.files = [humanFile];
    assert.throws(() => dom.attachInputImage(doc, input, imagePayload(), 'bridge-one.png'), { name: 'PageSafetyError' });
    assert.equal(changes, 0);
    if (existing === 'draft') assert.equal(dom.composerText(input), 'Human draft'); else assert.equal(selected.files[0], humanFile);
  }
  const doc = page(); const input = dom.composer(doc); const selected = nativeSelection(doc);
  dom.attachInputImage(doc, input, imagePayload(), 'bridge-one.png'); attachment(doc, 'bridge-one.png');
  assert.equal(dom.inputAttachmentState(input, ['bridge-one.png']).ready, true);
  selected.files = [new doc.defaultView.File([png], 'bridge-one.png', { type: 'image/png' })];
  assert.throws(() => dom.inputAttachmentState(input, ['bridge-one.png']), /不属于本次任务/);
  assert.throws(() => dom.attachInputImage(doc, input, imagePayload(), 'bridge-two.png'), /不属于本次任务/);
  dom.releaseInputImages(input);
});

test('Claude file selection stops if its input event replaces the file field or composer without dispatching change', () => {
  for (const mutation of ['file', 'composer', 'duplicate']) {
    const doc = page(); const input = dom.composer(doc); const selected = nativeSelection(doc); const events = []; let pastes = 0;
    input.addEventListener('paste', () => pastes++);
    selected.field.addEventListener('input', () => {
      events.push('input');
      if (mutation === 'file') selected.field.replaceWith(selected.field.cloneNode(true));
      if (mutation === 'composer') input.replaceWith(input.cloneNode(true));
      if (mutation === 'duplicate') selected.field.after(selected.field.cloneNode(true));
    });
    selected.field.addEventListener('change', () => events.push('change'));
    assert.throws(() => dom.attachInputImage(doc, input, imagePayload(), 'bridge-one.png'), { name: 'PageSafetyError' });
    assert.deepEqual(events, ['input']); assert.equal(pastes, 0);
    dom.releaseInputImages(input);
  }
});

test('Claude input handlers cannot substitute a foreign, same-name, previous or multiple files before change', () => {
  for (const mutation of ['foreign', 'same-name', 'previous', 'multiple']) {
    const doc = page(); const input = dom.composer(doc); const selected = nativeSelection(doc); let changes = 0; let pastes = 0;
    input.addEventListener('paste', () => pastes++);
    selected.field.addEventListener('change', () => changes++);
    dom.attachInputImage(doc, input, imagePayload(), 'bridge-one.png'); attachment(doc, 'bridge-one.png');
    assert.equal(dom.inputAttachmentState(input, ['bridge-one.png']).ready, true);
    const previous = selected.files[0];
    selected.field.addEventListener('input', () => {
      const current = selected.files[0];
      if (mutation === 'foreign') selected.files = [new doc.defaultView.File([png], 'human.png', { type: 'image/png' })];
      if (mutation === 'same-name') selected.files = [new doc.defaultView.File([png], current.name, { type: 'image/png' })];
      if (mutation === 'previous') selected.files = [previous];
      if (mutation === 'multiple') selected.files = [current, current];
    });
    assert.throws(() => dom.attachInputImage(doc, input, imagePayload(), 'bridge-two.png'), /文件选择在上传期间发生变化/);
    assert.equal(changes, 1, 'the second selection never reaches change'); assert.equal(pastes, 0);
    dom.releaseInputImages(input);
  }
});

test('Claude may consume the selected file during input without the bridge restoring it before change', () => {
  const doc = page(); const input = dom.composer(doc); const selected = nativeSelection(doc); const events = [];
  selected.field.addEventListener('input', () => { events.push('input'); selected.files = []; });
  selected.field.addEventListener('change', () => { events.push('change'); assert.equal(selected.files.length, 0); });
  dom.attachInputImage(doc, input, imagePayload(), 'bridge-one.png');
  assert.deepEqual(events, ['input', 'change']); assert.equal(selected.files.length, 0);
  assert.equal(dom.inputAttachmentState(input, ['bridge-one.png']).ready, false);
  dom.releaseInputImages(input);
});

test('Claude cancelled or subsequently replaced native uploads never gain confirmation from their FileList', () => {
  const doc = page(); const input = dom.composer(doc); const selected = nativeSelection(doc); let changes = 0; let pastes = 0;
  input.addEventListener('paste', () => pastes++); selected.field.addEventListener('change', () => { changes++; selected.files = []; });
  dom.attachInputImage(doc, input, imagePayload(), 'bridge-one.png');
  selected.field.dispatchEvent(new doc.defaultView.Event('cancel', { bubbles: true }));
  assert.equal(dom.inputAttachmentState(input, ['bridge-one.png']).ready, false);
  assert.equal(changes, 1); assert.equal(pastes, 0);
  selected.field.replaceWith(selected.field.cloneNode(true));
  assert.throws(() => dom.inputAttachmentState(input, ['bridge-one.png']), /入口已被替换/);
  dom.releaseInputImages(input);
});

test('Claude attachment checks include the verified conversation and new-chat composer fieldsets', () => {
  for (const id of ['chat-input-file-upload-bottom', 'chat-input-file-upload-onpage']) {
    const doc = page(); const fieldset = outerComposer(doc, id); const input = dom.assertReady(doc);
    const field = fieldset.querySelector('input[type="file"]');
    assert.equal(dom.composerScope(input).contains(field), false);
    Object.defineProperty(field, 'files', { configurable: true, value: [new doc.defaultView.File([png], 'human.png', { type: 'image/png' })] });
    assert.equal(dom.hasAttachments(input), true); assert.throws(() => dom.assertReady(doc), /附件/);
    assert.equal(dom.inputAttachmentState(input, []).ready, false);
    Object.defineProperty(field, 'files', { configurable: true, value: [] });
    attachment(doc, 'bridge-test.png', { scope: fieldset.firstElementChild, pending: true });
    assert.equal(dom.hasAttachments(input), true); assert.equal(dom.inputAttachmentState(input, ['bridge-test.png']).ready, false);
    assert.equal(dom.composerInteraction(fieldset.querySelector('button[aria-label="Remove attachment"]'), input), true);
    fieldset.querySelector('[role="progressbar"]').remove();
    assert.equal(dom.inputAttachmentState(input, ['bridge-test.png']).ready, true);
    fieldset.insertAdjacentHTML('beforeend', '<div role="alert">Upload failed</div>');
    assert.throws(() => dom.inputAttachmentState(input, ['bridge-test.png']), /上传失败/);
  }
});

test('Claude outer attachment scope excludes unrelated page files and refuses ambiguous composer boundaries', () => {
  const doc = page(); const fieldset = outerComposer(doc, 'chat-input-file-upload-bottom'); const input = dom.composer(doc);
  doc.body.insertAdjacentHTML('beforeend', '<div data-testid="attachment-preview"><img src="https://claude.ai/history.png"><button aria-label="Remove attachment"></button></div>');
  assert.equal(dom.hasAttachments(input), false); assert.equal(dom.inputAttachmentState(input, []).ready, true);
  fieldset.insertAdjacentHTML('beforeend', '<div data-cds="ChatComposer"></div>');
  assert.throws(() => dom.composer(doc), /结构已变化/); assert.equal(dom.hasAttachments(input), true);
  fieldset.lastElementChild.remove();
  fieldset.insertAdjacentHTML('beforeend', '<div data-testid="transcript-row"><div data-testid="user-message">Earlier image</div></div>');
  assert.throws(() => dom.composer(doc), /结构已变化/);
  assert.throws(() => dom.inputAttachmentState(input, ['bridge-test.png']), /无法确认/);
});

test('captured Claude clipboard attachment requires its exact renamed filename despite a loaded thumbnail', () => {
  const doc = page(); const input = dom.composer(doc); const scope = dom.composerScope(input);
  scope.insertAdjacentHTML('afterbegin', clipboardAttachment);
  const image = scope.querySelector('img'); loaded(image);
  assert.equal(image.alt, ''); assert.equal(scope.querySelector('[data-cds-attachment-remove]').style.opacity, '0');
  assert.equal(dom.hasAttachments(input), true);
  assert.equal(dom.inputAttachmentState(input, ['1700000000000_clipboard.png']).ready, true);
  assert.equal(dom.inputAttachmentState(input, ['bridge-fixture-1.png']).ready, false);
  loaded(image, { complete: false });
  assert.equal(dom.inputAttachmentState(input, ['1700000000000_clipboard.png']).ready, false);
});

function clipboardUpload(doc, { bytes = png, name = 'bridge-fixture-1.png', stamp = '1700000000000', source = 'blob:https://claude.ai/00000000-0000-4000-8000-000000000001', prefixed = false } = {}) {
  const input = dom.composer(doc); const win = doc.defaultView;
  win.DataTransfer = class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } };
  win.ClipboardEvent = class extends win.Event { constructor(type, options) { super(type, options); this.clipboardData = options.clipboardData; } };
  dom.pasteInputImage(doc, input, { mimeType: 'image/png', base64: bytes.toString('base64') }, name);
  const html = prefixed ? prefixedAttachment.replaceAll('bridge-fixture-1.png', name) : clipboardAttachment;
  dom.composerScope(input).insertAdjacentHTML('afterbegin', html.replaceAll('1700000000000', stamp).replace('blob:https://claude.ai/00000000-0000-4000-8000-000000000000', source));
  const card = dom.composerScope(input).querySelector('[data-cds="MessageAttachmentsImage"]'); loaded(card.querySelector('img'));
  return { input, card, source, name };
}
const settleClipboardRead = () => new Promise(resolve => setImmediate(resolve));

test('observed Claude timestamp-prefixed original names require matching registered bytes for one through four images', async () => {
  for (let count = 1; count <= 4; count++) {
    const doc = page(); outerComposer(doc, 'chat-input-file-upload-bottom'); const reads = []; const expected = new Map(); const names = [];
    doc.defaultView.fetch = async (source, options) => { reads.push(source); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); return new Response(expected.get(source)); };
    for (let index = 1; index <= count; index++) {
      const bytes = Buffer.from([...png, index]); const source = `blob:https://claude.ai/prefixed-${index}`;
      expected.set(source, bytes);
      const upload = clipboardUpload(doc, { bytes, name: `bridge-fixture-${index}.png`, stamp: `170000000000${index}`, source, prefixed: true });
      names.push(upload.name);
      assert.equal(dom.inputAttachmentState(upload.input, names).reason, 'verifying');
      await settleClipboardRead(); assert.equal(dom.inputAttachmentState(upload.input, names).ready, true);
    }
    assert.deepEqual(reads, [...expected.keys()]);
    dom.releaseInputImages(dom.composer(doc));
    assert.equal(dom.inputAttachmentState(dom.composer(doc), names).ready, false, 'prefixed labels alone cannot reuse released authorization');
  }
});

test('Claude timestamp prefixes cannot authorize another filename, malformed prefixes or unregistered cards', async () => {
  for (const actualName of ['1700000000000_bridge-other.png', '1700000000000_bridge-fixture-1.png.jpg', '1700000000000_other_bridge-fixture-1.png', '123456789_bridge-fixture-1.png', '123456789012345678_bridge-fixture-1.png', 'prefix_bridge-fixture-1.png']) {
    const doc = page(); let reads = 0; doc.defaultView.fetch = async () => { reads++; return new Response(png); };
    const upload = clipboardUpload(doc, { prefixed: true });
    upload.card.querySelector('.sr-only').textContent = actualName;
    upload.card.querySelector('[data-cds-attachment-remove]').setAttribute('aria-label', `移除 ${actualName}`);
    assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, false, actualName);
    await settleClipboardRead(); assert.equal(reads, 0, actualName);
    dom.releaseInputImages(upload.input);
  }
  const doc = page(); let reads = 0; doc.defaultView.fetch = async () => { reads++; return new Response(png); };
  const input = dom.composer(doc); dom.composerScope(input).insertAdjacentHTML('afterbegin', prefixedAttachment);
  loaded(dom.composerScope(input).querySelector('img'));
  assert.equal(dom.inputAttachmentState(input, ['bridge-fixture-1.png']).ready, false);
  await settleClipboardRead(); assert.equal(reads, 0);
});

test('Claude prefixed-name cards still reject different bytes, remote sources and later filename changes', async () => {
  for (const scenario of ['different-bytes', 'remote-source', 'changed-name']) {
    const doc = page(); let reads = 0;
    doc.defaultView.fetch = async () => { reads++; return new Response(scenario === 'different-bytes' ? Buffer.from([...png, 99]) : png); };
    const upload = clipboardUpload(doc, { prefixed: true, ...(scenario === 'remote-source' ? { source: 'https://claude.ai/not-a-local-blob' } : {}) });
    if (scenario === 'remote-source') {
      assert.throws(() => dom.inputAttachmentState(upload.input, [upload.name]), /本地来源/); assert.equal(reads, 0);
    } else {
      assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).reason, 'verifying'); await settleClipboardRead();
      if (scenario === 'different-bytes') assert.throws(() => dom.inputAttachmentState(upload.input, [upload.name]), /内容与原图不同/);
      else {
        assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, true);
        const otherName = '1700000000000_bridge-other.png';
        upload.card.querySelector('.sr-only').textContent = otherName;
        upload.card.querySelector('[data-cds-attachment-remove]').setAttribute('aria-label', `移除 ${otherName}`);
        assert.throws(() => dom.inputAttachmentState(upload.input, [upload.name]), /替换或移除/);
      }
      assert.equal(reads, 1);
    }
    dom.releaseInputImages(upload.input);
  }
});

test('registered renamed Claude clipboard cards require byte identity and keep independent mappings', async () => {
  const doc = page(); const reads = []; const secondBytes = Buffer.from([...png, 4]);
  doc.defaultView.fetch = async (source, options) => {
    reads.push(source); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    return new Response(source.endsWith('2') ? secondBytes : png);
  };
  const first = clipboardUpload(doc);
  assert.deepEqual(dom.inputAttachmentState(first.input, [first.name]), { ready: false, reason: 'verifying' });
  await settleClipboardRead(); assert.equal(dom.inputAttachmentState(first.input, [first.name]).ready, true);
  const second = clipboardUpload(doc, { bytes: secondBytes, name: 'bridge-fixture-2.png', stamp: '1700000000001', source: 'blob:https://claude.ai/00000000-0000-4000-8000-000000000002' });
  const names = [first.name, second.name];
  assert.equal(dom.inputAttachmentState(first.input, names).reason, 'verifying');
  await settleClipboardRead(); assert.equal(dom.inputAttachmentState(first.input, names).ready, true);
  assert.deepEqual(reads, [first.source, second.source]);
  dom.releaseInputImages(first.input);
  assert.equal(dom.inputAttachmentState(first.input, names).ready, false, 'released byte aliases cannot authorize a later run');
});

test('Claude clipboard verification supports mixed exact names and identical-image pairs without merging mappings', async () => {
  for (const modes of [['exact', 'renamed'], ['renamed', 'exact'], ['renamed', 'renamed']]) {
    const doc = page(); const reads = []; const names = [];
    doc.defaultView.fetch = async source => { reads.push(source); return new Response(png); };
    for (const [index, mode] of modes.entries()) {
      const upload = clipboardUpload(doc, { name: `bridge-fixture-${index + 1}.png`, stamp: `170000000000${index}`, source: `blob:https://claude.ai/same-bytes-${index}` });
      names.push(upload.name);
      if (mode === 'exact') {
        upload.card.querySelector('.sr-only').textContent = upload.name;
        upload.card.querySelector('[data-cds-attachment-remove]').setAttribute('aria-label', `移除 ${upload.name}`);
      }
      const state = dom.inputAttachmentState(upload.input, names);
      if (mode === 'renamed') { assert.equal(state.reason, 'verifying'); await settleClipboardRead(); }
      assert.equal(dom.inputAttachmentState(upload.input, names).ready, true, modes.join('/'));
    }
    assert.equal(reads.length, modes.filter(mode => mode === 'renamed').length);
    assert.equal(new Set(reads).size, reads.length);
    dom.releaseInputImages(dom.composer(doc));
  }
});

test('Claude clipboard verification rejects changed bytes and never reads unregistered or remote images', async () => {
  const doc = page(); let reads = 0;
  doc.defaultView.fetch = async () => { reads++; return new Response(Buffer.from([...png.slice(0, -1), 99])); };
  const upload = clipboardUpload(doc);
  assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).reason, 'verifying');
  await settleClipboardRead();
  assert.throws(() => dom.inputAttachmentState(upload.input, [upload.name]), /内容与原图不同/);
  dom.releaseInputImages(upload.input);
  assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, false); assert.equal(reads, 1);
  upload.card.remove();
  const remote = clipboardUpload(doc, { source: 'https://claude.ai/not-a-local-blob' });
  assert.throws(() => dom.inputAttachmentState(remote.input, [remote.name]), /本地来源/); assert.equal(reads, 1);
  dom.releaseInputImages(remote.input);
});

test('Claude clipboard verification rejects replacement, source changes and extra human cards', async () => {
  for (const mutation of ['replace', 'source', 'extra']) {
    const doc = page(); doc.defaultView.fetch = async () => new Response(png);
    const upload = clipboardUpload(doc);
    dom.inputAttachmentState(upload.input, [upload.name]); await settleClipboardRead();
    assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, true);
    if (mutation === 'replace') upload.card.replaceWith(upload.card.cloneNode(true));
    if (mutation === 'source') upload.card.querySelector('img').src = 'blob:https://claude.ai/human-image';
    if (mutation === 'extra') {
      const extra = upload.card.cloneNode(true); loaded(extra.querySelector('img')); upload.card.after(extra);
      assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, false);
    } else assert.throws(() => dom.inputAttachmentState(upload.input, [upload.name]), /替换或移除/);
    dom.releaseInputImages(upload.input);
  }
});

test('releasing Claude input images aborts verification and cannot retain a pending authorization', async () => {
  const doc = page(); let signal;
  doc.defaultView.fetch = async (_source, options) => { signal = options.signal; return new Promise(() => {}); };
  const upload = clipboardUpload(doc);
  assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).reason, 'verifying');
  dom.releaseInputImages(upload.input); await settleClipboardRead();
  assert.equal(signal.aborted, true); assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, false);
});

test('releasing Claude input images cancels an already pending blob stream reader', async () => {
  const doc = page(); let cancelled = 0;
  doc.defaultView.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled++; } }));
  const upload = clipboardUpload(doc);
  assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).reason, 'verifying');
  await settleClipboardRead(); dom.releaseInputImages(upload.input); await settleClipboardRead();
  assert.equal(cancelled, 1); assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, false);
});

test('Claude delayed background image reads cannot outrun the elapsed verification deadline', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const doc = page(); let readCount = 0; let cancelled = 0;
  doc.defaultView.fetch = async () => ({
    ok: true, headers: new Headers(), body: { getReader: () => ({
      async read() {
        if (!readCount++) return { done: false, value: png };
        // Model a suspended tab resuming the read before the timeout callback.
        now += 15001; return { done: true };
      },
      async cancel() { cancelled++; },
    }) },
  });
  const upload = clipboardUpload(doc);
  assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).reason, 'verifying');
  await settleClipboardRead();
  assert.throws(() => dom.inputAttachmentState(upload.input, [upload.name]), /核对 Claude 粘贴图片内容超时/);
  assert.equal(cancelled, 1); dom.releaseInputImages(upload.input);
});

test('modeled Claude attachment contract requires matching names, no extra files and confirmed upload completion', () => {
  const doc = page(); const input = dom.composer(doc); assert.equal(dom.inputAttachmentState(input, ['bridge-test.png']).ready, false);
  attachment(doc, 'bridge-test.png', { pending: true }); assert.throws(() => dom.assertReady(doc), /附件/); assert.equal(dom.inputAttachmentState(input, ['bridge-test.png']).ready, false);
  doc.querySelector('[role="progressbar"]').remove(); assert.equal(dom.inputAttachmentState(input, ['bridge-test.png']).ready, true);
  assert.equal(dom.inputAttachmentState(input, ['other.png']).ready, false);
  attachment(doc, 'human.png'); assert.equal(dom.inputAttachmentState(input, ['bridge-test.png']).ready, false);
  assert.equal(dom.inputAttachmentState(input, ['bridge-test.png', 'human.png']).ready, true);
  doc.querySelector('[data-cds="ChatComposer"]').insertAdjacentHTML('afterbegin', '<div role="alert">Upload failed</div>');
  assert.throws(() => dom.inputAttachmentState(input, ['bridge-test.png', 'human.png']), /上传失败/);
});

test('Claude normal image paste uses validated bytes on the exact editor and does not overwrite a draft', () => {
  const doc = page(); const win = doc.defaultView; const input = dom.composer(doc); let file;
  win.DataTransfer = class { constructor() { this.files = []; this.items = { add: value => this.files.push(value) }; } };
  win.ClipboardEvent = class extends win.Event { constructor(type, options) { super(type, options); this.clipboardData = options.clipboardData; } };
  input.addEventListener('paste', event => { file = event.clipboardData.files[0]; });
  dom.pasteInputImage(doc, input, { mimeType: 'image/png', base64: png.toString('base64') }, 'bridge-test.png');
  assert.equal(file.name, 'bridge-test.png'); assert.equal(file.type, 'image/png'); assert.equal(file.size, png.length);
  assert.equal(dom.composerText(input), '');
  assert.throws(() => dom.pasteInputImage(doc, input, { mimeType: 'image/png', base64: png.toString('base64') }, '../other.png'), /输入目标/);
});
