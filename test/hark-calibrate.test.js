import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'hark-calibrate.js');

function run(payload) {
  const file = path.join(os.tmpdir(), 'hark-calibrate-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  try {
    const result = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
    return { status: result.status, out: result.stdout, err: result.stderr };
  } finally { fs.rmSync(file, { force: true }); }
}

const base = result => ({ tool: 'hark-dom-probe', version: 1, result });

test('未登录时标定脚本拒绝给建议，并指出要先去登录', () => {
  const x = run(base({
    meta: { url: 'https://app.hark.com/login' },
    counts: { chatComposers: 0, composers: 1 },
    notes: ['只有登录/邮箱类输入框'],
  }));
  assert.equal(x.status, 1);
  assert.match(x.out, /还没有对话输入框/);
  assert.match(x.out, /先登录/);
  assert.doesNotMatch(x.out, /=== 建议的 SELECTORS ===/);
});

test('登录后优先用 data-testid 给出选择器，不用哈希类名', () => {
  const x = run(base({
    meta: { url: 'https://app.hark.com/chat/abc12345' },
    counts: { chatComposers: 1, composers: 1 },
    suggested: {
      composer: [
        'body > div.mr6c8q0 > div._10qhyq25 > div._10qhyq2a > form.biwpmn7 > textarea.biwpmnb',
        'textarea[data-testid="composer-input"]',
      ],
      composerScope: ['div[data-testid="composer"] > div'],
    },
    sendButtonCandidates: [{ dataTestId: 'composer-send' }],
    repeatedGroups: [{ score: 8.5, sampleAttributes: { dataTestid: 'message-row' } }],
  }));
  assert.equal(x.status, 0);
  assert.match(x.out, /composer\s+= \[data-testid="composer-input"\]/);
  assert.match(x.out, /scope\s+= \[data-testid="composer"\]/);
  assert.match(x.out, /send\s+= \[data-testid="composer-send"\]/);
  assert.match(x.out, /user\s+= \[data-testid="message-row"\]/);
  // 绝不能把 CSS Modules 哈希类名当选择器建议出去。
  assert.doesNotMatch(x.out, /mr6c8q0|_10qhyq25|biwpmn7/);
});

test('只剩哈希类名时如实说明探针没找到，而不是编一个出来', () => {
  const x = run(base({
    meta: { url: 'https://app.hark.com/chat/abc12345' },
    counts: { chatComposers: 1 },
    suggested: { composer: ['body > div._10qhyq25 > textarea.biwpmnb'], composerScope: [] },
    sendButtonCandidates: [{ label: 'Send' }],
    repeatedGroups: [],
  }));
  assert.equal(x.status, 0);
  assert.match(x.out, /需要人工看/);
  assert.match(x.out, /assistant \/ answerBody/);
});

test('读不到文件或 JSON 损坏时给出明确错误', () => {
  const missing = spawnSync(process.execPath, [SCRIPT, '/tmp/definitely-missing-hark.json'], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /读不了 JSON/);
  const noArgs = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(noArgs.status, 2);
  assert.match(noArgs.stderr, /用法/);
});
