import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import protobuf from 'protobufjs';
import { createBrowserFeishuAdapter, normalizeMessage, transportUuid, validateWebSocketEndpoint, validateImage } from '../extension/feishu-client.js';
import { encodeFrame, decodeFrame, EventAssembler } from '../extension/feishu-protocol.js';
import { buildCards, cardRequestBytes } from '../extension/cards.js';
import { buildAnswerPosts, answerPostRequestBytes } from '../extension/answer-post.js';

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const encoder = new TextEncoder();
const tick = () => new Promise(resolve => setImmediate(resolve));
const envelope = (messageId = 'om_source') => ({ schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: 'ev_one', app_id: 'cli_test' }, event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_human' } }, message: { message_id: messageId, chat_id: 'oc_group', chat_type: 'group', message_type: 'text', create_time: '1780000000000', mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }], content: JSON.stringify({ text: '@_user_1 Hello' }) } } });
function eventFrame(payload, { id = 'frame_one', seq = 0, sum = 1 } = {}) {
  return { SeqID: 9007199254740993n, LogID: 18446744073709551615n, service: 4, method: 1, headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: id }, { key: 'sum', value: String(sum) }, { key: 'seq', value: String(seq) }], payload: payload instanceof Uint8Array ? payload : encoder.encode(JSON.stringify(payload)) };
}
async function setup(t, { request, onMessage, autoOpen = true, assistant = 'chatgpt' } = {}) {
  const calls = []; const states = []; const messages = []; const sockets = []; const timers = new Map(); let timerId = 0; let now = 1780000000000;
  const schedule = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; };
  class FakeSocket extends EventTarget {
    constructor(url) { super(); this.url = url; this.sent = []; this.readyState = 0; sockets.push(this); if (autoOpen) queueMicrotask(() => this.open()); }
    open() { if (this.readyState !== 0) return; this.readyState = 1; this.dispatchEvent(new Event('open')); }
    send(value) { if (this.readyState !== 1) throw new Error('closed'); this.sent.push(decodeFrame(value)); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
    frame(frame) { this.dispatchEvent(new MessageEvent('message', { data: encodeFrame(frame).buffer })); }
  }
  const fetch = async (url, options) => {
    const parsed = new URL(url); const body = options.body instanceof FormData ? options.body : options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url: parsed, ...options, body });
    const custom = request ? await request(parsed.pathname, body, options, calls) : undefined;
    if (custom instanceof Response) return custom;
    if (custom !== undefined) return new Response(JSON.stringify(custom), { headers: { 'content-type': 'application/json' } });
    let result;
    if (parsed.pathname.endsWith('/tenant_access_token/internal')) result = { code: 0, tenant_access_token: 'tenant-secret', expire: 7200 };
    else if (parsed.pathname === '/open-apis/bot/v3/info') result = { code: 0, bot: { open_id: 'ou_bot' } };
    else if (parsed.pathname === '/callback/ws/endpoint') result = { code: 0, data: { URL: 'wss://msg-frontier.feishu.cn/ws/v2?service_id=4&device_id=test&ticket=private', ClientConfig: { PingInterval: 30, ReconnectInterval: 1, ReconnectNonce: 0, ReconnectCount: -1 } } };
    else if (parsed.pathname.includes('/resources/')) return new Response(png, { headers: { 'content-type': 'image/png' } });
    else if (parsed.pathname === '/open-apis/im/v1/images') result = { code: 0, data: { image_key: 'img_returned' } };
    else result = { code: 0, data: { message_id: 'om_reply' } };
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  };
  const adapter = createBrowserFeishuAdapter({ assistant, appId: 'cli_test', appSecret: 'app-secret', onMessage: async message => { messages.push(message); if (onMessage) return onMessage(message); }, onState: state => states.push(state) }, { fetch, WebSocket: FakeSocket, now: () => now, wait: async ms => { now += ms; }, setTimeout: schedule, clearTimeout: id => timers.delete(id), random: () => 0 });
  t.after(() => adapter.stop());
  return { adapter, calls, states, messages, sockets, timers, advance(ms) { now += ms; }, async flush() { for (let index = 0; index < 6; index++) await tick(); }, runTimer(delay) { const [id, timer] = [...timers].find(([, item]) => item.delay === delay) ?? []; assert.ok(timer, `timer ${delay}`); timers.delete(id); now += delay; timer.callback(); } };
}

