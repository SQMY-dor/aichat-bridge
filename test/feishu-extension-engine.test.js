import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeStore } from '../extension/feishu-store.js';
import { ExtensionEngine } from '../extension/feishu-runtime.js';
import { createWordFilter } from '../extension/moderation.js';
import { normalizeMessage } from '../extension/feishu-message.js';

const caller = { chatId: 'oc_engine', browserId: 'browser-engine', tabId: 9, conversationUrl: 'https://chatgpt.com/c/engine-fixture-1234', capabilities: ['image-input-v1'] };
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB2sAAAAASUVORK5CYII=', 'base64'));
async function setup({ configured = true, adapterOverrides = {}, savedWords } = {}) {
  let state = null; const images = new Map(); let config = configured ? { appId: 'cli_fixture', appSecret: 'fixture-secret', ...(savedWords ? { words: savedWords } : {}) } : null;
  const clock = { now: Date.now() }; const lifecycle = [];
  let filter = createWordFilter(['测试禁词']);
  const store = await BridgeStore.open({ storage: {
    async readState() { return structuredClone(state); },
    async readImage(key) { return images.get(key) ?? null; },
    async listImageKeys() { return [...images.keys()]; },
    async commit({ expectedRevision, state: next, putImages = [], deleteImages = [] }) {
      assert.equal(state?.revision ?? 0, expectedRevision);
      for (const image of putImages) images.set(image.key, image.blob);
      for (const key of deleteImages) images.delete(key);
      state = structuredClone({ ...next, revision: expectedRevision + 1 });
      return state.revision;
    },
  }, now: () => clock.now, moderate: prompt => filter(prompt) });
  const calls = []; let receiver;
  const engine = new ExtensionEngine({ store,
    readConfig: async () => structuredClone(config), writeConfig: async value => { config = structuredClone(value); },
    defaultWords: ['测试禁词'], setWords: words => { filter = createWordFilter(words); },
    adapterFactory: ({ onMessage, onState }) => {
      receiver = onMessage;
      return {
        async start() { lifecycle.push('start'); onState({ state: 'connected' }); }, async stop() { lifecycle.push('stop'); onState({ state: 'stopped' }); },
        async reply(...args) { calls.push(['reply', ...args]); },
        async replyPost(...args) { calls.push(['replyPost', ...args]); return { messageId: 'om_post', uuid: args[2] }; },
        async createCard(...args) { calls.push(['createCard', ...args]); return { messageId: 'om_card' }; },
        async updateCard(...args) { calls.push(['updateCard', ...args]); },
        async downloadImage(args) { calls.push(['downloadImage', args]); return { buffer: PNG, mimeType: 'image/png' }; },
        async uploadImage(args) { calls.push(['uploadImage', args]); return { imageKey: 'img_uploaded' }; },
        async replyImage(args) { calls.push(['replyImage', args]); },
        ...adapterOverrides,
      };
    },
  });
  await engine.init(); await engine.connecting;
  return { engine, store, calls, images, clock, lifecycle, state: () => structuredClone(state), config: () => config, receive: (id, text = '普通问题', extras = {}) => receiver({ messageId: id, chatId: caller.chatId, text, createdAt: clock.now, ...extras }) };
}

