import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionEngine as QQRuntime } from '../extension/qq-runtime.js';
import { ExtensionEngine as FeishuRuntime } from '../extension/feishu-runtime.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const jobId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const platforms = [['qq', QQRuntime, '123456789'], ['feishu', FeishuRuntime, 'cli_fixture']];

async function fixture(platform, Runtime, appId, { storeOverrides = {}, adapterOverrides = {}, config = {}, writeConfig } = {}) {
  let saved = { appId, appSecret: `${platform}-fixture-secret`, words: [`${platform}过滤词`], replyStyle: 'separate', ...config };
  const events = []; const calls = []; const callbacks = []; const adapters = []; const wordChanges = [];
  const state = { groups: [], jobs: [], delivery: [] }; const outbox = [];
  const store = {
    async recover() {}, async sweep() { calls.push(['sweep']); }, async status() { return structuredClone(state); },
    async ingest(message, options) { events.push({ message, options }); return { ok: true }; },
    async poll() { calls.push(['poll']); return { job: null }; },
    async started() { calls.push(['started']); return { ok: true }; },
    async result() { calls.push(['result']); return { ok: true }; },
    async error() { calls.push(['error']); return { ok: true }; },
    async inputImage() { calls.push(['inputImage']); return {}; }, async image() { calls.push(['image']); return {}; },
    async nextReply() { return outbox[0] ?? null; }, async nextInputImage() { return null; },
    async deliveryStarted() {}, async replySent(id) { calls.push(['sent', id]); outbox.splice(outbox.findIndex(item => item.id === id), 1); },
    async replyFailed(id) { calls.push(['failed', id]); }, async postReplyRejected(id) { calls.push(['rejected', id]); },
    async inputImageDownloaded() { calls.push(['downloaded']); }, async inputImageFailed() {},
    async cardCreated(id, messageId) { outbox[0].cardMessageId = messageId; calls.push(['cardCreated', id]); },
    async cardUpdated(id, revision) { calls.push(['cardUpdated', id, revision]); outbox.shift(); },
    ...storeOverrides,
  };
  let wakes = 0;
  const runtime = new Runtime({
    store, readConfig: async () => structuredClone(saved),
    writeConfig: async next => { await writeConfig?.(next); saved = structuredClone(next); },
    defaultWords: ['默认过滤词'], setWords: words => wordChanges.push([...words]), onWork: () => wakes++,
    adapterFactory(options) {
      callbacks.push(options);
      const adapter = {
        async start() { calls.push(['start']); options.onState({ state: 'connected' }); },
        async stop() { calls.push(['stop']); options.onState({ state: 'stopped' }); },
        async reply(...args) { calls.push(['reply', ...args]); }, async replyPost(...args) { calls.push(['post', ...args]); },
        async downloadImage(...args) { calls.push(['download', ...args]); return {}; },
        async createCard(...args) { calls.push(['createCard', ...args]); return { messageId: 'card-message' }; },
        async updateCard(...args) { calls.push(['updateCard', ...args]); },
        ...adapterOverrides,
      };
      adapters.push(adapter); return adapter;
    },
  });
  await runtime.init({ connect: false });
  return { runtime, store, state, outbox, events, calls, callbacks, adapters, wordChanges, saved: () => saved, wakes: () => wakes };
}

