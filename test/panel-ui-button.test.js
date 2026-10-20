import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'panel', 'public');
const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');

// 回归用例：已选中的助手按钮曾经是 disabled + 文案「正在配置」，
// 用户点它没有任何反应也没有提示，看起来就是"配置按钮坏了"。
// 要求：当前助手按钮仍可点，点下去必须给出明确反馈，且 busy 之外不得禁用。

test('当前助手的按钮不禁用，且点下去必须有明确回应', () => {
  const render = app.slice(app.indexOf('function renderAssistants()'), app.indexOf('function renderPlatforms()'));
  // 文案要能区分"当前"，而不是让人以为坏了。
  assert.match(render, /当前：/, '当前助手的按钮文案应体现"当前"');
  assert.doesNotMatch(render, /el\('button'[^)]*\)[^;]*;\s*button\.disabled\s*=\s*true/, '渲染时不得把按钮设为禁用');

  const select = app.slice(app.indexOf('async function selectAssistant('), app.indexOf('async function selectPlatform('));
  assert.match(select, /assistant === activeAssistant/, '点击当前助手必须被识别');
  assert.match(select, /feedback\([\s\S]{0,200}当前已经在配置/, '点击当前助手必须给出反馈');
});

test('controls() 只按 busy 禁用助手与平台按钮，不再因为"已选中"而禁用', () => {
  const controls = app.slice(app.indexOf('function controls()'), app.indexOf('function renderAssistants()'));
  assert.match(controls, /card\.querySelector\('button'\)\.disabled = busy;/, '助手按钮只应受 busy 控制');
  assert.match(controls, /tab\.disabled = busy;/, '平台按钮只应受 busy 控制');
  assert.doesNotMatch(controls, /disabled = busy \|\| assistant === activeAssistant/, '不得因已选中而禁用');
});

test('平台按钮点当前平台也要有回应', () => {
  const select = app.slice(app.indexOf('async function selectPlatform('), app.indexOf('function wire()'));
  assert.match(select, /platform === activePlatform/, '点击当前平台必须被识别');
  assert.match(select, /feedback\(/, '点击当前平台必须给出反馈');
});

test('busy 期间点击给出等待提示，而不是静默丢弃', () => {
  const select = app.slice(app.indexOf('async function selectAssistant('), app.indexOf('async function selectPlatform('));
  assert.match(select, /if \(busy\)[^}]*feedback\(/, 'busy 时应提示稍等，而不是无声 return');
});