test('pure-extension receive filters before any image work and safe question reaches one webpage result', async () => {
  const f = await setup(); await f.store.bind(caller);
  assert.equal((await f.receive('om_blocked', '测试 禁词', { images: [{ imageKey: 'img_blocked' }] })).blocked, true);
  await f.engine.tick();
  assert.deepEqual(f.calls.map(c => c[0]), ['reply']);
  assert.equal((await f.store.status()).jobs.length, 0);
  await f.receive('om_normal'); await f.engine.tick();
  const job = (await f.engine.request('/v1/poll', caller)).job;
  await f.engine.request(`/v1/jobs/${job.id}/started`, { ...caller, leaseToken: job.leaseToken });
  await f.engine.request(`/v1/jobs/${job.id}/result`, { ...caller, leaseToken: job.leaseToken, text: '正常回答' });
  await f.engine.tick();
  assert.equal((await f.engine.status()).jobs[0].state, 'completed');
  assert.equal(f.calls.at(-1)[0], 'updateCard');
  assert.equal(f.calls.at(-1)[2].state, 'sending');
  assert.doesNotMatch(f.calls.at(-1)[2].text, /正常回答|已发送/);
  await f.engine.tick();
  assert.equal(f.calls.at(-1)[0], 'replyPost');
  assert.match(JSON.stringify(f.calls.at(-1)[2]), /正常回答/);
  await f.engine.tick();
  assert.equal(f.calls.at(-1)[0], 'updateCard');
  assert.equal(f.calls.at(-1)[2].state, 'completed');
  assert.match(f.calls.at(-1)[2].text, /正文已发送/);
  assert.ok(f.calls.filter(call => call[0] === 'updateCard').every(call => !call[2].text.includes('正常回答')));
  assert.doesNotMatch(JSON.stringify(await f.engine.status()), /fixture-secret|普通问题|正常回答/);
});

test('async simultaneous ticks cannot overlap delivery', async () => {
  let release; let count = 0;
  const f = await setup({ adapterOverrides: { reply: async () => { count++; await new Promise(resolve => { release = resolve; }); } } });
  await f.receive('om_blocked', '测试禁词');
  const tick = f.engine.tick();
  for (let i = 0; i < 10 && !release; i++) await new Promise(resolve => setImmediate(resolve));
  await f.engine.tick(); assert.equal(count, 1); release(); await tick;
});

test('word list is persistent, hot applies to queued jobs, rejects invalid replacement and never leaks matches', async () => {
  const f = await setup(); await f.store.bind(caller);
  await f.receive('om_will_block', '新增短语');
  await f.engine.request('/v1/moderation', { words: ['测试禁词', '新增短语'] });
  assert.deepEqual(f.config().words, ['测试禁词', '新增短语']);
  assert.equal((await f.store.poll(caller)).job, null);
  assert.equal((await f.store.status()).jobs[0].state, 'failed');
  await assert.rejects(f.engine.saveWords({ words: [] }), /词表格式/);
  assert.equal(f.engine.words().words.length, 2);
  assert.doesNotMatch(JSON.stringify(await f.store.status()), /新增短语/);
});

test('migration imports bindings and seen markers before connecting, without old prompts or leases', async () => {
  const f = await setup({ configured: false });
  assert.equal((await f.engine.status()).configured, false);
  await f.engine.importConfiguration({ format: 'feishu-chatgpt-extension-migration-v1', appId: 'cli_fixture', appSecret: 'fixture-secret',
    groups: [{ chatId: caller.chatId, binding: caller }], seen: { om_previously_received: Date.now() } });
  await f.engine.connecting;
  assert.equal((await f.receive('om_previously_received')).duplicate, true);
  assert.equal((await f.engine.status()).groups[0].binding.tabId, caller.tabId);
  assert.equal((await f.engine.status()).jobs.length, 0);
  assert.equal((await f.engine.status()).replyStyle, 'separate');
  await assert.rejects(f.engine.importConfiguration({}), /不能覆盖导入/);
});

test('invalid saved moderation fails closed without contacting GPT', async () => {
  const f = await setup({ savedWords: [] }); await f.store.bind(caller);
  assert.equal((await f.receive('om_invalid_config')).blocked, true);
  assert.equal((await f.engine.status()).moderation.valid, false);
  assert.equal((await f.store.poll(caller)).job, null);
  await f.engine.saveWords({ words: ['测试禁词'] });
  assert.equal((await f.receive('om_recovered')).accepted, true);
});