for (const [platform, Runtime, appId] of platforms) {
  test(`${platform}: inactive initialization, page gates and configuration never start a connection`, async () => {
    const f = await fixture(platform, Runtime, appId);
    assert.equal(f.runtime.enabled, false); assert.equal(f.adapters.length, 0);
    assert.equal(await f.runtime.tick(), false); assert.equal(f.calls.length, 0);
    assert.equal((await f.runtime.request('/v1/poll')).job, null);
    for (const action of ['started', 'input-image', 'image', 'result', 'error']) {
      await assert.rejects(f.runtime.request(`/v1/jobs/${jobId}/${action}`), error => error.status === 409);
    }
    await f.runtime.configure({ appId, appSecret: 'rotated-fixture' });
    await f.runtime.saveWords({ words: ['新的过滤词'] });
    assert.equal(f.adapters.length, 0); assert.equal(f.runtime.configBusy, false);
    assert.equal(f.saved().appSecret, 'rotated-fixture'); assert.equal(f.wakes(), 0);
    await f.runtime.activate(); await f.runtime.connecting;
    assert.equal(f.adapters.length, 1); assert.equal(f.runtime.enabled, true); assert.equal(f.wakes(), 1);
    await f.runtime.deactivate();
  });

  test(`${platform}: queued cancellation works while disabled and wakes enabled delivery only after a successful commit`, async () => {
    const cancelled = []; let conflict = false;
    const f = await fixture(platform, Runtime, appId, { storeOverrides: {
      async cancel(...args) {
        cancelled.push(args);
        if (conflict) throw Object.assign(new Error('Task was leased'), { status: 409 });
        return { ok: true };
      },
    } });
    assert.deepEqual(await f.runtime.request(`/v1/jobs/${jobId}/cancel`, { leaseToken: 'ignored', tabId: 99 }), { ok: true });
    assert.deepEqual(cancelled, [[jobId]]);
    assert.equal(f.runtime.enabled, false); assert.equal(f.adapters.length, 0); assert.equal(f.wakes(), 0);
    await f.runtime.activate(); await f.runtime.connecting;
    const before = f.wakes();
    assert.deepEqual(await f.runtime.request(`/v1/jobs/${jobId}/cancel`), { ok: true });
    assert.equal(f.wakes(), before + 1);
    conflict = true;
    await assert.rejects(f.runtime.request(`/v1/jobs/${jobId}/cancel`), error => error.status === 409);
    assert.equal(f.wakes(), before + 1);
    assert.deepEqual(cancelled, [[jobId], [jobId], [jobId]]);
    await f.runtime.deactivate();
  });

  test(`${platform}: deactivation drains an already accepted cancellation before stopping`, async () => {
    const committing = deferred();
    const f = await fixture(platform, Runtime, appId, { storeOverrides: { async cancel() { await committing.promise; return { ok: true }; } } });
    await f.runtime.activate(); await f.runtime.connecting;
    const cancellation = f.runtime.request(`/v1/jobs/${jobId}/cancel`); await flush();
    let stopped = false;
    const stopping = f.runtime.deactivate().then(() => { stopped = true; });
    await flush(); assert.equal(stopped, false);
    committing.resolve(); assert.deepEqual(await cancellation, { ok: true });
    await stopping; assert.equal(stopped, true); assert.equal(f.runtime.enabled, false);
  });

  test(`${platform}: deactivation drains accepted ingestion and ignores old callbacks across reactivation`, async () => {
    const ingestion = deferred(); const entered = [];
    const f = await fixture(platform, Runtime, appId, { storeOverrides: { async ingest(message) { entered.push(message.messageId); await ingestion.promise; return { ok: true }; } } });
    await f.runtime.activate(); await f.runtime.connecting; const old = f.callbacks[0];
    const accepted = old.onMessage({ messageId: 'accepted' }); await flush();
    let stopped = false; const stopping = f.runtime.deactivate().then(() => { stopped = true; });
    assert.equal(f.runtime.enabled, false); assert.equal((await f.runtime.request('/v1/poll')).job, null);
    await old.onMessage({ messageId: 'revoked' }); old.onState({ state: 'connected' });
    await flush(); assert.equal(stopped, false); assert.deepEqual(entered, ['accepted']); assert.equal(f.runtime[platform].state, 'stopped');
    ingestion.resolve(); await accepted; await stopping;
    assert.equal(f.calls.filter(call => call[0] === 'stop').length, 1);
    await f.runtime.activate(); await f.runtime.connecting;
    await old.onMessage({ messageId: 'stale-after-reactivation' }); old.onState({ state: 'error', error: 'old error' });
    assert.deepEqual(entered, ['accepted']); assert.equal(f.runtime[platform].state, 'connected');
    await f.callbacks[1].onMessage({ messageId: 'fresh' }); assert.deepEqual(entered, ['accepted', 'fresh']);
    await f.runtime.deactivate();
  });

  test(`${platform}: an in-flight delivery finishes on its original adapter before stop resolves`, async () => {
    const sending = deferred(); let deliveries = 0;
    const f = await fixture(platform, Runtime, appId, { adapterOverrides: { async replyPost() { deliveries++; await sending.promise; } } });
    await f.runtime.activate(); await f.runtime.connecting;
    f.outbox.push({ id: 'post-1', kind: 'post', messageId: 'source', chatId: 'group', post: 'body', msgSeq: 1 });
    const delivery = f.runtime.tick(); await flush(); assert.equal(deliveries, 1);
    let stopped = false; const stopping = f.runtime.deactivate().then(() => { stopped = true; });
    assert.equal(await f.runtime.tick(), false); await flush(); assert.equal(stopped, false);
    assert.equal(f.calls.filter(call => call[0] === 'stop').length, 0);
    sending.resolve(); assert.equal(await delivery, true); await stopping;
    assert.equal(deliveries, 1); assert.equal(f.outbox.length, 0);
    assert.ok(f.calls.findIndex(call => call[0] === 'sent') < f.calls.findIndex(call => call[0] === 'stop'));
  });

  test(`${platform}: stop cancels an unfinished connection and late startup cannot reconnect`, async () => {
    const startup = deferred(); let stopCalls = 0;
    const f = await fixture(platform, Runtime, appId, { adapterOverrides: { start: () => startup.promise, async stop() { stopCalls++; startup.resolve(); } } });
    await f.runtime.activate(); assert.equal(f.runtime[platform].state, 'connecting');
    await f.runtime.deactivate();
    f.callbacks[0].onState({ state: 'reconnecting' }); await f.callbacks[0].onMessage({ messageId: 'late' });
    await flush(); assert.equal(stopCalls, 1); assert.equal(f.runtime[platform].state, 'stopped'); assert.equal(f.events.length, 0); assert.equal(f.adapters.length, 1);
  });

  test(`${platform}: saving configuration rejects switching before changing the enabled flag`, async () => {
    const saving = deferred(); const f = await fixture(platform, Runtime, appId, { writeConfig: () => saving.promise });
    await f.runtime.activate(); await f.runtime.connecting;
    const configuration = f.runtime.configure({ appId, appSecret: 'new-secret' }); await flush();
    await assert.rejects(f.runtime.deactivate(), error => error.status === 409);
    assert.equal(f.runtime.enabled, true);
    saving.resolve(); await configuration; await f.runtime.connecting;
    assert.equal(f.runtime[platform].state, 'connected'); await f.runtime.deactivate();
  });

  test(`${platform}: a failed stop keeps the source enabled and reuses its original adapter`, async () => {
    let failStop = true; let starts = 0;
    const f = await fixture(platform, Runtime, appId, { adapterOverrides: {
      async start() { starts++; },
      async stop() { if (failStop) throw Error('raw private-fixture-secret'); },
    } });
    await f.runtime.activate(); await f.runtime.connecting; f.callbacks[0].onState({ state: 'connected' });
    await assert.rejects(f.runtime.deactivate(), error => error.status === 409 && !error.message.includes('private-fixture-secret'));
    await f.runtime.connecting;
    assert.equal(f.runtime.enabled, true); assert.equal(f.adapters.length, 1); assert.equal(starts, 2);
    await f.callbacks[0].onMessage({ messageId: 'restored-source' }); assert.equal(f.events.length, 1);
    failStop = false; await f.runtime.deactivate(); assert.equal(f.runtime.enabled, false);
  });

  test(`${platform}: enabled but disconnected runtimes still sweep expired work`, async () => {
    const f = await fixture(platform, Runtime, appId); await f.runtime.activate(); await f.runtime.connecting;
    f.callbacks[0].onState({ state: 'error' });
    assert.equal(await f.runtime.tick(), false); assert.equal(f.calls.filter(call => call[0] === 'sweep').length, 1);
    await f.runtime.deactivate(); assert.equal(await f.runtime.tick(), false);
    assert.equal(f.calls.filter(call => call[0] === 'sweep').length, 1);
  });

  test(`${platform}: deactivation waits for already-entered page commits and blocks later requests`, async () => {
    const committing = deferred(); let results = 0;
    const f = await fixture(platform, Runtime, appId, { storeOverrides: { async result() { results++; await committing.promise; return { ok: true }; } } });
    await f.runtime.activate(); await f.runtime.connecting;
    const result = f.runtime.request(`/v1/jobs/${jobId}/result`, { text: 'final' }); await flush();
    let stopped = false; const stopping = f.runtime.deactivate().then(() => { stopped = true; });
    await assert.rejects(f.runtime.request(`/v1/jobs/${jobId}/started`), error => error.status === 409);
    await flush(); assert.equal(stopped, false); committing.resolve(); await result; await stopping; assert.equal(results, 1);
  });
}

