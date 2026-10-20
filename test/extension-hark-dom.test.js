import test from 'node:test';
import assert from 'node:assert/strict';
import * as hark from '../extension/hark-dom.js';
import { url, page, signedOutPage, user, answer, finish, stopButton, attachment, loaded } from './helpers/hark-fixture.js';

// 这些用例跑在合成 DOM 上，验证的是适配器的契约，不是线上页面。
// 真实页面标定后需要同步更新 test/helpers/hark-fixture.js 与 SELECTORS。

const q = (doc, selector) => doc.querySelector(selector);
const composer = doc => q(doc, '[data-testid="composer-input"]');

test('hark 未登录时拒绝操作，并明确提示先登录', () => {
  const doc = signedOutPage().window.document;
  assert.equal(hark.signedOut(doc), true);
  assert.throws(() => hark.composer(doc), /尚未登录/);
  assert.throws(() => hark.assertReady(doc), /尚未登录/);
});

test('hark 找到唯一的对话输入框，输入区、草稿与附件状态相互独立', () => {
  const doc = page().window.document;
  const input = hark.composer(doc);
  assert.equal(input, composer(doc));
  assert.equal(hark.assertReady(doc), input);
  assert.equal(hark.composerText(input), '');
  assert.equal(hark.composerScope(input), q(doc, '[data-testid="composer"]'));
  input.textContent = 'draft';
  assert.throws(() => hark.assertReady(doc), /草稿/);
  input.textContent = '';
  attachment(doc, 'a.png');
  assert.throws(() => hark.assertReady(doc), /附件/);
});

test('hark 写入提问后要求页面文本与任务完全一致，并有唯一可用的发送按钮', () => {
  const doc = page().window.document;
  const win = doc.defaultView;
  doc.execCommand = (command, _ui, text) => { assert.equal(command, 'insertText'); composer(doc).textContent = text; return true; };
  const input = hark.composer(doc);
  hark.insertPrompt(doc, input, '只回复：连接成功');
  assert.equal(hark.composerText(input), '只回复：连接成功');
  assert.equal(win.document.querySelectorAll('[data-testid="composer-send"]').length, 1);
  const button = hark.sendButton(doc, input);
  assert.ok(button);
  button.disabled = true;
  assert.equal(hark.sendButton(doc, input), null);
});

test('hark 用快照差值确认本次新提问，并把内容不符的新消息当作归属失败', () => {
  const doc = page().window.document;
  const baseline = hark.snapshot(doc);
  user(doc, '先前问题', 'user-0');
  const after = hark.snapshot(doc);
  assert.equal(hark.newUsers(doc, after).length, 0);
  const mine = user(doc, '新问题', 'user-1');
  const found = hark.findSubmittedUser(doc, after, '新问题');
  assert.equal(found, mine);
  const other = user(doc, '另一个问题', 'user-2');
  assert.throws(() => hark.findSubmittedUser(doc, after, '新问题'), /其他新消息/);
  other.remove();
  assert.throws(() => hark.findSubmittedUser(doc, after, '不同的问题'), /与本次群消息不同/);
});

test('hark 正文尚未挂全的新提问只报 pending，不确认也不授权答案', () => {
  const doc = page().window.document;
  const baseline = hark.snapshot(doc);
  const node = user(doc, '这是一个很长的提问', 'user-1');
  node.querySelector('p').textContent = '这是一个';
  assert.equal(hark.findSubmittedUser(doc, baseline, '这是一个很长的提问'), null);
  assert.equal(hark.submittedUserPending(doc, baseline, '这是一个很长的提问'), true);
  assert.match(hark.submissionWaitReason(doc, baseline, '这是一个很长的提问'), /尚未完整/);
  node.querySelector('p').textContent = '这是一个很长的提问';
  assert.equal(hark.submittedUserPending(doc, baseline, '这是一个很长的提问'), false);
});

test('hark 只有本轮唯一的已完成回复才算最终答案，流式中与多回复都返回 null', () => {
  const doc = page().window.document;
  user(doc, '问题', 'user-0');
  const baseline = hark.snapshot(doc);
  const mine = user(doc, '新问题', 'user-1');
  const confirmed = hark.findSubmittedUser(doc, baseline, '新问题');
  assert.equal(confirmed, mine);
  assert.equal(hark.finalCandidate(doc, baseline, mine), null);
  const streaming = answer(doc, '<p>正在写</p>', 'answer-1', { streaming: true });
  assert.equal(hark.finalCandidate(doc, baseline, mine), null);
  finish(doc, 'answer-1', '<p>最终回复</p>');
  const candidate = hark.finalCandidate(doc, baseline, mine);
  assert.equal(candidate.text, '最终回复');
  assert.deepEqual(candidate.images, []);
  answer(doc, '<p>另一个回复</p>', 'answer-2');
  assert.equal(hark.finalCandidate(doc, baseline, mine), null);
  finish(doc, 'answer-2', '<p>另一个回复</p>');
  assert.equal(hark.finalCandidate(doc, baseline, mine), null);
  assert.equal(streaming.getAttribute('data-state'), 'complete');
});