test('input and output pixels traverse browser storage and adapter once, then are removed', async () => {
  const f = await setup(); await f.store.bind(caller);
  await f.receive('om_image', '描述图片', { images: [{ imageKey: 'img_source' }] });
  await f.engine.tick(); await f.engine.tick();
  const job = (await f.store.poll(caller)).job; const auth = { ...caller, leaseToken: job.leaseToken };
  await f.store.started(job.id, auth);
  const incoming = await f.store.inputImage(job.id, { ...auth, imageId: job.images[0].id });
  assert.deepEqual(Uint8Array.from(Buffer.from(incoming.base64, 'base64')), PNG);
  const image = await f.store.image(job.id, { ...auth, index: 0, mimeType: 'image/png', base64: incoming.base64 });
  await f.store.result(job.id, { ...auth, text: '', images: [image.imageId] });
  for (let i = 0; i < 4; i++) await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'downloadImage').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'uploadImage').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'replyImage').length, 1);
  assert.equal(f.images.size, 0);
});

test('changing app cannot race a new binding into the gap before credential persistence', async () => {
  const f = await setup();
  const originalWrite = f.engine.writeConfig;
  let release; let entered;
  const writing = new Promise(resolve => { entered = resolve; });
  f.engine.writeConfig = async value => { entered(); await new Promise(resolve => { release = resolve; }); await originalWrite(value); };
  const change = f.engine.configure({ appId: 'cli_new', appSecret: 'new-fixture-secret' });
  await writing;
  await assert.rejects(f.engine.request('/v1/bind', caller), error => error.status === 409);
  release(); await change; await f.engine.connecting;
  assert.equal((await f.engine.status()).appId, 'cli_new');
  assert.equal((await f.store.status()).groups.length, 0);
});

test('transient startup failure retains reconnecting state from the transport', async () => {
  const f = await setup({ configured: false });
  f.engine.adapterFactory = ({ onState }) => ({
    async start() { onState({ state: 'reconnecting', error: '等待网络恢复' }); throw new Error('transient'); }, async stop() {},
  });
  await f.engine.configure({ appId: 'cli_fixture', appSecret: 'fixture-secret' }); await f.engine.connecting;
  assert.equal((await f.engine.status()).feishu.state, 'reconnecting');
});

test('reply style is configurable without credentials and a failed save leaves the previous style usable', async () => {
  const f = await setup({ configured: false });
  assert.equal((await f.engine.request('/v1/status')).replyStyle, 'separate');
  assert.deepEqual(await f.engine.request('/v1/config', { replyStyle: 'card' }), { ok: true, replyStyle: 'card' });
  assert.equal((await f.engine.status()).configured, false);
  assert.equal((await f.engine.status()).replyStyle, 'card');
  assert.equal(f.config().replyStyle, 'card'); assert.deepEqual(f.lifecycle, []);
  const write = f.engine.writeConfig;
  f.engine.writeConfig = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(f.engine.configure({ replyStyle: 'separate' }), /storage unavailable/);
  assert.equal((await f.engine.status()).replyStyle, 'card'); assert.equal(f.engine.configBusy, false);
  f.engine.writeConfig = write;
  await f.engine.configure({ replyStyle: 'separate' });
  assert.equal((await f.engine.status()).replyStyle, 'separate');
});

test('reply style saves during delivery without stopping or reconnecting the current adapter', async () => {
  let release; let entered;
  const sending = new Promise(resolve => { entered = resolve; });
  const f = await setup({ adapterOverrides: { reply: async () => { entered(); await new Promise(resolve => { release = resolve; }); } } });
  await f.receive('om_inflight_notice', '测试禁词');
  const adapter = f.engine.adapter; const tick = f.engine.tick(); await sending;
  assert.equal(f.engine.deliveryBusy, true);
  await f.engine.configure({ replyStyle: 'card' });
  assert.equal(f.engine.adapter, adapter); assert.deepEqual(f.lifecycle, ['start']);
  assert.equal((await f.engine.status()).replyStyle, 'card');
  release(); await tick; assert.equal(f.engine.deliveryBusy, false);
});

