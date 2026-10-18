import test from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_PART_BYTES, buildAnswerPosts } from '../extension/answer-text.js';

const bytes = text => new TextEncoder().encode(text).byteLength;

test('short native Markdown preserves titles, lists, tables and code bytes without adding a message envelope', () => {
  const text = '# 标题\n\n**正文**\n- 第一项\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```python\n  print("<@123>")\n  # [x](javascript:code)\n```';
  assert.deepEqual(buildAnswerPosts(text), [text]); assert.equal(ANSWER_PART_BYTES, 4000);
});

test('UTF-8 splitting preserves all prose, newlines and emoji without silently reducing the reply slot count', () => {
  const text = '中文🙂👨‍👩‍👧‍👦 e\u0301\n'.repeat(1200);
  const posts = buildAnswerPosts(text);
  assert.ok(posts.length > 5); assert.ok(posts.every(post => bytes(post) <= ANSWER_PART_BYTES));
  assert.equal(posts.join(''), text);
  assert.ok(posts.every(post => !post.includes('\ufffd') && !post.startsWith('\u200d')));
});

test('large fenced code splits only between full lines with balanced fences and unchanged indentation or code content', () => {
  for (const marker of ['```', '~~~~']) {
    const body = Array.from({ length: 100 }, (_, index) => `    const n${index} = "文字🙂";\n`).join('');
    const posts = buildAnswerPosts(`${marker}javascript\n${body}${marker}`, 160);
    assert.ok(posts.length > 1); assert.ok(posts.every(post => bytes(post) <= 160));
    assert.ok(posts.every(post => post.startsWith(`${marker}javascript\n`) && post.endsWith(marker)));
    assert.equal(posts.map(post => post.slice(`${marker}javascript\n`.length, -marker.length)).join(''), body);
  }
});

test('link handling keeps HTTP(S) links, blocks executable links and makes mentions and remote image embeds inert outside code', () => {
  const posts = buildAnswerPosts('[safe](https://example.com/a) ![diagram](https://example.com/image.png) [bad](javascript:alert) <@123> <@!456> <img src="x"> `![code](javascript:x) <@123>`');
  assert.match(posts[0], /\[safe\]\(https:\/\/example.com\/a\)/);
  assert.match(posts[0], /\[diagram\]\(https:\/\/example.com\/image.png\)/);
  assert.match(posts[0], /bad \(javascript：alert\)/);
  assert.match(posts[0], /＜@123＞/); assert.match(posts[0], /＜@!456＞/);
  assert.match(posts[0], /`!\[code\]\(javascript:x\) <@123>`/);
  assert.doesNotMatch(posts[0], /<img/);
});

test('unclosed code is safely closed and oversized code lines fail explicitly instead of changing or truncating code', () => {
  assert.deepEqual(buildAnswerPosts('```js\n  code()'), ['```js\n  code()\n```']);
  assert.throws(() => buildAnswerPosts('```js\n' + 'x'.repeat(200) + '\n```', 64), /单行代码过长/);
  assert.throws(() => buildAnswerPosts('```' + 'x'.repeat(200) + '\ncode\n```', 64), /代码标记过长/);
  for (const value of ['', '   ', null]) assert.throws(() => buildAnswerPosts(value), /不能为空/);
  for (const limit of [0, 63, NaN, 1.5]) assert.throws(() => buildAnswerPosts('answer', limit), /分段大小无效/);
});
