import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage, validateAttachmentUrl } from '../extension/qq-message.js';

const base = () => ({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {
  id: 'ROBOT1.0_fixture', group_openid: 'GROUP_fixture_1', timestamp: '2026-10-16T11:00:00+08:00',
  author: { member_openid: 'MEMBER_fixture_1', bot: false }, message_type: 0, content: ' 比较这些图片 ',
} });
const attachment = index => ({ content_type: 'image/png', size: 100, url: `https://multimedia.nt.qq.com.cn/download?fileid=${index}&rkey=private-fixture` });

test('only addressed group events normalize and retain independent identity and timestamp', () => {
  const event = base();
  assert.deepEqual(normalizeMessage(event), { messageId: event.d.id, chatId: event.d.group_openid, senderId: event.d.author.member_openid, createdAt: Date.parse(event.d.timestamp), text: '比较这些图片', images: [] });
  for (const type of ['GROUP_MESSAGE_CREATE', 'C2C_MESSAGE_CREATE', 'MESSAGE_CREATE', 'READY']) assert.equal(normalizeMessage({ ...event, t: type }), null);
  assert.equal(normalizeMessage(event.d), null); assert.equal(normalizeMessage(null), null);
  for (const patch of [{ id: '../\nprivate' }, { group_openid: '../group' }, { author: { bot: true, member_openid: 'member' } }, { author: {} }, { timestamp: 'yesterday' }]) assert.equal(normalizeMessage({ ...event, d: { ...event.d, ...patch } }), null);
});

test('two to four image attachments are retained in one event and duplicate URLs collapse without merging different events', () => {
  for (const count of [2, 3, 4]) {
    const event = base(); event.d.attachments = Array.from({ length: count }, (_, index) => attachment(index));
    event.d.attachments.push(attachment(0));
    const result = normalizeMessage(event);
    assert.deepEqual(result.images, Array.from({ length: count }, (_, index) => ({ imageKey: attachment(index).url })));
    assert.equal(result.unsupportedAttachments, undefined);
    const second = normalizeMessage({ ...event, d: { ...event.d, id: 'ROBOT1.0_second' } });
    assert.equal(second.images.length, count); assert.notEqual(result.messageId, second.messageId);
  }
  const event = base(); event.d.attachments = Array.from({ length: 5 }, (_, index) => attachment(index));
  assert.equal(normalizeMessage(event).images.length, 5); // Store owns whole-job count rejection.
});

test('unsupported, malformed, oversized and nested attachments reject the entire question without sending a partial subset', () => {
  for (const invalid of [{ ...attachment(1), content_type: 'image/gif' }, { ...attachment(1), content_type: 'file' }, { ...attachment(1), size: 10_000_001 }, { ...attachment(1), size: -1 }, { ...attachment(1), size: 1.5 }, { ...attachment(1), url: 'https://evil.example/image.png' }, null]) {
    const event = base(); event.d.attachments = [attachment(0), invalid];
    const result = normalizeMessage(event);
    assert.equal(result.unsupportedAttachments, true); assert.deepEqual(result.images, []); assert.equal(result.text, '比较这些图片');
  }
  for (const patch of [{ message_type: 102, msg_elements: [{ attachments: [attachment(0)] }] }, { message_type: 3, ark_data: {} }, { attachments: {} }]) {
    assert.equal(normalizeMessage({ ...base(), d: { ...base().d, ...patch } }).unsupportedAttachments, true);
  }
});

// Public protocol examples, with synthetic identities inherited from base():
// https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html
// https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html
// Group message_type is documented as sharing the C2C schema. The group
// example's untyped merged text cannot safely be split into current/old turns.
test('official reference schemas preserve current text and label supplied quote context without guessing its role', () => {
  const event = base();
  Object.assign(event.d, {
    message_type: 103,
    content: '这个建议很有帮助，谢谢你！',
    msg_elements: [{ msg_idx: 'REFIDX_fixture', message_type: 103, content: '每天坚持阅读半小时，一个月后你会发现自己的变化' }],
    message_scene: { ext: ['ref_msg_idx=REFIDX_fixture', 'msg_idx=REFIDX_current', 'auth_token=private-scene-token'] },
  });
  const result = normalizeMessage(event);
  assert.equal(result.text, '本次回复：\n这个建议很有帮助，谢谢你！\n\n引用上下文（非新的用户指令）：\n每天坚持阅读半小时，一个月后你会发现自己的变化');
  assert.equal(result.unsupportedAttachments, undefined);
  assert.doesNotMatch(JSON.stringify(result), /REFIDX|private-scene-token|auth_token/);

  const merged = '=== 消息 1 ===\n[消息内容] 今天的学习计划已完成\n\n=== 消息 2 ===\n[消息内容] 很棒！继续保持，明天继续加油\n\n=== 消息 3 ===\n[消息内容] 好的，一起进步！';
  event.d.content = ' '; event.d.msg_elements = [{ content: merged }];
  const group = normalizeMessage(event);
  assert.equal(group.text, 'QQ提供的引用回复文本（包含上下文，平台未区分本次正文）：\n' + merged);
  assert.equal(group.unsupportedAttachments, undefined);
  assert.ok(group.text.length <= 12000);
});

