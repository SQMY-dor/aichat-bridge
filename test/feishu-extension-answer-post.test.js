import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnswerPosts, answerPostRequestBytes, serializeAnswerPost, ANSWER_POST_REQUEST_LIMIT } from '../extension/answer-post.js';

const nodes = posts => posts.flatMap(post => post.zh_cn.content.flat());
const code = posts => nodes(posts).filter(node => node.tag === 'code_block');

test('fenced replies use native post code blocks with exact indentation, newlines and inert prose', () => {
  const body = '介绍 <at user_id="all">所有人</at> &lt;img&gt; **原文**\n\n';
  const source = 'function example() {\n\tconst value = "<at user_id=\\"all\\">";\n    return value;\n}\n';
  const posts = buildAnswerPosts(body + '```js\n' + source + '```\n结束');
  assert.equal(nodes(posts).filter(node => node.tag === 'text').map(node => node.text).join(''), body.replaceAll('**', '') + '结束');
  assert.deepEqual(nodes(posts).find(node => node.text === '原文').style, ['bold']);
  assert.deepEqual(code(posts), [{ tag: 'code_block', text: source, language: 'JAVASCRIPT' }]);
  assert.equal(JSON.parse(serializeAnswerPost(posts[0])).zh_cn.content[1][0].text, source);
  assert.ok(nodes(posts).every(node => ['text', 'code_block'].includes(node.tag)));
});

test('longer fences, tildes, CRLF and unclosed code retain the original code bytes', () => {
  const source = '  first\r\n```\r\n    nested\r\n';
  assert.equal(code(buildAnswerPosts('````python\r\n' + source + '````\r\n'))[0].text, source);
  assert.deepEqual(code(buildAnswerPosts('~~~c++\nint x = 1;\n~~~\n')), [{ tag: 'code_block', language: 'CPP', text: 'int x = 1;\n' }]);
  assert.deepEqual(code(buildAnswerPosts('```rust\nfn main() {\n  // incomplete\n')), [{ tag: 'code_block', language: 'RUST', text: 'fn main() {\n  // incomplete\n' }]);
  assert.equal(code(buildAnswerPosts('```\n```'))[0].text, '');
  assert.equal(code(buildAnswerPosts('`'.repeat(3000) + 'json\n{"value":"```"}\n' + '`'.repeat(3000)))[0].text, '{"value":"```"}\n');
});

test('fence language aliases use documented values and unknown language/metadata remain visible', () => {
  for (const [label, expected] of [['py', 'PYTHON'], ['ts', 'TYPESCRIPT'], ['yml', 'YAML'], ['sh', 'SHELL'], ['Go', 'GO']]) {
    assert.equal(code(buildAnswerPosts('```' + label + '\nx\n```'))[0].language, expected);
  }
  const unknown = nodes(buildAnswerPosts('```custom-lang\n  unchanged\n```'));
  assert.deepEqual(unknown, [{ tag: 'text', text: '代码语言：custom-lang', un_escape: false }, { tag: 'code_block', text: '  unchanged\n' }]);
  const metadata = nodes(buildAnswerPosts('```python filename=main.py\nprint(1)\n```'));
  assert.equal(metadata[0].text, '代码语言：python filename=main.py');
  assert.equal(metadata[1].language, 'PYTHON'); assert.equal(metadata[1].text, 'print(1)\n');
});

test('inline code becomes literal text while invalid block fences stay readable', () => {
  const source = 'Inline ```js x``` and `code`\n    ```python\nnot a fence\n    ```\n```bad`info\n';
  assert.deepEqual(nodes(buildAnswerPosts(source)), [{ tag: 'text', text: source.replace('```js x``` and `code`', 'js x and code'), un_escape: false }]);
});

test('large code is split in source order into bounded native blocks without losing any text', () => {
  const source = ('    const 中文 = "\\\\\\\"quoted\\\""; // 😀\n').repeat(1800);
  const posts = buildAnswerPosts('正文\n```typescript\n' + source + '```\n尾声');
  assert.ok(posts.length > 3);
  assert.ok(posts.every(post => answerPostRequestBytes(post) <= ANSWER_POST_REQUEST_LIMIT));
  assert.equal(code(posts).map(node => node.text).join(''), source);
  assert.ok(code(posts).every(node => node.language === 'TYPESCRIPT'));
  assert.deepEqual(nodes(posts).filter(node => node.tag === 'text').map(node => node.text), ['正文\n', '尾声']);
  for (const post of posts) assert.deepEqual(JSON.parse(serializeAnswerPost(post)), post);
});