test('QQ and Feishu retain independent credentials, word lists, ingests and style snapshots', async () => {
  const qq = await fixture(...platforms[0]); const feishu = await fixture(...platforms[1], { config: { replyStyle: 'card' } });
  await qq.runtime.activate(); await qq.runtime.connecting;
  await qq.callbacks[0].onMessage({ messageId: 'qq-only' });
  await qq.runtime.saveWords({ words: ['QQ新词'] }); await qq.runtime.deactivate();
  await feishu.runtime.activate(); await feishu.runtime.connecting;
  const oldStyle = feishu.callbacks[0].onMessage({ messageId: 'card-job' });
  await feishu.runtime.configure({ replyStyle: 'separate' }); await oldStyle;
  await feishu.callbacks[0].onMessage({ messageId: 'separate-job' });
  await qq.callbacks[0].onMessage({ messageId: 'wrong-platform' });
  assert.deepEqual(qq.events.map(event => event.message.messageId), ['qq-only']);
  assert.deepEqual(feishu.events.map(event => event.options.replyStyle), ['card', 'separate']);
  assert.deepEqual(qq.saved().words, ['QQ新词']); assert.deepEqual(feishu.saved().words, ['feishu过滤词']);
  assert.equal(qq.saved().appSecret, 'qq-fixture-secret'); assert.equal(feishu.saved().appSecret, 'feishu-fixture-secret');
  await feishu.runtime.deactivate(); await feishu.runtime.activate(); await feishu.runtime.connecting;
  assert.equal((await feishu.runtime.status()).replyStyle, 'separate'); await feishu.runtime.deactivate();
});

