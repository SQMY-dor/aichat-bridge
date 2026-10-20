import test from 'node:test';
import assert from 'node:assert/strict';
import * as hark from '../extension/hark-dom.js';
import { url, page, signedOutPage, user, answer, finish, sendButton, stopButton, attachment, loaded, summaryAnswer } from './helpers/hark-fixture.js';

// 这些用例跑在按真机结构写的合成 DOM 上，验证适配器契约。
// 结构来源：app.hark.com/project/<id>，2026-10 实测（见 scripts/hark-probe-result.json）。

const q = (doc, selector) => doc.querySelector(selector);
const composer = doc => q(doc, '[data-testid="chat-input"]');

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
  assert.equal(input.tagName, 'TEXTAREA');
  assert.equal(hark.assertReady(doc), input);
  assert.equal(hark.composerText(input), '');
  // 输入区里那个「Add attachment」按钮不能被当成已有附件。
  assert.equal(hark.hasAttachments(input), false);
  input.value = 'draft';
  assert.throws(() => hark.assertReady(doc), /草稿/);
  input.value = '';
  attachment(doc, 'a.png');
  assert.throws(() => hark.assertReady(doc), /附件/);
});

test('hark 的发送键只认 aria-label=Send message，绝不点听写键', () => {
  const doc = page().window.document;
  const input = hark.composer(doc);
  // 空输入框：只有听写键（testid=send-button），没有发送键。
  assert.equal(q(doc, 'button[data-testid="send-button"]').getAttribute('aria-label'), 'Start dictation');
  assert.equal(hark.sendButton(doc, input), null);
  // 有内容后才出现发送键。
  const button = sendButton(doc);
  assert.equal(hark.sendButton(doc, input), button);
  button.disabled = true;
  assert.equal(hark.sendButton(doc, input), null);
});

test('hark 写入提问后要求页面文本与任务完全一致', () => {
  const doc = page().window.document;
  const input = hark.composer(doc);
  hark.insertPrompt(doc, input, '只回复：连接成功');
  assert.equal(hark.composerText(input), '只回复：连接成功');
  assert.throws(() => hark.insertPrompt(doc, input, 'again'), /草稿/);
});

test('hark 用气泡内层类名区分用户与助手，判定不了就抛错', () => {
  const doc = page().window.document;
  const mine = user(doc, '问题', 'user-1');
  const reply = answer(doc, '答案', 'answer-1');
  assert.equal(hark.roleOf(mine), 'user');
  assert.equal(hark.roleOf(reply), 'assistant');
  assert.deepEqual(hark.turns(doc, 'user'), [mine]);
  assert.deepEqual(hark.turns(doc, 'assistant'), [reply]);

  // 类名不再匹配时必须失败关闭，不能猜方向。
  const bubble = reply.querySelector('[data-testid="message-bubble"]');
  bubble.firstElementChild.className = '_151xtfxf _renamed';
  assert.throws(() => hark.roleOf(reply), /角色无法判定/);
});

test('hark 把没有气泡的富内容卡（summary-card）认成助手消息', () => {
  const doc = page().window.document;
  const mine = user(doc, '问一个问题', 'user-1');
  const rich = summaryAnswer(doc, '长回复被折叠成摘要卡', 'summary-1');
  // 富内容卡没有 message-bubble，必须靠结构而不是类名判定。
  assert.equal(rich.querySelector('[data-testid="message-bubble"]'), null);
  assert.equal(hark.roleOf(rich), 'assistant');
  assert.deepEqual(hark.turns(doc, 'user'), [mine]);
  assert.deepEqual(hark.turns(doc, 'assistant'), [rich]);
});

test('hark 在没有任何角色信号时按 user/assistant 交替兜底，而不是抛错', () => {
  const doc = page().window.document;
  user(doc, '第一问', 'user-1');
  answer(doc, '第一答', 'answer-1');
  // 一条既无气泡也无富内容标记的行：按交替规律应为用户。
  const list = doc.querySelector('[data-testid="message-list"]');
  list.insertAdjacentHTML('beforeend', '<div data-message-id="mystery-1" data-entry-kind="message"><div>未知结构</div></div>');
  const mystery = doc.querySelector('[data-message-id="mystery-1"]');
  assert.throws(() => hark.roleOf(mystery), /无法判定/);
  const users = hark.turns(doc, 'user');
  assert.equal(users.length, 2);
  assert.equal(users.at(-1), mystery);
});

test('hark 用快照差值确认本次新提问，并把内容不符的新消息当作归属失败', () => {
  const doc = page().window.document;
  user(doc, '先前问题', 'user-0');
  const baseline = hark.snapshot(doc);
  assert.equal(hark.newUsers(doc, baseline).length, 0);
  const mine = user(doc, '新问题', 'user-1');
  assert.equal(hark.findSubmittedUser(doc, baseline, '新问题'), mine);
  user(doc, '另一个问题', 'user-2');
  assert.throws(() => hark.findSubmittedUser(doc, baseline, '新问题'), /其他新消息/);
});

