import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { markdownText, snapshot, findSubmittedUser, finalCandidate } from '../extension/dom.js';

const fixture = await readFile(new URL('./fixtures/chatgpt-modern-code-block.html', import.meta.url), 'utf8');
const staticFixture = await readFile(new URL('./fixtures/chatgpt-static-code-block.html', import.meta.url), 'utf8');

test('user-supplied static plain-text code cards retain both commands and surrounding rich text', () => {
  const doc = page(staticFixture); const text = markdownText(doc.querySelector('main'));
  assert.match(text, /\*\*第一步：查看 Windows 可靠性记录\*\*/);
  assert.match(text, /按 `Win \+ R`，输入：/);
  assert.match(text, /```\nperfmon \/rel\n```/);
  assert.match(text, /```\n--disable-gpu\n```/);
  assert.match(text, /`Application Hang`、`AppHangB1`/);
  assert.match(text, /重新运行相似任务/);
  assert.doesNotMatch(text, /纯文本|复制代码|启用自动换行/);
});
test('static source code preserves literal newlines, tabs, blank lines and embedded fences', () => {
  const doc = page(staticFixture); const source = doc.querySelector('[data-code-block-source] code');
  const value = 'first  \n\n\tsecond\nprint("```", "$&")\n'; source.textContent = value;
  assert.match(markdownText(doc.querySelector('main')), /````\nfirst  \n\n\tsecond\nprint\("```", "\$&"\)\n````/);
});
test('ambiguous, hidden, virtualized or structurally unknown static sources still fail closed', () => {
  for (const change of [
    code => code.insertAdjacentHTML('beforeend', '<span hidden>missing</span>'),
    code => code.insertAdjacentHTML('beforeend', '<span class="cm-gap"></span>'),
    code => code.insertAdjacentHTML('beforeend', '<div>unknown line</div>'),
    code => code.parentElement.append(code.cloneNode(true)),
    code => code.closest('[data-code-block]').append(code.parentElement.cloneNode(true)),
  ]) {
    const doc = page(staticFixture); change(doc.querySelector('[data-code-block-source] code'));
    assert.throws(() => markdownText(doc.querySelector('main')), /代码块未完整展开/);
  }
});
const pythonLines = [
  'import math', 'import random', '', 'def greet(name):', '    print(f"你好，{name}")', '',
  'def add(a, b):', '    return a + b', '', 'def main():', '    total = add(2, 3)',
  '    print("sum:", total)', '', '    for number in range(3):', '        print(number)', '',
  '    values = [1, 2, 3]', '    print("sqrt:", math.sqrt(16))', '    print("choice:", random.choice(values))', '',
  '    message = "__name__ stays literal"', '    print(message)', '', '',
  'if __name__ == "__main__":', '    main()', '',
];
const pythonBlock = '```python\n' + pythonLines.join('\n') + '```';
const expected = '运行下面的示例。\n\n' + pythonBlock + '\n\n保存为 test.py 后运行：\n\n```bash\npython test.py\n```\n\n脚本输出会保留下划线。';
function page(html = fixture) { return new JSDOM('<!doctype html><main>' + html + '</main>', { url: 'https://chatgpt.com/c/fixture-code-conversation' }).window.document; }

test('observed CodeMirror Python and pre/code Bash become separate fenced blocks without UI text', () => {
  const doc = page();
  assert.equal(doc.querySelectorAll('.cm-content > .cm-line').length, 27);
  assert.equal(markdownText(doc.querySelector('#code-answer')), expected);
});

test('completed modern assistant extraction preserves the same complete code answer', () => {
  const doc = page('');
  const baseline = snapshot(doc);
  doc.querySelector('main').innerHTML = '<div data-turn-key="fixture-code-turn"><div data-talvt-turn-state="complete">' +
    '<div data-chatgpt-search-unit-key="fixture-code:0:user" data-chatgpt-search-message-ids="fixture-user"><div data-user-message-bubble="true">Write a small Python example</div></div>' +
    '<div data-chatgpt-search-unit-key="fixture-code:1:assistant" data-chatgpt-search-message-ids="fixture-assistant">' + fixture + '</div>' +
    '<div class="turn-action-controls"><button aria-label="复制">Copy</button></div></div></div>';
  const user = findSubmittedUser(doc, baseline, 'Write a small Python example');
  assert.equal(finalCandidate(doc, baseline, user).text, expected);
});

test('a single wrapped Bash block retains the observed header language even without a code language class', () => {
  const doc = page();
  const wrapper = doc.querySelectorAll('[data-code-block="true"]')[1];
  const outer = doc.createElement('div');
  outer.append(wrapper);
  assert.equal(markdownText(outer), '```bash\npython test.py\n```');
  assert.equal(markdownText(wrapper), '```bash\npython test.py\n```');
});

test('CodeMirror code retains whitespace, literal Markdown and multiple blank lines', () => {
  const doc = page();
  const wrapper = doc.querySelector('[data-code-block="true"]');
  const lines = wrapper.querySelectorAll('.cm-line');
  const values = [...pythonLines];
  values[0] = 'text = "``` $& $1 __name__ | **literal**"  ';
  values[4] = '\tprint("tab indentation")  ';
  lines[0].textContent = values[0];
  lines[4].textContent = values[4];
  lines[1].insertAdjacentHTML('beforeend', '<span hidden>PRIVATE HELPER</span>');
  assert.equal(markdownText(wrapper), '````python\n' + values.join('\n') + '````');
});

test('an unrecognized or partial editor cannot silently forward missing code lines', () => {
  for (const mutate of [
    content => content.replaceChildren(),
    content => content.append(Object.assign(content.ownerDocument.createElement('div'), { className: 'cm-gap' })),
    content => content.append(content.ownerDocument.createTextNode('unaccounted source text')),
    content => { content.children[3].hidden = true; },
    content => { content.parentElement.append(content.cloneNode(true)); },
  ]) {
    const doc = page();
    const wrapper = doc.querySelector('[data-code-block="true"]');
    mutate(wrapper.querySelector('.cm-content'));
    assert.throws(() => markdownText(wrapper), error => error.name === 'PageSafetyError' && /代码/.test(error.message));
  }
});

test('ordinary prose with whitespace styling remains prose rather than guessed code', () => {
  const doc = page('<div id="ordinary"><p>Python</p><div style="white-space:pre">This is ordinary prose.</div><p><code>__name__</code> stays inline.</p></div>');
  assert.equal(markdownText(doc.querySelector('#ordinary')), 'Python\n\nThis is ordinary prose.\n\n`__name__` stays inline.');
});
