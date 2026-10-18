import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { conversationUrl, isOptionsSender } from '../extension/shared.js';
import { assertReady, snapshot, findSubmittedUser, finalCandidate, markdownText, sendButton, insertPrompt } from '../extension/dom.js';
function page(extra = '') { return new JSDOM(`<!doctype html><main>${extra}</main><form><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button><button aria-label="Attach files">Attach</button></form>`, { url: 'https://chatgpt.com/c/12345678-abcd' }).window.document; }
function user(id, text) { return `<article data-testid="conversation-turn-${id}"><div data-message-author-role="user" data-message-id="${id}"><div class="whitespace-pre-wrap">${text}</div></div></article>`; }
function assistant(id, body, complete = true) { return `<article data-testid="conversation-turn-${id}"><div data-message-author-role="assistant" data-message-id="${id}">${body}</div>${complete ? '<button data-testid="copy-turn-action-button">Copy</button>' : ''}</article>`; }
function add(doc, html) { doc.querySelector('main').insertAdjacentHTML('beforeend', html); }
test('canonical URLs accept only existing ChatGPT conversations', () => {
  assert.equal(conversationUrl('https://chatgpt.com/g/my-gpt/c/abcdefgh/?model=x#foo'), 'https://chatgpt.com/g/my-gpt/c/abcdefgh');
  for (const url of ['https://chatgpt.com/', 'https://chatgpt.com/c/short', 'https://evil.test/c/abcdefgh', 'https://chatgpt.com.evil.test/c/abcdefgh', 'http://chatgpt.com/c/abcdefgh']) assert.equal(conversationUrl(url), null);
  assert.equal(isOptionsSender({ id: 'ext', url: 'https://chatgpt.com/c/abcdefgh' }, 'ext', 'chrome-extension://ext/options.html'), false);
});
test('drafts, attachments, uploads and existing generation prevent leasing', () => {
  const doc = page(); assert.ok(assertReady(doc));
  doc.querySelector('textarea').value = 'my private draft'; assert.throws(() => assertReady(doc), /草稿/);
  doc.querySelector('textarea').value = ''; doc.querySelector('form').insertAdjacentHTML('beforeend', '<div data-testid="attachment-preview">secret.pdf</div>');
  assert.throws(() => assertReady(doc), /附件/); doc.querySelector('[data-testid="attachment-preview"]').remove();
  doc.querySelector('form').insertAdjacentHTML('beforeend', '<button aria-label="Remove file">x</button>'); assert.throws(() => assertReady(doc), /附件/); doc.querySelector('[aria-label="Remove file"]').remove();
  doc.querySelector('form').insertAdjacentHTML('beforeend', '<button data-testid="stop-button">Stop</button>'); assert.throws(() => assertReady(doc), /生成/);
});
test('ChatGPT distinguishes absent and multiple visible editors while keeping hidden alternatives excluded', () => {
  const doc = page(); const input = doc.querySelector('textarea');
  input.hidden = true;
  assert.throws(() => assertReady(doc), { name: 'PageSafetyError', message: '暂未找到 ChatGPT 输入框，等待网页加载' });
  input.hidden = false; const duplicate = input.cloneNode(true); input.after(duplicate);
  assert.throws(() => assertReady(doc), { name: 'PageSafetyError', message: '检测到多个可见的 ChatGPT 输入框，暂不自动操作' });
  duplicate.hidden = true;
  assert.equal(assertReady(doc), input);
  doc.body.insertAdjacentHTML('beforeend', '<div id="challenge-running"></div>');
  assert.throws(() => assertReady(doc), /网页正在验证，请先手动完成验证/);
});
test('ChatGPT refuses an inert composer or submit-control ancestor until the page reenables it', () => {
  const doc = page(); const input = doc.querySelector('textarea'); const form = doc.querySelector('form');
  form.setAttribute('inert', '');
  assert.throws(() => assertReady(doc), /ChatGPT 输入框当前不可用/);
  assert.equal(sendButton(doc, input), null);
  form.removeAttribute('inert'); assert.equal(assertReady(doc), input);
  const button = sendButton(doc, input); const control = doc.createElement('div');
  button.before(control); control.append(button); control.setAttribute('inert', '');
  assert.equal(assertReady(doc), input); assert.equal(sendButton(doc, input), null);
  control.removeAttribute('inert'); assert.equal(sendButton(doc, input), button);
});