test('Feishu prioritizes output, returns work booleans, wakes on results and preserves card delivery', async () => {
  let input = { messageId: 'input', imageKey: 'img' };
  const f = await fixture(...platforms[1], { storeOverrides: { async nextInputImage() { return input; }, async inputImageDownloaded() { input = null; } } });
  await f.runtime.activate(); await f.runtime.connecting;
  f.outbox.push({ id: 'card-1', kind: 'card', messageId: 'source', state: 'sending', text: 'status', revision: 7 });
  assert.equal(await f.runtime.tick(), true); assert.equal(f.calls.find(call => call[0] === 'createCard')[1], 'source');
  assert.equal(await f.runtime.tick(), true);
  assert.deepEqual(f.calls.find(call => call[0] === 'updateCard'), ['updateCard', 'card-message', { state: 'sending', text: 'status', requestId: 'card-1', sourceMessageId: 'source' }]);
  assert.equal(f.calls.filter(call => call[0] === 'download').length, 0);
  assert.equal(await f.runtime.tick(), true); assert.equal(f.calls.filter(call => call[0] === 'download').length, 1);
  assert.equal(await f.runtime.tick(), false);
  const before = f.wakes(); await f.runtime.request(`/v1/jobs/${jobId}/result`, { text: 'result' }); assert.equal(f.wakes(), before + 1);
  await f.runtime.deactivate();
});


for (const [platform, Runtime, appId] of platforms) test(`${platform}: history clearing does not connect or send messages and propagates write failure`, async () => {
  let calls = 0; let fail = false;
  const f = await fixture(platform, Runtime, appId, { storeOverrides: { async clearHistory() { calls++; if (fail) throw new Error('history failure'); return { ok: true, count: 2 }; } } });
  assert.deepEqual(await f.runtime.request('/v1/history/clear'), { ok: true, count: 2 });
  assert.equal(f.adapters.length, 0); assert.equal(calls, 1);
  fail = true; await assert.rejects(f.runtime.request('/v1/history/clear'), /history failure/);
  assert.equal(f.adapters.length, 0);
});