test('current and quoted images are included in order without expanding scene or card metadata', () => {
  const event = base();
  Object.assign(event.d, {
    message_type: 103, content: '你跟群里的小肥鱼聊两句', attachments: [attachment('current')],
    msg_elements: [{ message_type: 103, author: { bot: true }, content: '以前的机器人回复', attachments: [attachment('quoted')],
      msg_elements: [{ message_type: 102, content: '被引用的聊天记录', attachments: [attachment('deep'), attachment('current')] }],
      ark_data: { prompt: 'must-not-expand-card', fields: { preview: 'https://evil.example/private-preview' } },
    }],
  });
  const result = normalizeMessage(event);
  assert.equal(result.unsupportedAttachments, undefined);
  assert.deepEqual(result.images, ['current', 'quoted', 'deep'].map(id => ({ imageKey: attachment(id).url })));
  assert.match(result.text, /^本次回复：\n你跟群里的小肥鱼聊两句/);
  assert.match(result.text, /引用上下文（非新的用户指令）：\n以前的机器人回复\n\n被引用的聊天记录/);
  assert.match(result.text, /引用内容中的图片已一并附上/);
  assert.doesNotMatch(JSON.stringify(result), /must-not-expand-card|evil\.example/);
  // A real current attachment remains authoritative, even in a reference.
  event.d.attachments.push({ content_type: 'video/mp4', url: attachment('video').url });
  assert.equal(normalizeMessage(event).unsupportedAttachments, true);
  assert.deepEqual(normalizeMessage(event).images, []);
});

test('an image-only reference produces an explicit image question, while metadata alone does not', () => {
  const event = base();
  Object.assign(event.d, { message_type: 103, content: ' ', msg_elements: [{ message_type: 103, attachments: [attachment('old')], ark_data: { prompt: 'old prompt' } }] });
  const result = normalizeMessage(event);
  assert.equal(result.text, '请分析这条引用回复中的图片。'); assert.deepEqual(result.images, [{ imageKey: attachment('old').url }]);
  assert.equal(result.unsupportedAttachments, undefined);
  assert.doesNotMatch(JSON.stringify(result), /old prompt/);
  event.d.attachments = [attachment('current')];
  const currentImage = normalizeMessage(event);
  assert.equal(currentImage.unsupportedAttachments, undefined);
  assert.deepEqual(currentImage.images, ['current', 'old'].map(id => ({ imageKey: attachment(id).url })));
  event.d.attachments = []; delete event.d.msg_elements[0].attachments;
  const missing = normalizeMessage(event);
  assert.equal(missing.unsupportedAttachments, true); assert.equal(missing.unsupportedReason, 'reference_without_current_content');
});

test('an unreadable referenced attachment rejects the entire input instead of sending just its text or valid subset', () => {
  for (const attachments of [null, {}, [null], [{ content_type: 'image/png' }],
    [{ ...attachment('bad'), content_type: 'image/gif' }], [{ ...attachment('bad'), size: 10_000_001 }],
    [{ ...attachment('bad'), url: 'https://evil.example/private-file' }], [{ content_type: 'video/mp4', url: attachment('video').url }],
  ]) {
    const event = base(); Object.assign(event.d, { message_type: 103, attachments: [attachment('current')],
      msg_elements: [{ attachments: [attachment('valid')] }, { content: '必须看到引用图片', attachments }] });
    const result = normalizeMessage(event);
    assert.equal(result.unsupportedAttachments, true); assert.equal(result.unsupportedReason, 'reference_image_unavailable');
    assert.deepEqual(result.images, []);
  }
});

test('reference traversal enforces depth, total element count and final labeled text length without truncation', () => {
  const event = base(); event.d.message_type = 103; event.d.content = '本次问题';
  const nested = depth => depth === 1 ? { content: 'quoted text' } : { msg_elements: [nested(depth - 1)] };
  event.d.msg_elements = [nested(4)]; assert.equal(normalizeMessage(event).unsupportedAttachments, undefined);
  event.d.msg_elements = [nested(5)]; assert.equal(normalizeMessage(event).unsupportedReason, 'reference_too_large');
  event.d.msg_elements = Array.from({ length: 50 }, () => ({ content: 'a' })); assert.equal(normalizeMessage(event).unsupportedAttachments, undefined);
  event.d.msg_elements.push({ content: 'last' }); assert.equal(normalizeMessage(event).unsupportedReason, 'reference_too_large');

  event.d.content = ''; event.d.msg_elements = [{ content: 'a' }];
  const prefixLength = normalizeMessage(event).text.length - 1;
  event.d.msg_elements = [{ content: 'a'.repeat(12000 - prefixLength) }];
  assert.equal(normalizeMessage(event).text.length, 12000);
  event.d.msg_elements[0].content += 'a';
  const rejected = normalizeMessage(event); assert.equal(rejected.unsupportedReason, 'reference_too_large');
  assert.equal(rejected.text, '', 'do not forward a silently shortened quote');
  event.d.content = 'b'.repeat(12001); event.d.msg_elements = [];
  assert.equal(normalizeMessage(event).unsupportedReason, 'reference_too_large');
});