test('native disabled fieldsets and readonly editors cannot authorize input or send', () => {
  const doc = page(); const input = doc.querySelector('textarea'); const form = doc.querySelector('form');
  const fieldset = doc.createElement('fieldset'); fieldset.disabled = true;
  fieldset.append(...form.childNodes); form.append(fieldset);
  assert.equal(input.disabled, false, 'disabled property does not include fieldset state');
  assert.throws(() => assertReady(doc), /输入框当前不可用/);
  assert.throws(() => insertPrompt(doc, input, 'must not write'), /输入框当前不可用/);
  assert.equal(input.value, ''); assert.equal(sendButton(doc, input), null);
  fieldset.disabled = false; input.readOnly = true;
  assert.throws(() => assertReady(doc), /输入框当前不可用/);
  assert.equal(sendButton(doc, input), null);
  input.readOnly = false; assert.equal(assertReady(doc), input);
  form.setAttribute('aria-disabled', 'true');
  assert.throws(() => assertReady(doc), /输入框当前不可用/);
  assert.equal(sendButton(doc, input), null);
});

test('send controls inherit disabled fieldset state without disabling a composer outside it', () => {
  const doc = page(); const input = assertReady(doc); const button = sendButton(doc, input);
  const fieldset = doc.createElement('fieldset'); fieldset.disabled = true;
  button.before(fieldset); fieldset.append(button);
  assert.equal(assertReady(doc), input); assert.equal(button.disabled, false);
  assert.equal(sendButton(doc, input), null);
  fieldset.disabled = false; assert.equal(sendButton(doc, input), button);
});

test('same-ID legacy prompt edits never forward the edited turn answer', () => {
  const doc = page(); const baseline = snapshot(doc);
  add(doc, user('u', 'group question') + assistant('a', '<div class="markdown">answer</div>'));
  const submitted = findSubmittedUser(doc, baseline, 'group question');
  submitted.querySelector('.whitespace-pre-wrap').textContent = 'private edited question';
  assert.throws(() => finalCandidate(doc, baseline, submitted), /内容被替换/);
});
test('normal input event keeps draft safe and send control scoped to the composer', () => {
  const doc = page(); const input = assertReady(doc); let events = 0; input.addEventListener('input', () => events++);
  insertPrompt(doc, input, 'group prompt'); assert.equal(input.value, 'group prompt'); assert.equal(events, 1);
  assert.throws(() => insertPrompt(doc, input, 'overwrite'), /草稿/);
  assert.equal(sendButton(doc, input).dataset.testid, 'send-button');
  doc.querySelector('[data-testid="send-button"]').disabled = true; assert.equal(sendButton(doc, input), null);
});
test('old replies, thinking, and unfinished output are never forwarded', () => {
  const doc = page(user('old-user', 'old question') + assistant('old-assistant', '<div class="markdown">PRIVATE OLD ANSWER</div>'));
  const before = snapshot(doc); add(doc, user('new-user', 'new question'));
  const submitted = findSubmittedUser(doc, before, 'new question');
  assert.equal(finalCandidate(doc, before, submitted), null);
  add(doc, assistant('thinking', '<details open><div class="markdown">PRIVATE REASONING</div></details>'));
  assert.equal(finalCandidate(doc, before, submitted), null);
  add(doc, assistant('final', '<div class="markdown"><p>Final answer</p></div>', false));
  assert.equal(finalCandidate(doc, before, submitted), null);
  doc.querySelector('[data-testid="conversation-turn-final"]').insertAdjacentHTML('beforeend', '<button data-testid="copy-turn-action-button">Copy</button>');
  assert.equal(finalCandidate(doc, before, submitted).text, 'Final answer');
  doc.querySelector('form').insertAdjacentHTML('beforeend', '<button data-testid="stop-button">Stop</button>');
  assert.equal(finalCandidate(doc, before, submitted), null);
});
test('reasoning in the same assistant turn is excluded and ambiguous outputs stop', () => {
  const doc = page(); const before = snapshot(doc); add(doc, user('u', 'hello')); const u = findSubmittedUser(doc, before, 'hello');
  add(doc, assistant('a', '<div data-testid="reasoning-content"><div class="markdown">SECRET THOUGHT</div></div><div class="markdown">Public answer</div>'));
  assert.equal(finalCandidate(doc, before, u).text, 'Public answer');
  add(doc, assistant('another', '<div class="markdown">Ambiguous second answer</div>'));
  assert.equal(finalCandidate(doc, before, u), null);
});
test('human turn collision and prompt mismatch abort instead of reading another reply', () => {
  const doc = page(); const before = snapshot(doc); add(doc, user('u', 'manual question'));
  assert.throws(() => findSubmittedUser(doc, before, 'group question'), /不同/);
  const u = findSubmittedUser(doc, before, 'manual question'); add(doc, user('u2', 'second question'));
  assert.throws(() => findSubmittedUser(doc, before, 'manual question'), /其他新消息/);
  assert.throws(() => finalCandidate(doc, before, u), /其他消息/);
});