test('browser protobuf codec matches the official Frame schema and preserves uint64 acknowledgements', () => {
  const root = protobuf.parse('syntax="proto2"; message Header { required string key=1; required string value=2; } message Frame { required uint64 SeqID=1; required uint64 LogID=2; required int32 service=3; required int32 method=4; repeated Header headers=5; optional string payloadEncoding=6; optional string payloadType=7; optional bytes payload=8; optional string LogIDNew=9; }').root;
  const Frame = root.lookupType('Frame'); const input = eventFrame(envelope());
  const encoded = encodeFrame(input); const official = Frame.decode(encoded);
  assert.equal(official.SeqID.toString(), input.SeqID.toString()); assert.equal(official.LogID.toString(), input.LogID.toString());
  const decoded = decodeFrame(Frame.encode(official).finish());
  assert.deepEqual(decoded, input);
  for (const value of [new Uint8Array(), encoded.subarray(0, encoded.length - 1), Uint8Array.from([8, 255, 255])]) assert.throws(() => decodeFrame(value));
});

test('fragment reassembly handles out-of-order duplicates and rejects ambiguous or oversized metadata', () => {
  const assembler = new EventAssembler(); const payload = encoder.encode(JSON.stringify(envelope())); const midpoint = 73;
  assert.equal(assembler.add(eventFrame(payload.subarray(midpoint), { seq: 1, sum: 2 })), null);
  assert.equal(assembler.add(eventFrame(payload.subarray(midpoint), { seq: 1, sum: 2 })), null);
  assert.deepEqual(assembler.add(eventFrame(payload.subarray(0, midpoint), { seq: 0, sum: 2 })).payload, envelope());
  assert.throws(() => assembler.add(eventFrame(payload, { sum: 1000000 })), /格式无效/);
  assembler.add(eventFrame(payload.subarray(0, 10), { seq: 0, sum: 2 }));
  assert.throws(() => assembler.add(eventFrame(payload.subarray(1, 11), { seq: 0, sum: 2 })), /格式无效/);
});

test('start uses only official APIs, connects once, sends protobuf ping and validates inbound mentions', async t => {
  const x = await setup(t); await Promise.all([x.adapter.start(), x.adapter.start()]);
  assert.equal(x.sockets.length, 1);
  assert.deepEqual(x.calls.map(call => call.url.pathname), ['/open-apis/auth/v3/tenant_access_token/internal', '/open-apis/bot/v3/info', '/callback/ws/endpoint']);
  assert.deepEqual(x.calls[0].body, { app_id: 'cli_test', app_secret: 'app-secret' });
  assert.deepEqual(x.calls[2].body, { AppID: 'cli_test', AppSecret: 'app-secret' });
  assert.ok(x.calls.every(call => call.url.origin === 'https://open.feishu.cn' && call.redirect === 'error' && call.credentials === 'omit'));
  assert.equal(x.sockets[0].sent[0].headers[0].value, 'ping');
  x.sockets[0].frame(eventFrame(envelope())); await x.flush();
  assert.equal(x.messages.length, 1); assert.equal(x.messages[0].text, 'Hello');
  const ack = x.sockets[0].sent.at(-1); assert.equal(ack.SeqID, 9007199254740993n); assert.equal(JSON.parse(new TextDecoder().decode(ack.payload)).code, 200);
  x.sockets[0].frame(eventFrame(envelope())); await x.flush();
  assert.equal(x.messages.length, 1); assert.equal(x.sockets[0].sent.length, 3);
  const other = envelope(); other.event.message.mentions[0].id.open_id = 'ou_other';
  x.sockets[0].frame(eventFrame(other, { id: 'ignored' })); await x.flush(); assert.equal(x.messages.length, 1);
  assert.deepEqual(x.states.map(state => state.state), ['connecting', 'connected']);
});

test('ACK waits for durable ingestion, retries failed ingestion and reassembles fragmented events', async t => {
  let release; let fail = true;
  const x = await setup(t, { onMessage: () => fail ? Promise.reject(new Error('private event body must not escape')) : new Promise(resolve => { release = resolve; }) });
  await x.adapter.start(); const ws = x.sockets[0];
  const payload = encoder.encode(JSON.stringify(envelope()));
  ws.frame(eventFrame(payload.subarray(70), { seq: 1, sum: 2 })); ws.frame(eventFrame(payload.subarray(0, 70), { seq: 0, sum: 2 })); await x.flush();
  assert.equal(JSON.parse(new TextDecoder().decode(ws.sent.at(-1).payload)).code, 500);
  fail = false; ws.frame(eventFrame(envelope())); await x.flush();
  assert.equal(ws.sent.length, 2); release(); await x.flush();
  assert.equal(JSON.parse(new TextDecoder().decode(ws.sent.at(-1).payload)).code, 200);
  assert.doesNotMatch(JSON.stringify(x.states), /private event|app-secret|tenant-secret|ticket/);
});