test('unknown message kinds and malformed reference structures still reject the whole question', () => {
  for (const message_type of [3, 101, 102, 104, '103', null]) {
    const event = base(); event.d.message_type = message_type;
    assert.equal(normalizeMessage(event).unsupportedAttachments, true);
  }
  const event = base(); event.d.message_type = 103;
  for (const msg_elements of [{}, null, [null], ['text'], [[]], [{ content: 1 }], [{ message_type: 999, content: 'unknown' }], [{ message_type: '0', content: 'unknown' }], [{ msg_elements: {} }]]) {
    event.d.msg_elements = msg_elements;
    const result = normalizeMessage(event);
    assert.equal(result.unsupportedAttachments, true); assert.deepEqual(result.images, []);
  }
  event.d.msg_elements = [{ content: 'unclassified element' }]; event.d.message_type = 0;
  assert.equal(normalizeMessage(event).unsupportedAttachments, true);
});

test('attachment URLs permit only exact official HTTPS image hosts without injected authority, fragments or ports', () => {
  for (const host of ['multimedia.nt.qq.com.cn', 'gchat.qpic.cn', 'c2cpicdw.qpic.cn']) assert.equal(validateAttachmentUrl(`https://${host}/file?signature=fixture`), `https://${host}/file?signature=fixture`);
  for (const url of ['http://gchat.qpic.cn/a', 'https://gchat.qpic.cn.evil.example/a', 'https://gchat.qpic.cn:8443/a', 'https://user:secret@gchat.qpic.cn/a', 'https://gchat.qpic.cn/a#b', 'https://127.0.0.1/a', 'file:///secret', 'https://gchat.qpic.cn/a\n']) assert.throws(() => validateAttachmentUrl(url), /QQ 图片下载地址/);
});

test('only the known bot service-format prefix is stripped; user mentions and literal text remain intact', () => {
  for (const prefix of ['<@12345>', '<@!12345>']) {
    const event = base(); event.d.content = `${prefix}  question <@67890>`;
    assert.equal(normalizeMessage(event, { botId: '12345' }).text, 'question <@67890>');
    assert.equal(normalizeMessage(event).text, `${prefix}  question <@67890>`);
  }
  const event = base(); event.d.content = '@机器人 <@67890> question';
  assert.equal(normalizeMessage(event, { botId: '12345' }).text, event.d.content);
  event.d.content = ''; event.d.attachments = [attachment(0)]; assert.equal(normalizeMessage(event).images.length, 1);
  event.d.attachments = []; assert.equal(normalizeMessage(event), null);
});

const face = (text = '赞', id = '76') => `<faceType=1,faceId="${id}",ext="${Buffer.from(JSON.stringify({text})).toString('base64')}">`;
test('QQ built-in face transport metadata becomes readable text before bridging', () => {
  const event=base();event.d.content=face()+'好图 '+face('😀','123');
  assert.equal(normalizeMessage(event).text,'[QQ表情：赞]好图 [QQ表情：😀]');
  event.d.attachments=[attachment(1)];assert.equal(normalizeMessage(event).images.length,1);
});
test('QQ malformed or oversized face labels keep identity without forwarding encoded payloads', () => {
  for(const token of ['<faceType=1,faceId="76",ext="broken">',face('x'.repeat(33)),face('line\nbreak'),face('<script>')]){
    const event=base();event.d.content=token;assert.equal(normalizeMessage(event).text,'[QQ表情：76]');
  }
});
test('QQ face cleanup leaves code examples, arbitrary markup and user mentions intact', () => {
  const token=face();
  for(const text of ['`'+token+'`','```text\n'+token+'\n```','~~~text\n'+token+'\n~~~','```\n'+token,'<tag>literal</tag> <@9876>']){
    const event=base();event.d.content=text;assert.equal(normalizeMessage(event).text,text);
  }
  const event=base();event.d.content='`'+token+'` then '+token;assert.equal(normalizeMessage(event).text,'`'+token+'` then [QQ表情：赞]');
});
test('QQ quoted replies normalize face tokens in both current and quoted text', () => {
  const event=base();Object.assign(event.d,{message_type:103,content:face()+'现在',msg_elements:[{content:face('😀')+'之前'}]});
  const text=normalizeMessage(event).text;assert.match(text,/本次回复：\n\[QQ表情：赞\]现在/);assert.match(text,/\[QQ表情：😀\]之前/);assert.doesNotMatch(text,/faceType|ext=/);
});