test('hark 只转发本站图片，外部来源图片既不转发也不阻塞文本', () => {
  const doc = page().window.document;
  const baseline = hark.snapshot(doc);
  user(doc, '新问题', 'user-1');
  const mine = hark.findSubmittedUser(doc, baseline, '新问题');
  const message = answer(doc, '<p>答案</p><img src="https://assets.hark.com/out.png"><img src="https://example.invalid/x.png">', 'answer-1');
  const images = [...message.querySelectorAll('img')];
  loaded(images[0]); loaded(images[1]);
  const candidate = hark.finalCandidate(doc, baseline, mine);
  assert.equal(candidate.images.length, 1);
  assert.equal(candidate.images[0].src, 'https://assets.hark.com/out.png');
  assert.equal(candidate.text, '答案');
});

test('hark 生成中的停止按钮与未完成的上一条回复都会阻止新任务', () => {
  const doc = page().window.document;
  user(doc, '上一问', 'user-0');
  const stop = stopButton(doc);
  assert.equal(hark.generating(doc), true);
  assert.throws(() => hark.assertReady(doc), /正在生成/);
  stop.remove();
  assert.equal(hark.generating(doc), false);
  assert.throws(() => hark.assertReady(doc), /尚未明确完成/);
});

test('hark 附件只有在名称一一对应且不在上传中时才算就绪', () => {
  const doc = page().window.document;
  const input = hark.composer(doc);
  assert.deepEqual(hark.inputAttachmentState(input, []), { ready: true });
  assert.deepEqual(hark.inputAttachmentState(input, ['a.png']), { ready: false, reason: 'no-attachment' });
  attachment(doc, 'a.png');
  assert.deepEqual(hark.inputAttachmentState(input, ['a.png']), { ready: true });
  assert.deepEqual(hark.inputAttachmentState(input, ['b.png']), { ready: false, reason: 'name-mismatch' });
  stopButton(doc).remove();
  const busy = doc.createElement('div');
  busy.setAttribute('role', 'progressbar');
  q(doc, '[data-testid="composer"]').append(busy);
  assert.deepEqual(hark.inputAttachmentState(input, ['a.png']), { ready: false, reason: 'uploading' });
});

test('hark 粘贴图片只在本页输入框上派发 paste，并登记本次附件名', () => {
  const doc = page().window.document;
  const win = doc.defaultView;
  const input = hark.composer(doc);
  win.DataTransfer = class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } };
  win.ClipboardEvent = class extends win.Event { constructor(type, options) { super(type, options); this.clipboardData = options.clipboardData; } };
  const pasted = [];
  input.addEventListener('paste', event => pasted.push(event.clipboardData.files[0].name));
  hark.pasteInputImage(doc, input, { mimeType: 'image/png', base64: 'iVBORw0KGgoBAgM=' }, 'bridge-1.png');
  assert.deepEqual(pasted, ['bridge-1.png']);
  const other = page().window.document;
  assert.throws(() => hark.pasteInputImage(other, input, { mimeType: 'image/png', base64: 'iVBORw0KGgoBAgM=' }, 'bridge-2.png'), /无法确认 Hark 图片输入目标/);
});

test('hark 回复图片只接受本站来源，并按字节校验后返回 base64', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const fetchImpl = async url => {
    assert.equal(url, 'https://assets.hark.com/out.png');
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const payload = await hark.readAnswerImage({ src: 'https://assets.hark.com/out.png' }, { fetchImpl });
  assert.equal(payload.mimeType, 'image/png');
  assert.equal(payload.byteLength, png.length);
  assert.equal(Buffer.from(payload.base64, 'base64').length, png.length);
  await assert.rejects(hark.readAnswerImage({ src: 'https://example.invalid/x.png' }, { fetchImpl }), /来源不受支持/);
  const htmlFetch = async () => new Response('nope', { status: 200, headers: { 'content-type': 'text/html' } });
  await assert.rejects(hark.readAnswerImage({ src: 'https://assets.hark.com/out.png' }, { fetchImpl: htmlFetch }), /仅支持 PNG/);
});

test('hark 选择器登记表可整体替换，非法键与非法值都被拒绝', () => {
  const original = { ...hark.SELECTORS };
  try {
    assert.throws(() => hark.applyCalibration({ composer: '' }), /无效/);
    assert.throws(() => hark.applyCalibration({ nope: '[x]' }), /未知的/);
    const applied = hark.applyCalibration({ completion: '[data-testid="message-actions"], [data-done]', composer: '[data-testid="composer-input"]' });
    assert.match(applied.completion, /data-done/);
    const doc = page().window.document;
    assert.ok(hark.composer(doc));
    hark.applyCalibration({ composer: '[data-testid="not-calibrated-yet"]' });
    assert.throws(() => hark.composer(doc), /尚未标定/);
  } finally {
    hark.applyCalibration(original);
  }
  assert.equal(hark.SELECTORS.composer, original.composer);
});