test('invalid reply styles fail before storage or connection mutations and credential saves preserve omitted style', async () => {
  const f = await setup(); const adapter = f.engine.adapter;
  for (const replyStyle of [null, '', 'markdown', false, 1, {}]) {
    await assert.rejects(f.engine.configure({ replyStyle }), /回复方式无效/);
    await assert.rejects(f.engine.configure({ appId: 'cli_fixture', appSecret: 'changed', replyStyle }), /回复方式无效/);
  }
  assert.deepEqual(f.lifecycle, ['start']); assert.equal(f.engine.adapter, adapter);
  assert.equal(f.config().replyStyle, undefined); assert.equal(f.engine.configBusy, false);
  await f.engine.configure({ replyStyle: 'card' });
  await f.engine.configure({ appId: 'cli_fixture', appSecret: '' }); await f.engine.connecting;
  assert.equal(f.config().replyStyle, 'card'); assert.equal(f.config().appSecret, 'fixture-secret');
  assert.equal((await f.engine.status()).replyStyle, 'card'); assert.deepEqual(f.lifecycle, ['start', 'stop', 'start']);
});

test('changing reply style snapshots new incoming jobs without rewriting running jobs or persisted answer posts', async () => {
  const f = await setup(); await f.store.bind(caller);
  await f.receive('om_separate_snapshot');
  const first = (await f.store.poll(caller)).job; const auth = { ...caller, leaseToken: first.leaseToken };
  await f.store.started(first.id, auth);
  await f.engine.configure({ replyStyle: 'card' });
  await f.store.result(first.id, { ...auth, text: 'retained independent answer' });
  const frozen = f.state().outbox.filter(item => item.kind === 'post'); assert.equal(frozen.length, 1);
  await f.receive('om_card_snapshot');
  const second = (await f.store.poll(caller)).job; const secondAuth = { ...caller, leaseToken: second.leaseToken };
  await f.store.started(second.id, secondAuth);
  await f.engine.configure({ replyStyle: 'separate' });
  await f.store.result(second.id, { ...secondAuth, text: 'retained card answer' });
  const state = f.state();
  assert.deepEqual(state.outbox.filter(item => item.kind === 'post'), frozen);
  assert.equal(state.jobs.find(item => item.id === first.id).replyStyle, 'separate');
  assert.equal(state.jobs.find(item => item.id === second.id).replyStyle, 'card');
  assert.equal(state.outbox.find(item => item.id === second.id).text, 'retained card answer');
  assert.deepEqual(f.lifecycle, ['start']);
});

test('migration validates explicit reply style before importing state and supports explicit card mode', async () => {
  const f = await setup({ configured: false });
  const migration = { format: 'feishu-chatgpt-extension-migration-v1', appId: 'cli_fixture', appSecret: 'fixture-secret', groups: [{ chatId: caller.chatId, binding: caller }], seen: {} };
  await assert.rejects(f.engine.importConfiguration({ ...migration, replyStyle: null }), /回复方式无效/);
  await assert.rejects(f.engine.importConfiguration({ ...migration, replyStyle: 'invalid' }), /回复方式无效/);
  assert.equal((await f.store.status()).groups.length, 0); assert.equal(f.config(), null); assert.deepEqual(f.lifecycle, []);
  await f.engine.importConfiguration({ ...migration, replyStyle: 'card' }); await f.engine.connecting;
  assert.equal((await f.engine.status()).replyStyle, 'card');
});

async function finishSeparateAnswer(f, text = 'independent answer') {
  await f.store.bind(caller); await f.receive('om_final_answer'); await f.engine.tick();
  const job = (await f.store.poll(caller)).job; const auth = { ...caller, leaseToken: job.leaseToken };
  await f.store.started(job.id, auth); await f.store.result(job.id, { ...auth, text });
  await f.engine.tick(); assert.equal(f.calls.at(-1)[2].state, 'sending');
  return job;
}