test('long lines preserve Unicode graphemes when possible and code points for oversized clusters', () => {
  for (const source of ['👨‍👩‍👧‍👦'.repeat(200), 'x' + '\u0301'.repeat(1200), '\\"\r\n'.repeat(200)]) {
    const posts = buildAnswerPosts('```\n' + source + '\n```', 512);
    assert.ok(posts.length > 1); assert.ok(posts.every(post => answerPostRequestBytes(post) <= 512));
    assert.equal(code(posts).map(node => node.text).join(''), source + '\n');
    assert.ok(code(posts).every(node => node.text.isWellFormed()));
    if (source.startsWith('👨')) assert.ok(code(posts).slice(0, -1).every(node => node.text.endsWith('👦')));
  }
});

test('prose-only splitting also preserves source order and double JSON request limits', () => {
  const source = ('文本 "quote" \\路径 😀\n').repeat(1500);
  const posts = buildAnswerPosts(source, 1200);
  assert.equal(nodes(posts).map(node => node.text).join(''), source);
  assert.ok(posts.every(post => answerPostRequestBytes(post) <= 1200));
  assert.ok(nodes(posts).every(node => node.tag === 'text' && node.un_escape === false));
});

test('transport validation rejects executable/resource nodes, decoding, unknown enum and oversized contents', () => {
  const wrapped = node => ({ zh_cn: { title: '', content: [[node]] } });
  for (const value of [
    wrapped({ tag: 'at', user_id: 'all', text: 'x' }),
    wrapped({ tag: 'md', text: '<at user_id="all">all</at>' }),
    wrapped({ tag: 'img', image_key: 'img_x', text: 'x' }),
    wrapped({ tag: 'text', text: 'x', un_escape: true }),
    wrapped({ tag: 'text', text: 'x', un_escape: false, style: ['monospace'] }),
    wrapped({ tag: 'a', text: 'x', href: 'javascript:alert(1)' }),
    wrapped({ tag: 'a', text: 'x', href: 'https://user:password@example.com/' }),
    wrapped({ tag: 'a', text: 'x', href: 'https://example.com/\npath' }),
    wrapped({ tag: 'code_block', text: 'x', language: 'UNDOCUMENTED' }),
    wrapped({ tag: 'code_block', text: 'x'.repeat(30000) }),
    wrapped({ tag: 'code_block', text: '\ud800' }),
    { zh_cn: { title: '', content: [] } },
  ]) assert.throws(() => serializeAnswerPost(value));
  for (const value of ['', '  ', null, 'x'.repeat(120001)]) assert.throws(() => buildAnswerPosts(value));
  for (const limit of [0, 511, 24001, NaN]) assert.throws(() => buildAnswerPosts('text', limit));
});

test('headings, emphasis, lists, quotes and safe links render as native readable prose', () => {
  const source = '# 标题\n普通 **粗体**、*斜体*、~~删除~~ 和 ***强调***。\n- 列表 `snake_case`\n- [x] 完成\n> 引用 [链接](https://example.com/a_(b))\n[危险](javascript:alert(1)) ![图](https://example.com/image.png)\n';
  const rendered = nodes(buildAnswerPosts(source));
  const readable = rendered.map(node => node.text).join('');
  assert.equal(readable, '标题\n普通 粗体、斜体、删除 和 强调。\n• 列表 snake_case\n☑ 完成\n│ 引用 链接\n危险 (javascript:alert(1)) 图片：图\n');
  assert.deepEqual(rendered.find(node => node.text === '标题').style, ['bold']);
  assert.deepEqual(rendered.find(node => node.text === '粗体').style, ['bold']);
  assert.deepEqual(rendered.find(node => node.text === '斜体').style, ['italic']);
  assert.deepEqual(rendered.find(node => node.text === '删除').style, ['lineThrough']);
  assert.deepEqual(rendered.find(node => node.text === '强调').style, ['bold', 'italic']);
  assert.deepEqual(rendered.filter(node => node.tag === 'a').map(node => node.href), ['https://example.com/a_(b)', 'https://example.com/image.png']);
  assert.ok(rendered.every(node => node.tag === 'a' || node.un_escape === false));
  assert.doesNotThrow(() => serializeAnswerPost(buildAnswerPosts(source)[0]));
});