test('disconnect reacquires endpoint and stop prevents old events, reconnects and API requests', async t => {
  const x = await setup(t); await x.adapter.start(); const old = x.sockets[0]; old.close();
  assert.equal(x.states.at(-1).state, 'reconnecting'); x.runTimer(1000); await x.flush();
  assert.equal(x.sockets.length, 2); assert.equal(x.states.at(-1).state, 'connected');
  assert.equal(x.calls.filter(call => call.url.pathname === '/callback/ws/endpoint').length, 2);
  await x.adapter.stop(); old.frame(eventFrame(envelope())); x.sockets[1].frame(eventFrame(envelope())); await x.flush();
  assert.equal(x.messages.length, 0); assert.equal(x.timers.size, 0);
  await assert.rejects(x.adapter.reply('om_source', 'hello', 'request'), /停止/);
});

test('unsafe websocket endpoints and server error text never leak credentials or create foreign sockets', async t => {
  for (const value of ['ws://msg-frontier.feishu.cn/ws?service_id=1', 'wss://feishu.cn.evil.test/ws?service_id=1', 'wss://user:secret@msg-frontier.feishu.cn/ws?service_id=1', 'wss://msg-frontier.feishu.cn:8443/ws?service_id=1', 'wss://127.0.0.1/ws?service_id=1', 'wss://msg-frontier.feishu.cn/ws?service_id=bad']) assert.throws(() => validateWebSocketEndpoint(value));
  const x = await setup(t, { request: pathname => pathname === '/callback/ws/endpoint' ? { code: 0, data: { URL: 'wss://evil.test/ws?service_id=1&secret=app-secret' } } : undefined });
  await assert.rejects(x.adapter.start(), /官方域名/); assert.equal(x.sockets.length, 0);
  assert.doesNotMatch(JSON.stringify(x.states), /app-secret|tenant-secret|evil\.test/);
});

test('text and cards preserve deterministic UUIDs, safe text and serial PATCH before continuations', async t => {
  const x = await setup(t); await x.adapter.start();
  await x.adapter.reply('om_source', '<at id="all">All</at> hello', 'request');
  await x.adapter.createCard('om_source', 'request');
  await x.adapter.updateCard('om_reply', { state: 'completed', text: '中文'.repeat(20000), requestId: 'request', sourceMessageId: 'om_source' });
  const sends = x.calls.filter(call => call.url.pathname.includes('/messages/'));
  assert.match(JSON.parse(sends[0].body.content).text, /^＜at/);
  assert.equal(sends[0].body.uuid, createHash('sha256').update(JSON.stringify(['feishu-reply-v1', 'request', 'om_source', 0])).digest('hex').slice(0, 48));
  assert.equal(sends[2].method, 'PATCH'); assert.ok(sends.slice(3).every(call => call.method === 'POST'));
  assert.ok(sends.filter(call => call.body.msg_type === 'interactive').every(call => cardRequestBytes(JSON.parse(call.body.content)) <= 24000));
  assert.notEqual(await transportUuid('feishu-image-reply-v1', 'request', 'om_source'), sends[0].body.uuid);
  assert.equal(buildCards({ state: 'blocked' })[0].header.title.content, 'ChatGPT · 已拦截');
});

test('cancelled Feishu status updates reuse the card and display the selected assistant', async t => {
  for (const assistant of ['chatgpt', 'claude', 'gemini']) {
    const x = await setup(t, { assistant }); await x.adapter.start();
    await x.adapter.updateCard('om_existing_card', { state: 'cancelled', requestId: 'cancel-job', sourceMessageId: 'om_source' });
    const sends = x.calls.filter(call => call.url.pathname.includes('/messages/'));
    assert.equal(sends.length, 1); assert.equal(sends[0].method, 'PATCH');
    assert.ok(sends[0].url.pathname.endsWith('/om_existing_card'));
    const card = JSON.parse(sends[0].body.content);
    const name = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' }[assistant];
    assert.equal(card.header.title.content, `${name} · 已取消`);
    assert.equal(card.header.template, 'grey');
    assert.equal(card.body.elements[0].content, `已手动取消，未发送到 ${name}。`);
  }
});

