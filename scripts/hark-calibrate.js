#!/usr/bin/env node
// 把探针输出翻译成 hark-dom.js 的 SELECTORS 建议值。
// 只做只读分析，不写文件；用户确认后按提示改 extension/hark-dom.js。
import fs from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('用法: node scripts/hark-calibrate.js /tmp/hark-thread.json'); process.exit(2); }
let data;
try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('读不了 JSON: ' + e.message); process.exit(2); }
const r = data.result || (data.runs && data.runs[0] && data.runs[0].result);
if (!r) { console.error('这个 JSON 里没有 result，换一个探针输出'); process.exit(2); }

const counts = r.counts || {};
const chat = counts.chatComposers || 0;
console.log('=== 探针概况 ===');
console.log('页面        :', r.meta && r.meta.url);
console.log('对话输入框  :', chat, '（0 表示还没登录或不在会话页）');
console.log('发送按钮候选:', (r.sendButtonCandidates || []).length);
console.log('重复容器    :', (r.repeatedGroups || []).length);
console.log();
if (!chat) {
  console.log('结论：这个页面还没有对话输入框，不能标定。');
  console.log('请先登录 Hark，并打开一个真实会话（地址形如 /chat/<id>），再跑一次探针。');
  for (const note of r.notes || []) console.log('提示：' + note);
  process.exit(1);
}

// 优先用 data-testid（Hark 的类名是 CSS Modules 哈希，不可靠）
function pickTestId(candidates) {
  for (const c of candidates || []) {
    const m = /\[data-testid="([^"]+)"\]/.exec(c);
    if (m) return '[data-testid="' + m[1] + '"]';
  }
  return null;
}

const out = {};
out.composer = pickTestId(r.suggested && r.suggested.composer);
out.scope = pickTestId(r.suggested && r.suggested.composerScope);
out.send = pickTestId((r.sendButtonCandidates || []).map(b => 'button[data-testid="' + (b.dataTestId || '') + '"]'));

const groups = r.repeatedGroups || [];
const messageRow = groups.find(g => (g.score || 0) > 3) || groups[0];
if (messageRow && messageRow.sampleAttributes) {
  const tid = messageRow.sampleAttributes.dataTestid;
  if (tid) out.user = '[data-testid="' + tid + '"]';
}

console.log('=== 建议的 SELECTORS ===');
for (const [key, value] of Object.entries(out)) {
  if (value) console.log(key.padEnd(10), '=' , value);
  else console.log(key.padEnd(10), '= (探针没找到，需要人工看 JSON 里的 candidate)');
}
console.log();
console.log('=== 还需要人工确认的 ===');
console.log('assistant / answerBody / completion / stop / attachment 这几项探针只能给候选，');
console.log('必须登录后触发一次生成、上传一张图，再跑探针，看 messageContainerCandidates 与 buttons。');
console.log();
console.log('=== 改哪里 ===');
console.log('extension/hark-dom.js 顶部的 SELECTORS 对象，替换对应键的值，然后 npm run check && npm test。');