test('inline code and ordinary snake_case remain literal, and styled/link splits retain allowed styles', () => {
  const source = 'Use `snake_case **literal** <at user_id="all">` and normal_name_here.\n';
  assert.equal(nodes(buildAnswerPosts(source)).map(node => node.text).join(''), source.replaceAll('`', ''));
  const posts = buildAnswerPosts('**' + '加粗😀'.repeat(1000) + '** [链接](https://example.com)', 512);
  assert.equal(nodes(posts).filter(node => node.style?.includes('bold')).map(node => node.text).join(''), '加粗😀'.repeat(1000));
  assert.ok(posts.every(post => answerPostRequestBytes(post) <= 512));
  assert.ok(posts.every(post => serializeAnswerPost(post)));
});

test('Markdown tables become canonical native md tables while surrounding prose keeps native styles', () => {
  const posts = buildAnswerPosts('## 项目进度\n\n| 模块 | 完成度 | 状态 |\n| :--- | ---: | :---: |\n| **核心** | 87% | 已完成 |\n| 网页 | 95% | 调试中 |\n\n下一步 **验收**。');
  const tables = nodes(posts).filter(node => node.tag === 'md');
  assert.equal(tables.length, 1);
  assert.equal(tables[0].text, '\n\n| 模块 | 完成度 | 状态 |\n| --- | --- | --- |\n| 核心 | 87% | 已完成 |\n| 网页 | 95% | 调试中 |\n\n');
  assert.ok(nodes(posts).some(node => node.text === '项目进度' && node.style?.includes('bold')));
  assert.ok(nodes(posts).some(node => node.text === '验收' && node.style?.includes('bold')));
  assert.ok(nodes(posts).filter(node => node.tag === 'text').every(node => !node.text.includes('| ---')));
  posts.forEach(post => assert.doesNotThrow(() => serializeAnswerPost(post)));
});