test('images use bounded Uint8Array download, Blob FormData upload and message-scoped official resource paths', async t => {
  const x = await setup(t); await x.adapter.start();
  const image = await x.adapter.downloadImage({ messageId: 'om_source', imageKey: 'img_original' });
  assert.ok(image.buffer instanceof Uint8Array); assert.deepEqual(image.buffer, png);
  const uploaded = await x.adapter.uploadImage(image); assert.equal(uploaded.imageKey, 'img_returned'); assert.equal(uploaded.bytes, png.length);
  const call = x.calls.find(call => call.url.pathname === '/open-apis/im/v1/images');
  assert.equal(call.body.get('image_type'), 'message'); assert.equal(call.body.get('image').type, 'image/png'); assert.equal(call.headers['Content-Type'], undefined);
  assert.deepEqual(new Uint8Array(await call.body.get('image').arrayBuffer()), png);
  const sent = await x.adapter.replyImage({ messageId: 'om_source', imageKey: uploaded.imageKey, requestId: 'request' });
  assert.equal(sent.messageId, 'om_reply');
  assert.throws(() => validateImage(png, 'image/jpeg'), /不一致/);
  await assert.rejects(x.adapter.downloadImage({ messageId: '../other', imageKey: 'img_original' }), /标识/);
  const resource = x.calls.find(call => call.url.pathname.includes('/resources/')); assert.equal(resource.url.search, '?type=image');
});

test('definitively rejected tenant tokens refresh once; malformed success receipts remain failures', async t => {
  let rejected = false;
  const x = await setup(t, { request: path => {
    if (path.endsWith('/reply') && !rejected) { rejected = true; return { code: 99991663, msg: 'tenant-secret' }; }
    if (path.endsWith('/reply')) return { code: 0, data: {} };
  } });
  await x.adapter.start(); await assert.rejects(x.adapter.createCard('om_source', 'request'), /消息 ID/);
  assert.equal(x.calls.filter(call => call.url.pathname.endsWith('/tenant_access_token/internal')).length, 2);
  assert.equal(x.calls.filter(call => call.url.pathname.endsWith('/reply')).length, 2);
});

test('normalization accepts same-post images with explicit bot mention and ignores forwarded/foreign content', () => {
  const input = envelope(); input.event.message.message_type = 'post'; input.event.message.content = JSON.stringify({ title: 'Title', content: [[{ tag: 'at', user_id: '@_user_1' }, { tag: 'text', text: 'Describe' }, { tag: 'img', image_key: 'img_source' }]] });
  assert.deepEqual(normalizeMessage(input, 'ou_bot').images, [{ imageKey: 'img_source' }]);
  input.event.sender.sender_type = 'app'; assert.equal(normalizeMessage(input, 'ou_bot'), null);
});

test('initial transient bootstrap failure retries automatically and stop cancels a pending handshake', async t => {
  let authAttempts = 0;
  const x = await setup(t, { request: path => {
    if (path.endsWith('/tenant_access_token/internal') && ++authAttempts === 1) throw new Error('network failed with app-secret');
  } });
  await assert.rejects(x.adapter.start(), /连接或接口请求失败/);
  assert.equal(x.states.at(-1).state, 'reconnecting');
  x.runTimer(5000); await x.flush();
  assert.equal(x.sockets.length, 1); assert.equal(x.states.at(-1).state, 'connected');
  assert.doesNotMatch(JSON.stringify(x.states), /app-secret/);

  const y = await setup(t, { autoOpen: false });
  const pending = y.adapter.start(); const rejected = assert.rejects(pending, /建立失败/);
  await y.flush(); assert.equal(y.sockets.length, 1);
  await y.adapter.stop(); await rejected;
  assert.equal(y.timers.size, 0); y.sockets[0].open();
  assert.equal(y.states.at(-1).state, 'stopped');
});

test('pong keeps the socket alive while a missed heartbeat reconnects and stop removes all timers', async t => {
  const x = await setup(t); await x.adapter.start(); const ws = x.sockets[0];
  ws.frame({ SeqID: 0n, LogID: 0n, service: 4, method: 0, headers: [{ key: 'type', value: 'pong' }] });
  await x.flush();
  assert.equal(x.timers.size, 1);
  x.runTimer(30000); assert.equal(ws.sent.length, 2); assert.equal(ws.readyState, 1);
  x.runTimer(30000); assert.equal(ws.readyState, 3); assert.equal(x.states.at(-1).state, 'reconnecting');
  x.runTimer(1000); await x.flush(); assert.equal(x.sockets.length, 2);
  await x.adapter.stop(); assert.equal(x.timers.size, 0);
});