test('hark 正文尚未挂全的新提问只报 pending，不确认也不授权答案', () => {
  const doc = page().window.document;
  const baseline = hark.snapshot(doc);
  const node = user(doc, '这是一个很长的提问', 'user-1');
  node.querySelector('[data-testid="message-text"]').textContent = '这是一个';
  assert.equal(hark.findSubmittedUser(doc, baseline, '这是一个很长的提问'), null);
  assert.equal(hark.submittedUserPending(doc, baseline, '这是一个很长的提问'), true);
  assert.match(hark.submissionWaitReason(doc, baseline, '这是一个很长的提问'), /尚未完整/);
  node.querySelector('[data-testid="message-text"]').textContent = '这是一个很长的提问';
  assert.equal(hark.submittedUserPending(doc, baseline, '这是一个很长的提问'), false);
});

test('hark 只有本轮唯一的助手回复才算最终答案，多回复返回 null', () => {
  const doc = page().window.document;
  user(doc, '问题', 'user-0');
  const baseline = hark.snapshot(doc);
  const mine = user(doc, '新问题', 'user-1');
  assert.equal(hark.findSubmittedUser(doc, baseline, '新问题'), mine);
  // 还没有回复。
  assert.equal(hark.finalCandidate(doc, baseline, mine), null);
  answer(doc, '最终回复', 'answer-1');
  const candidate = hark.finalCandidate(doc, baseline, mine);
  assert.equal(candidate.text, '最终回复');
  assert.deepEqual(candidate.images, []);
  // 出现第二个助手回复 → 归属不明，返回 null。
  answer(doc, '另一个回复', 'answer-2');
  assert.equal(hark.finalCandidate(doc, baseline, mine), null);
});

test('hark 生成中的停止键会阻止新任务', () => {
  const doc = page().window.document;
  user(doc, '上一问', 'user-0');
  answer(doc, '上一答', 'answer-0');
  assert.equal(hark.generating(doc), false);
  assert.doesNotThrow(() => hark.assertReady(doc));
  stopButton(doc);
  assert.equal(hark.generating(doc), true);
  assert.throws(() => hark.assertReady(doc), /正在生成/);
});

test('hark 上一条提问没有助手回复时不允许发新问题', () => {
  const doc = page().window.document;
  user(doc, '没有回复的问题', 'user-0');
  assert.throws(() => hark.assertReady(doc), /尚未明确完成/);
});

test('hark 只转发本站图片，外部来源图片不转发也不阻塞文本', () => {
  const doc = page().window.document;
  const baseline = hark.snapshot(doc);
  user(doc, '新问题', 'user-1');
  const mine = hark.findSubmittedUser(doc, baseline, '新问题');
  const message = answer(doc, '答案', 'answer-1');
  const text = message.querySelector('[data-testid="message-text"]');
  text.insertAdjacentHTML('beforeend', '<img src="https://assets.hark.com/out.png"><img src="https://example.invalid/x.png">');
  const images = [...message.querySelectorAll('img')];
  loaded(images[0]); loaded(images[1]);
  const candidate = hark.finalCandidate(doc, baseline, mine);
  assert.equal(candidate.images.length, 1);
  assert.equal(candidate.images[0].src, 'https://assets.hark.com/out.png');
  assert.match(candidate.text, /答案/);
});

test('hark 附件只有在名称一一对应且不在上传中时才算就绪', () => {
  const doc = page().window.document;
  const input = hark.composer(doc);
  assert.deepEqual(hark.inputAttachmentState(input, []), { ready: true });
  assert.deepEqual(hark.inputAttachmentState(input, ['a.png']), { ready: false, reason: 'no-attachment' });
  attachment(doc, 'a.png');
  assert.deepEqual(hark.inputAttachmentState(input, ['a.png']), { ready: true });
  assert.deepEqual(hark.inputAttachmentState(input, ['b.png']), { ready: false, reason: 'name-mismatch' });
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
  const fetchImpl = async source => {
    assert.equal(source, 'https://assets.hark.com/out.png');
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const result = await hark.readAnswerImage({ src: 'https://assets.hark.com/out.png' }, { fetchImpl });
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.byteLength, png.length);
  assert.equal(Buffer.from(result.base64, 'base64').length, png.length);
  await assert.rejects(hark.readAnswerImage({ src: 'https://example.invalid/x.png' }, { fetchImpl }), /来源不受支持/);
  const htmlFetch = async () => new Response('nope', { status: 200, headers: { 'content-type': 'text/html' } });
  await assert.rejects(hark.readAnswerImage({ src: 'https://assets.hark.com/out.png' }, { fetchImpl: htmlFetch }), /仅支持 PNG/);
});

test('hark 选择器登记表可整体替换，非法键与非法值都被拒绝', () => {
  const original = { ...hark.SELECTORS };
  try {
    assert.throws(() => hark.applyCalibration({ composer: '' }), /无效/);
    assert.throws(() => hark.applyCalibration({ nope: '[x]' }), /未知的/);
    const applied = hark.applyCalibration({ answerBody: '[data-testid="message-text"], [data-markdown]' });
    assert.match(applied.answerBody, /data-markdown/);
    const doc = page().window.document;
    assert.ok(hark.composer(doc));
    // 换成一个页面上不存在的选择器：已标定的表找不到元素时，提示的是
    // "暂时找不到"而不是"尚未标定"，这两者必须区分开。
    hark.applyCalibration({ composer: '[data-testid="not-on-this-page"]' });
    assert.throws(() => hark.composer(doc), /暂时找不到/);
  } finally {
    hark.applyCalibration(original);
  }
  assert.equal(hark.SELECTORS.composer, original.composer);
});
