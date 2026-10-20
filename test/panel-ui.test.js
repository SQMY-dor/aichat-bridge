import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'panel', 'public');
const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');

// 回归用例：登录框用 .login { display: flex } 设了布局，特异性高于浏览器
// 内置的 [hidden] { display: none }，导致登录成功后 hidden 生效、视觉上却仍
// 全屏盖住面板，表现为「点了登录没反应」。必须有一条兜底规则。
test('面板样式对 [hidden] 有兜底，避免 display 规则盖掉 hidden 属性', () => {
  const rules = [...css.matchAll(/\[hidden\][^{]*\{([^}]*)\}/g)].map(match => match[1]);
  assert.ok(rules.length > 0, 'style.css 必须显式处理 [hidden]');
  assert.ok(rules.some(rule => /display\s*:\s*none/.test(rule)), '[hidden] 必须 display: none');
  assert.ok(rules.some(rule => /!important/.test(rule)), '必须用 !important 压过 .login 的 display');
});

test('登录与主界面互斥，且初始化时主界面默认不可见', () => {
  assert.match(html, /id="login"[^>]*hidden/, '登录框初始应隐藏');
  assert.match(html, /id="app"[^>]*hidden/, '主界面初始应隐藏');
  // showLogin/showApp 必须同时改动两个容器的 hidden，不能只改一个。
  assert.match(app, /function showLogin\(\)[\s\S]{0,400}login'\)\.hidden = false/);
  assert.match(app, /function showLogin\(\)[\s\S]{0,400}app'\)\.hidden = true/);
  assert.match(app, /function showApp\(\)[\s\S]{0,200}login'\)\.hidden = true/);
  assert.match(app, /function showApp\(\)[\s\S]{0,200}app'\)\.hidden = false/);
});

test('登录成功后必须真正进入主界面，而不是停在登录框', () => {
  // login() 成功后要保存 csrf、切到主界面并立刻刷新状态。
  const body = app.slice(app.indexOf('async function login('), app.indexOf('async function logout('));
  assert.match(body, /csrf = data\.csrf/);
  assert.match(body, /showApp\(\)/);
  assert.match(body, /await refresh\(\)/);
});