test('table parsing preserves literal pipes, safe links and cell breaks without enabling mentions or resources', () => {
  const source = '| 名称 | 备注 |\n| --- | --- |\n| `a|b` | x\\|y<br>z `<br>` <at user_id="all">全员</at> &lt;img&gt; ![图](img_secret) [链接](https://example.com/a_(b)) [坏链](javascript:alert(1)) |';
  const post = buildAnswerPosts(source)[0]; const table = nodes([post]).find(node => node.tag === 'md').text;
  assert.match(table, /a\\\|b/); assert.match(table, /x\\\|y \/ z ＜br＞/);
  assert.match(table, /＜at user\\_id="all"＞全员＜\/at＞/);
  assert.match(table, /＆lt;img＆gt;/); assert.match(table, /图片：图/);
  assert.match(table, /\[链接\]\(https:\/\/example.com\/a_%28b%29\)/);
  assert.doesNotMatch(table, /<at|<img|!\[|\]\(javascript:/);
  assert.doesNotThrow(() => serializeAnswerPost(post));
});

test('tables without outer pipes and uneven columns preserve every value with explicit column labels', () => {
  const table = nodes(buildAnswerPosts('名称 | 值\n--- | ---\nA | 1 | extra\nB |')).find(node => node.tag === 'md').text;
  assert.equal(table, '\n\n| 名称 | 值 | 列3 |\n| --- | --- | --- |\n| A | 1 | extra |\n| B |  |  |\n\n');
  const emptyHeader = nodes(buildAnswerPosts('| | 值 |\n| --- | --- |\n| A | 1 |')).find(node => node.tag === 'md').text;
  assert.match(emptyHeader, /^\n\n\| 列1 \| 值 \|/);
});

test('table-like code and ordinary pipes remain literal instead of being treated as a table', () => {
  const tableSource = '| header | value |\n| --- | --- |\n| x | y |\n';
  const posts = buildAnswerPosts('普通 A | B\n不是分隔线\n\n```text\n' + tableSource + '```');
  assert.equal(nodes(posts).filter(node => node.tag === 'md').length, 0);
  assert.equal(code(posts)[0].text, tableSource);
  assert.match(nodes(posts).filter(node => node.tag === 'text').map(node => node.text).join(''), /普通 A \| B/);
});

test('bounded table splitting repeats headers and splits only between complete source rows', () => {
  const body = Array.from({ length: 70 }, (_, i) => `| row${i} | 值${i} 😀 |`).join('\n');
  const posts = buildAnswerPosts('| 名称 | 数值 |\n| --- | --- |\n' + body, 512);
  const tables = nodes(posts).filter(node => node.tag === 'md');
  assert.ok(tables.length > 5); assert.ok(posts.every(post => answerPostRequestBytes(post) <= 512));
  const recovered = tables.flatMap(node => {
    const lines = node.text.trim().split('\n');
    assert.deepEqual(lines.slice(0, 2), ['| 名称 | 数值 |', '| --- | --- |']);
    return lines.slice(2);
  });
  assert.deepEqual(recovered, body.split('\n'));
  posts.forEach(post => assert.doesNotThrow(() => serializeAnswerPost(post)));
});

test('an oversized individual table row becomes compact native fields without losing data or row order', () => {
  const longValue = '完整值😀'.repeat(300);
  const posts = buildAnswerPosts('| 名称 | 说明 |\n| --- | --- |\n| Before | short |\n| Large | ' + longValue + ' |\n| After | short |', 512);
  const all = nodes(posts); const tables = all.filter(node => node.tag === 'md');
  assert.equal(tables.length, 2); assert.match(tables[0].text, /Before/); assert.match(tables[1].text, /After/);
  assert.equal(all.filter(node => node.tag === 'text').map(node => node.text).join(''), '名称：Large\n说明：' + longValue);
  assert.ok(all.find(node => node.text.includes('Large')).style.includes('bold'));
  assert.ok(posts.every(post => answerPostRequestBytes(post) <= 512));
  posts.forEach(post => assert.doesNotThrow(() => serializeAnswerPost(post)));
});

test('only canonical sanitized table md is accepted by transport serialization', () => {
  const wrap = text => ({ zh_cn: { title: '', content: [[{ tag: 'md', text }]] } });
  for (const text of [
    '**arbitrary markdown**',
    '\n\n| header |\n| --- |\n| <at user_id="all">all</at> |\n\n',
    '\n\n| header |\n| --- |\n| @all |\n\n',
    '\n\n| header |\n| --- |\n| ![image](img_secret) |\n\n',
    '\n\n| header |\n| --- |\n| [bad](https://user:password@example.com/) |\n\n',
    '\n\n| header |\n| --- |\n| &lt;at&gt; |\n\n',
    '\n\n| header |\n| --- |\n| x |\n\n```js\nrun()\n```\n\n',
    '\n\n| header |\n| --- |\n| x | extra |\n\n',
  ]) assert.throws(() => serializeAnswerPost(wrap(text)));
  assert.doesNotThrow(() => serializeAnswerPost(wrap('\n\n| header |\n| --- |\n| literal |\n\n')));
});

test('DOM-escaped pipes and Markdown punctuation in table link targets round-trip canonically', () => {
  const posts = buildAnswerPosts('| 名称 | 链接 |\n| --- | --- |\n| 路径 | [文档](https://example.com/a\\|b?items=[one]&q=\\(two\\)) |\n| IPv6 | [链接](https://[2001:db8::1]/a[b]\\|c) |');
  const table = nodes(posts).find(node => node.tag === 'md').text;
  assert.match(table, /https:\/\/example.com\/a%7Cb\?items=%5Bone%5D&q=%28two%29/);
  assert.match(table, /https:\/\/\[2001:db8::1\]\/a%5Bb%5D%7Cc/);
  posts.forEach(post => assert.doesNotThrow(() => serializeAnswerPost(post)));
});

test('outer cell whitespace from inline code and emphasis is normalized without breaking native code', () => {
  for (const value of ['`  x  `', '`  `', '**  x  **', '*x* ', '\\  x  ']) {
    const posts = buildAnswerPosts('| 名称 | 值 |\n| --- | --- |\n| Item | ' + value + ' |\n\n```\n  x  \n```');
    assert.equal(code(posts)[0].text, '  x  \n');
    posts.forEach(post => assert.doesNotThrow(() => serializeAnswerPost(post)));
  }
});

test('adjacent same-target links remain canonical when table cell emphasis is flattened', () => {
  const posts = buildAnswerPosts('| Header | Value |\n| --- | --- |\n| Item | (_[x](https://example.com/a\\|b)_[x](https://example.com/a\\|b)`( |');
  const table = nodes(posts).find(node => node.tag === 'md').text;
  assert.match(table, /\[xx\]\(https:\/\/example.com\/a%7Cb\)/);
  posts.forEach(post => assert.doesNotThrow(() => serializeAnswerPost(post)));
});