test('post retry keeps payload and request ID stable without resending confirmed earlier parts', async () => {
  const attempts = []; let rejectSecond = true;
  const f = await setup({ adapterOverrides: { replyPost: async (...args) => {
    attempts.push(structuredClone(args));
    if (args[2].endsWith(':post:1') && rejectSecond) { rejectSecond = false; throw new Error('temporary network failure'); }
    return { messageId: `om_${attempts.length}`, uuid: args[2] };
  } } });
  const job = await finishSeparateAnswer(f, 'Many answer paragraphs.\n'.repeat(2200));
  const posts = f.state().outbox.filter(item => item.kind === 'post'); assert.ok(posts.length > 1);
  await f.engine.tick(); await f.engine.tick();
  assert.equal(attempts.length, 2); assert.equal(f.state().jobs[0].answerDelivery.sentPosts, 1);
  await f.engine.tick(); assert.equal(attempts.length, 2);
  f.clock.now += 3000; await f.engine.tick();
  assert.deepEqual(attempts[2], attempts[1]);
  for (let i = 2; i < posts.length; i++) await f.engine.tick();
  await f.engine.tick();
  assert.equal(attempts.filter(args => args[2] === `${job.id}:post:0`).length, 1);
  assert.equal(f.calls.at(-1)[2].state, 'completed');
  assert.equal(f.state().jobs[0].answerDelivery.sentPosts, posts.length);
});

test('permanent post delivery failure changes the status card to failed and stops later body sections', async () => {
  const attempts = [];
  const f = await setup({ adapterOverrides: { replyPost: async (...args) => { attempts.push(args); throw Object.assign(new Error('PRIVATE_PROVIDER_ERROR'), { retryable: false }); } } });
  await finishSeparateAnswer(f, 'Rejected answer section.\n'.repeat(2200));
  await f.engine.tick(); await f.engine.tick();
  assert.equal(attempts.length, 1); assert.equal(f.calls.at(-1)[2].state, 'failed');
  assert.doesNotMatch(f.calls.at(-1)[2].text, /已发送|PRIVATE_PROVIDER_ERROR|Rejected/);
  assert.equal(f.state().jobs[0].answerDelivery.state, 'failed');
  assert.ok(f.state().outbox.filter(item => item.kind === 'post').every(item => item.abandoned));
  assert.doesNotMatch(JSON.stringify(await f.engine.status()), /PRIVATE_PROVIDER_ERROR/);
});

test('retrying the final card patch does not resend a confirmed independent body', async () => {
  const f = await setup(); await finishSeparateAnswer(f);
  const updates = []; let reject = true;
  f.engine.adapter.updateCard = async (...args) => {
    updates.push(structuredClone(args));
    if (reject) { reject = false; throw new Error('patch temporarily failed'); }
  };
  await f.engine.tick(); await f.engine.tick();
  assert.equal(f.calls.filter(call => call[0] === 'replyPost').length, 1);
  assert.equal(f.state().jobs[0].answerDelivery.state, 'sent');
  f.clock.now += 3000; await f.engine.tick();
  assert.deepEqual(updates[1], updates[0]); assert.equal(updates[1][1].state, 'completed');
  assert.equal(f.calls.filter(call => call[0] === 'replyPost').length, 1);
  assert.equal((await f.store.status()).delivery.length, 0);
});

function multiImageEvent(count, type = 'post', messageId = 'om_multi_images') {
  return { sender: { sender_type: 'user', sender_id: { open_id: 'ou_fixture_user' } }, message: {
    message_id: messageId, chat_id: caller.chatId, chat_type: 'group', message_type: type,
    create_time: String(Date.now()), mentions: [{ key: '@_user_1', id: { open_id: 'ou_fixture_bot' } }],
    content: JSON.stringify(type === 'post'
      ? { title: '', content: [[{ tag: 'at', user_id: '@_user_1' }, { tag: 'text', text: 'Compare every picture' }], ...Array.from({ length: count }, (_, index) => [{ tag: 'img', image_key: `img_source_${index}` }])] }
      : { image_key: `img_source_${count}` }),
  } };
}

