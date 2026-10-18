import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { markdownText } from '../extension/dom.js';

const fixture = await readFile(new URL('./fixtures/chatgpt-modern-stats.html', import.meta.url), 'utf8');
const summary = [
  '当前迁移进度：**87%**（正在进行）',
  '实时传输速度：**1.33 GB/s**',
  '预计剩余时间：**2 分 15 秒**',
  '文件总数：**5,622 个**',
  '剩余数据量：**171 GB / 490 项**',
].join('\n');
const annotation = '来源：[任务统计](https://example.com/report)；统计值仅用于离线测试。';
function page(t, html = fixture) {
  const dom = new JSDOM('<!doctype html>' + html, { url: 'https://chatgpt.com/c/fixture-stats-conversation' });
  t.after(() => dom.window.close());
  return dom.window.document;
}

test('observed statistics form compact labeled lines with bold values and a separate linked annotation', t => {
  const doc = page(t);
  assert.equal(markdownText(doc.querySelector('#stats-answer')), '迁移状态概览。\n\n' + summary + '\n\n' + annotation + '\n\n以上为本次状态。');
});

test('statistics labels and values come from component semantics rather than fixed wording or metrics', t => {
  const doc = page(t);
  const box = doc.querySelector('[data-d-has-border]');
  box.querySelector('[data-d-component="row"] p').textContent = 'Backup completion';
  box.querySelector('[data-d-tabular-nums]').textContent = '42%';
  box.querySelector('[data-d-component="badge"]').textContent = 'Paused';
  const metric = box.querySelector('[data-d-component="grid-item"]');
  metric.children[0].textContent = 'Throughput';
  metric.children[1].textContent = '10 MB/s';
  const result = markdownText(box);
  assert.ok(result.startsWith('Backup completion：**42%**（Paused）\nThroughput：**10 MB/s**\n'));
  assert.ok(result.endsWith('\n\n' + annotation));
});

test('default-strong text spans preserve bold styling outside statistics while ordinary blocks stay separate', t => {
  const doc = page(t, '<div id="ordinary"><div>第一段</div><div>第二段</div><p>重点：<span data-d-component="text" data-d-default-strong><span data-d-text-flow="word">保持粗体</span></span>，<span data-d-default-strong="false">普通文本</span>。</p></div>');
  assert.equal(markdownText(doc.querySelector('#ordinary')), '第一段\n\n第二段\n\n重点：**保持粗体**，普通文本。');
});

test('unrecognized card children fall back without dropping visible content or collapsing ordinary divs', t => {
  const doc = page(t);
  const box = doc.querySelector('[data-d-has-border]');
  const extra = doc.createElement('div'); extra.textContent = '这段内容不能丢失';
  box.append(extra);
  const result = markdownText(box);
  assert.match(result, /这段内容不能丢失/);
  assert.match(result, /当前迁移进度/);
  assert.match(result, /87%/);
  assert.doesNotMatch(result, /^当前迁移进度：/);
  const ordinary = doc.createElement('div');
  ordinary.innerHTML = '<div data-d-component="box" data-d-direction="col" data-d-has-border><div>标题</div><div>独立正文</div></div>';
  assert.equal(markdownText(ordinary), '标题\n\n独立正文');
});

test('unknown metric content is preserved and hidden metrics or notes are never copied', t => {
  const doc = page(t);
  const box = doc.querySelector('[data-d-has-border]');
  const metric = box.querySelectorAll('[data-d-component="grid-item"]')[1];
  metric.hidden = true;
  box.querySelector('[data-d-size="sm"]').hidden = true;
  const result = markdownText(box);
  assert.equal(result, summary.split('\n').filter(line => !line.startsWith('预计剩余时间')).join('\n'));
  metric.hidden = false;
  const extra = doc.createElement('p'); extra.textContent = '可见补充信息'; metric.append(extra);
  const fallback = markdownText(box);
  assert.match(fallback, /可见补充信息/);
  assert.doesNotMatch(fallback, /统计值仅用于离线测试/);
});

test('a nonwhitespace text node cannot be discarded when recognizing a statistic wrapper', t => {
  const doc = page(t);
  const box = doc.querySelector('[data-d-has-border]');
  box.append(doc.createTextNode('保留这个直接文本节点'));
  assert.match(markdownText(box), /保留这个直接文本节点/);
});
