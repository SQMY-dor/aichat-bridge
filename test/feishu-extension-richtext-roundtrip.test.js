import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { markdownText } from '../extension/dom.js';
import { buildAnswerPosts, serializeAnswerPost } from '../extension/answer-post.js';

const stats = await readFile(new URL('./fixtures/chatgpt-modern-stats.html', import.meta.url), 'utf8');

test('observed metrics, a capacity table and code keep separate rich-text semantics end to end', t => {
  const dom = new JSDOM(stats);
  t.after(() => dom.window.close());
  const root = dom.window.document.querySelector('#stats-answer');
  root.insertAdjacentHTML('beforeend', '<h2>磁盘容量分析</h2><table><thead><tr><th><p>磁盘</p></th><th><p>总容量</p></th><th><p>可用容量</p></th></tr></thead><tbody>' +
    '<tr><td><p>C: 系统盘</p></td><td><p>394 GB</p></td><td><p>45.6 GB</p></td></tr>' +
    '<tr><td><p>D: 新加卷</p></td><td><p>537 GB</p></td><td><p>352 GB</p></td></tr></tbody></table>' +
    '<p><span data-d-default-strong>保留重点文字。</span></p><pre><code class="language-python">if __name__ == "__main__":\n    main()\n</code></pre>');
  const posts = buildAnswerPosts(markdownText(root));
  posts.forEach(post => assert.doesNotThrow(() => serializeAnswerPost(post)));
  const nodes = posts.flatMap(post => post.zh_cn.content.flat());
  const plain = nodes.filter(node => ['text', 'a'].includes(node.tag)).map(node => node.text).join('');
  assert.match(plain, /当前迁移进度：87%（正在进行）\n实时传输速度：1\.33 GB\/s\n预计剩余时间：2 分 15 秒\n文件总数：5,622 个\n剩余数据量：171 GB \/ 490 项/);
  assert.ok(nodes.some(node => node.text === '1.33 GB/s' && node.style?.includes('bold')));
  assert.ok(nodes.some(node => node.text === '保留重点文字。' && node.style?.includes('bold')));
  assert.doesNotMatch(plain, /\|\s*---|\| 磁盘/);
  const tables = nodes.filter(node => node.tag === 'md');
  assert.equal(tables.length, 1);
  assert.match(tables[0].text, /\| 磁盘 \| 总容量 \| 可用容量 \|/);
  assert.ok(tables[0].text.includes('C: 系统盘'));
  assert.ok(tables[0].text.includes('D: 新加卷'));
  const code = nodes.filter(node => node.tag === 'code_block');
  assert.deepEqual(code, [{ tag: 'code_block', language: 'PYTHON', text: 'if __name__ == "__main__":\n    main()\n' }]);
  assert.ok(nodes.indexOf(tables[0]) < nodes.indexOf(code[0]));
});