test('one mentioned Feishu post with two to four distinct images completes both directions in order without dropping pictures', async () => {
  for (const count of [2, 3, 4]) {
    // Distinct synthetic PNG byte fixtures, so content deduplication cannot
    // accidentally turn a multiple-image regression into a one-image test.
    const buffers = Array.from({ length: count }, (_, index) => Uint8Array.from([...PNG, index]));
    const downloads = []; const uploads = []; const replies = [];
    const f = await setup({ adapterOverrides: {
      downloadImage: async args => {
        downloads.push(args);
        return { buffer: buffers[Number(args.imageKey.split('_').at(-1))], mimeType: 'image/png' };
      },
      uploadImage: async args => { uploads.push(args); return { imageKey: `img_returned_${uploads.length - 1}` }; },
      replyImage: async args => { replies.push(args); },
    } });
    await f.store.bind(caller);
    const normalized = normalizeMessage(multiImageEvent(count), 'ou_fixture_bot');
    assert.equal(normalized.images.length, count);
    await f.receive(normalized.messageId, normalized.text, normalized);
    for (let i = 0; i <= count; i++) {
      await f.engine.tick();
      if (i < count) assert.equal((await f.store.poll(caller)).job, null);
    }
    assert.deepEqual(downloads.map(args => args.imageKey), Array.from({ length: count }, (_, index) => `img_source_${index}`));
    const job = (await f.store.poll(caller)).job; assert.equal(job.images.length, count);
    const auth = { ...caller, leaseToken: job.leaseToken }; await f.store.started(job.id, auth);
    const ids = [];
    for (const [index, image] of job.images.entries()) {
      const input = await f.store.inputImage(job.id, { ...auth, imageId: image.id });
      assert.deepEqual(Buffer.from(input.base64, 'base64'), Buffer.from(buffers[index]));
      ids.push((await f.store.image(job.id, { ...auth, index, mimeType: 'image/png', base64: input.base64 })).imageId);
    }
    assert.equal(new Set(ids).size, count); assert.equal(f.images.size, count * 2);
    await f.store.result(job.id, { ...auth, text: 'All pictures returned', images: ids });
    assert.equal(f.images.size, count);
    for (let i = 0; i < 2 * count + 3; i++) await f.engine.tick();
    assert.equal(uploads.length, count); assert.equal(replies.length, count);
    assert.deepEqual(uploads.map(args => Buffer.from(args.buffer)), buffers.map(buffer => Buffer.from(buffer)));
    assert.deepEqual(replies.map(args => args.index), Array.from({ length: count }, (_, index) => index));
    assert.deepEqual(replies.map(args => args.requestId), Array.from({ length: count }, (_, index) => `${job.id}:image:${index}`));
    assert.equal(f.state().jobs[0].answerDelivery.sentImages, count);
    assert.equal(f.state().jobs[0].answerDelivery.state, 'sent');
    assert.equal(f.calls.at(-1)[2].state, 'completed'); assert.equal(f.images.size, 0);
  }
});

test('standalone Feishu image events are not merged with nearby mentioned posts or treated as complete multi-image questions', () => {
  const normalized = normalizeMessage(multiImageEvent(2), 'ou_fixture_bot');
  assert.equal(normalized.images.length, 2);
  for (let index = 0; index < 4; index++) {
    assert.equal(normalizeMessage(multiImageEvent(index, 'image', `om_separate_image_${index}`), 'ou_fixture_bot'), null);
  }
  const second = normalizeMessage(multiImageEvent(2, 'post', 'om_next_mentioned_post'), 'ou_fixture_bot');
  assert.notEqual(second.messageId, normalized.messageId);
  assert.equal(second.images.length, 2);
});

test('post image-key deduplication preserves all four unique attachments and a fifth unique image rejects the entire job', async () => {
  const f = await setup(); await f.store.bind(caller);
  const event = multiImageEvent(4); const body = JSON.parse(event.message.content);
  body.content.push([{ tag: 'img', image_key: 'img_source_0' }, { tag: 'img', image_key: 'img_source_3' }]);
  event.message.content = JSON.stringify(body);
  const normalized = normalizeMessage(event, 'ou_fixture_bot');
  assert.equal(normalized.images.length, 4);
  assert.equal((await f.receive(normalized.messageId, normalized.text, normalized)).accepted, true);
  const excessive = normalizeMessage(multiImageEvent(5, 'post', 'om_five_images'), 'ou_fixture_bot');
  assert.equal(excessive.images.length, 5);
  assert.equal((await f.receive(excessive.messageId, excessive.text, excessive)).accepted, false);
  assert.equal(f.state().jobs.length, 1);
  assert.equal(f.state().outbox.find(item => item.messageId === 'om_five_images').text.includes('4 张'), true);
});