test('request timeout waits for the original fetch to settle before a queued mutation can run', async t => {
  let release; let entered; let stalledSignal;
  const started = new Promise(resolve => { entered = resolve; });
  const x = await setup(t, { request: async (path, _body, options) => {
    if (path.endsWith('/reply')) {
      stalledSignal = options.signal; entered();
      await new Promise(resolve => { release = resolve; });
      return { code: 0, data: { message_id: 'om_first' } };
    }
  } });
  await x.adapter.start();
  const first = x.adapter.createCard('om_source', 'request');
  const rejected = assert.rejects(first, /超时或已取消/);
  await started;
  const second = x.adapter.updateCard('om_card', { state: 'completed', text: 'done', requestId: 'request', sourceMessageId: 'om_source' });
  x.runTimer(20000); await x.flush();
  assert.equal(stalledSignal.aborted, true);
  assert.equal(x.calls.filter(call => call.method === 'PATCH').length, 0);
  release(); await rejected; await second;
  const mutations = x.calls.filter(call => call.url.pathname.includes('/messages/'));
  assert.deepEqual(mutations.map(call => call.method), ['POST', 'PATCH']);
});

test('native post replies freeze content and use stable per-part UUIDs with validated receipts', async t => {
  const x = await setup(t); await x.adapter.start();
  const post = buildAnswerPosts('说明\n```python\n  print("hello")\n```')[0];
  const original = structuredClone(post);
  const sending = x.adapter.replyPost('om_source', post, 'job:post:0');
  post.zh_cn.content[0][0].text = 'mutated after enqueue';
  const receipt = await sending;
  await x.adapter.replyPost('om_source', original, 'job:post:0');
  await x.adapter.replyPost('om_source', original, 'job:post:1');
  const sends = x.calls.filter(call => call.url.pathname.endsWith('/reply'));
  assert.deepEqual(JSON.parse(sends[0].body.content), original);
  assert.equal(sends[0].body.msg_type, 'post'); assert.equal(receipt.messageId, 'om_reply');
  assert.equal(receipt.uuid, createHash('sha256').update(JSON.stringify(['feishu-answer-post-v1', 'job:post:0', 'om_source', 0])).digest('hex').slice(0, 48));
  assert.equal(sends[0].body.uuid, sends[1].body.uuid); assert.notEqual(sends[1].body.uuid, sends[2].body.uuid);
  assert.ok(sends.every(call => answerPostRequestBytes(JSON.parse(call.body.content)) <= 24000));
  await assert.rejects(x.adapter.replyPost('om_source', { zh_cn: { title: '', content: [[{ tag: 'at', user_id: 'all' }]] } }, 'job:post:2'), /富文本回复正文/);
  assert.equal(x.calls.filter(call => call.url.pathname.endsWith('/reply')).length, 3);
});

test('sending card state reaches the PATCH API with fixed status text before native answer delivery', async t => {
  const x = await setup(t); await x.adapter.start();
  await x.adapter.updateCard('om_status', { state: 'sending', text: 'private answer must stay out of status', requestId: 'job', sourceMessageId: 'om_source' });
  await x.adapter.replyPost('om_source', buildAnswerPosts('正文\n```python\nprint(1)\n```')[0], 'job:post:0');
  const mutations = x.calls.filter(call => call.url.pathname.includes('/messages/'));
  assert.deepEqual(mutations.map(call => call.method), ['PATCH', 'POST']);
  assert.equal(mutations[0].url.pathname, '/open-apis/im/v1/messages/om_status');
  const status = JSON.parse(mutations[0].body.content);
  assert.equal(status.header.title.content, 'ChatGPT · 正在发送');
  assert.equal(status.body.elements[0].content, '回复已生成，正在发送正文和图片。');
  assert.doesNotMatch(mutations[0].body.content, /private answer/);
  assert.equal(mutations[1].body.msg_type, 'post');
});

test('Claude card headers and progress describe Claude without rewriting answer text', async t => {
  const x=await setup(t,{assistant:'claude'});await x.adapter.start();
  await x.adapter.createCard('om_source','fixture-claude');
  await x.adapter.updateCard('om_reply',{state:'running',requestId:'fixture-claude',sourceMessageId:'om_source'});
  await x.adapter.updateCard('om_reply',{state:'completed',text:'Claude and ChatGPT comparison',requestId:'fixture-claude',sourceMessageId:'om_source'});
  const cards=x.calls.filter(c=>c.body?.content).map(c=>JSON.parse(c.body.content));
  assert.equal(cards.length,3);
  assert.ok(cards.every(c=>c.header.title.content.startsWith('Claude · ')));
  assert.match(cards[0].body.elements[0].content,/Claude/);
  assert.match(cards[1].body.elements[0].content,/Claude/);
  assert.equal(cards[2].body.elements[0].content,'Claude and ChatGPT comparison');
});