test('legacy message identity may mount before its text without owning the incomplete turn', () => {
  const doc = page(); const before = snapshot(doc);
  add(doc, user('pending', ''));
  assert.equal(findSubmittedUser(doc, before, 'question'), null);
  doc.querySelector('.whitespace-pre-wrap').textContent = 'question';
  assert.ok(findSubmittedUser(doc, before, 'question'));
});
test('final answer extraction preserves links and fenced code, excludes UI controls', () => {
  const doc = page('<div id="answer" class="markdown"><h2>Example</h2><p>See <a href="https://example.com/docs">the docs</a>.</p><div><div>python<button>Copy code</button></div><pre><code class="language-python">print("hi")\n</code></pre></div><p><strong>Done</strong></p></div>');
  const text = markdownText(doc.querySelector('#answer'));
  assert.match(text, /## Example/); assert.match(text, /\[the docs\]\(https:\/\/example.com\/docs\)/); assert.match(text, /```python\nprint\("hi"\)\n```/); assert.doesNotMatch(text, /Copy code/); assert.match(text, /\*\*Done\*\*/);
});

test('code line breaks represented by br elements remain separate lines', () => {
  const doc = page('<div id="answer"><pre><code class="language-python"><span>def f():</span><br>    <span>return 1</span><span hidden>PRIVATE HELPER</span><br></code></pre></div>');
  assert.equal(markdownText(doc.querySelector('#answer')), '```python\ndef f():\n    return 1\n```');
});

test('prose normalization preserves code whitespace and does not corrupt embedded fences or dollar signs', () => {
  const doc = page('<div id="answer"><p>Before</p><pre><code class="language-python"></code></pre><p>After</p></div>');
  const code = 'text = """first  \n\n\nlast"""\nprint("```", "$&", "$1")\n';
  doc.querySelector('code').textContent = code;
  assert.equal(markdownText(doc.querySelector('#answer')), 'Before\n\n````python\n' + code + '````\n\nAfter');
});

test('a user turn with no completed assistant blocks the pre-stream race', () => {
  const doc = page(user('manual', 'question just sent'));
  assert.throws(() => assertReady(doc), /尚未明确完成/);
  add(doc, assistant('pending', '<div class="markdown">Partial answer</div>', false));
  assert.throws(() => assertReady(doc), /尚未明确完成/);
  doc.querySelector('[data-testid="conversation-turn-pending"]').insertAdjacentHTML('beforeend', '<button data-testid="copy-turn-action-button">Copy</button>');
  assert.ok(assertReady(doc));
});

test('legacy completion waits for a visible and enabled copy control', () => {
  for (const [name, mutate] of [
    ['hidden', button => { button.hidden = true; }],
    ['disabled', button => { button.disabled = true; }],
    ['aria-disabled', button => button.setAttribute('aria-disabled', 'true')],
    ['inert', button => button.setAttribute('inert', '')],
  ]) {
    const doc = page(); const baseline = snapshot(doc);
    add(doc, user('u', 'question') + assistant('a', '<div class="markdown">answer</div>'));
    const submitted = findSubmittedUser(doc, baseline, 'question');
    mutate(doc.querySelector('[data-testid="copy-turn-action-button"]'));
    assert.equal(finalCandidate(doc, baseline, submitted), null, name);
    assert.throws(() => assertReady(doc), /尚未明确完成/, name);
  }
});
