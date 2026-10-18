import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformRouter } from '../extension/platform-router.js';
import { ExtensionEngine as QQRuntime } from '../extension/qq-runtime.js';
import { ExtensionEngine as FeishuRuntime } from '../extension/feishu-runtime.js';
import { BridgeStore as QQStore } from '../extension/qq-store.js';
import { BridgeStore as FeishuStore } from '../extension/feishu-store.js';
import { StorageConflictError } from '../extension/storage.js';
import { createWordFilter } from '../extension/moderation.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const jobId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function mockEngine(platform) {
  const state = { groups: [], jobs: [], delivery: [] }; const calls = [];
  const engine = {
    config: { appId: `${platform}-app`, appSecret: `${platform}-secret` }, enabled: false,
    store: { async status() { return structuredClone(state); } },
    async init(options) { calls.push(['init', options]); },
    async activate() { calls.push(['activate']); this.enabled = true; },
    async deactivate() { calls.push(['deactivate']); this.enabled = false; },
    async status() { return { ...structuredClone(state), [platform]: { state: this.enabled ? 'connected' : 'stopped' } }; },
    async tick() { calls.push(['tick']); return true; },
    async request(route, body) { calls.push(['request', route, body]); return route === '/v1/poll' ? { job: { id: jobId, platform: 'spoofed' } } : { ok: true }; },
  };
  return { engine, state, calls };
}
async function mocked({ selected, writeSelection, channels, writeChannels } = {}) {
  const qq = mockEngine('qq'); const feishu = mockEngine('feishu'); const writes = []; let wakes = 0;
  const router = new PlatformRouter({ engines: { qq: qq.engine, feishu: feishu.engine },
    readSelection: async () => selected, readChannels: async () => channels, writeChannels: async value => { await writeChannels?.(value); channels = value; },
    writeSelection: async value => { await writeSelection?.(value); writes.push(value); }, onWork: () => wakes++,
  });
  await router.init();
  return { router, qq, feishu, writes, wakes: () => wakes };
}

test('router restores the selected platform and initializes the other profile without a connection', async () => {
  const f = await mocked({ selected: 'feishu' });
  assert.deepEqual(f.qq.calls, [['init', { connect: false }]]);
  assert.deepEqual(f.feishu.calls, [['init', { connect: false }], ['activate']]);
  const state = await f.router.request('/v1/status');
  assert.equal(state.platform, 'feishu'); assert.equal(state.connection.state, 'connected');
  assert.deepEqual(state.platforms.qq, { active: false, configured: true, appId: 'qq-app', enabled: false, running: false, connection: { state: 'stopped' }, groups: [], queuedChatIds: [] });
  assert.doesNotMatch(JSON.stringify(state), /secret/);
  assert.equal(await f.router.tick(), true); assert.equal(f.qq.calls.length, 1);
  assert.deepEqual(f.feishu.calls.at(-1), ['tick']);
});

test('router defaults to QQ, persists successful switches, and switching to the same platform is a no-op', async () => {
  const f = await mocked(); assert.equal(f.router.activePlatform, 'qq');
  assert.deepEqual(await f.router.request('/v1/platform', { platform: 'qq' }), { ok: true, platform: 'qq' });
  assert.equal(f.qq.calls.length, 2); assert.deepEqual(f.writes, []);
  assert.deepEqual(await f.router.request('/v1/platform', { platform: 'feishu' }), { ok: true, platform: 'feishu' });
  assert.equal(f.qq.engine.enabled, true); assert.equal(f.feishu.engine.enabled, false);
  assert.deepEqual(f.writes, ['feishu']); assert.equal(f.wakes(), 1);
  assert.equal((await f.router.status()).platforms.qq.active, false);
});

test('router rejects invalid, missing and stale platform operations before forwarding any payload', async () => {
  const f = await mocked();
  for (const platform of [undefined, '', 'QQ', '__proto__']) {
    for (const route of ['/v1/history/clear', '/v1/config', '/v1/moderation', '/v1/bind', '/v1/unbind', '/v1/poll', `/v1/jobs/${jobId}/result`, `/v1/jobs/${jobId}/cancel`]) {
      await assert.rejects(f.router.request(route, { platform, appSecret: 'never-write', text: 'never-send' }));
    }
  }
  await assert.rejects(f.router.request('/v1/import', { platform: 'qq' }), error => error.status === 404);
  await assert.rejects(f.router.request('/v1/config', { platform: 'qq', replyStyle: 'card' }), /Markdown/);
  assert.equal(f.qq.calls.filter(call => call[0] === 'request').length, 0);
  const result = await f.router.request('/v1/poll', { platform: 'qq', tabId: 8 });
  assert.equal(result.job.platform, 'qq');
  assert.deepEqual(f.qq.calls.at(-1), ['request', '/v1/poll', { tabId: 8 }]);
  await f.router.request('/v1/moderation', { platform: 'qq' });
  assert.deepEqual(f.qq.calls.at(-1), ['request', '/v1/moderation', {}]);
});

test('router permits cancellation on either explicitly scoped platform even when its assistant is disabled', async () => {
  for (const platform of ['qq', 'feishu']) {
    const f = await mocked({ selected: platform }); const other = platform === 'qq' ? 'feishu' : 'qq';
    const route = `/v1/jobs/${jobId}/cancel`;
    assert.deepEqual(await f.router.request(route, { platform }), { ok: true });
    await f.router.setEnabled(false);
    f[platform].state.jobs.push({ id: jobId, state: 'queued' });
    assert.deepEqual(await f.router.request(route, { platform }), { ok: true });
    assert.deepEqual(await f.router.request(route, { platform: other }), { ok: true });
    await assert.rejects(f.router.request(`/v1/jobs/${jobId}/started`, { platform }), error => error.status === 409);
    assert.equal(f.router.enabled, false); assert.equal(f[platform].engine.enabled, false);
    assert.deepEqual(f[platform].calls.filter(call => call[0] === 'request'), [['request', route, {}], ['request', route, {}]]);
    assert.deepEqual(f[other].calls.filter(call => call[0] === 'request'), [['request', route, {}]]);
  }
});

test('router propagates cancellation conflicts without forwarding to another platform', async () => {
  const f = await mocked();
  f.qq.engine.request = async () => { throw Object.assign(new Error('Task already leased'), { status: 409 }); };
  await assert.rejects(f.router.request(`/v1/jobs/${jobId}/cancel`, { platform: 'qq' }), error => error.status === 409);
  assert.equal(f.router.activePlatform, 'qq'); assert.equal(f.feishu.calls.some(call => call[0] === 'request'), false);
});

test('router refuses to disconnect while jobs or outbound messages remain unfinished', async () => {
  for (const state of ['queued', 'leased', 'started', 'running', 'delivering', 'result_pending', 'pending']) {
    const f = await mocked(); f.qq.state.jobs.push({ state });
    await assert.rejects(f.router.request('/v1/channel', { platform: 'qq', enabled: false }), error => error.status === 409);
    assert.equal(f.qq.calls.some(call => call[0] === 'deactivate'), false); assert.deepEqual(f.writes, []);
  }
  for (const state of ['pending', 'retrying']) {
    const f = await mocked(); f.qq.state.delivery.push({ state });
    await assert.rejects(f.router.request('/v1/channel', { platform: 'qq', enabled: false }), error => error.status === 409);
    assert.equal(f.qq.engine.enabled, true);
  }
  const f = await mocked(); f.qq.engine.configBusy = true;
  await assert.rejects(f.router.request('/v1/channel', { platform: 'qq', enabled: false }), error => error.status === 409);
  f.qq.engine.configBusy = false; f.qq.state.activeJobCount = 1;
  await assert.rejects(f.router.request('/v1/channel', { platform: 'qq', enabled: false }), error => error.status === 409);
  f.qq.state.activeJobCount = 0; f.qq.state.jobs.push({ state: 'failed' }); f.qq.state.delivery.push({ state: 'needs_attention' });
  await f.router.request('/v1/channel', { platform: 'qq', enabled: false }); assert.equal(f.router.channels.qq, false);
});

test('an event entering during deactivation rolls back the switch and preserves its source queue', async () => {
  const f = await mocked();
  f.qq.engine.deactivate = async () => { f.qq.engine.enabled = false; f.qq.state.jobs.push({ id: jobId, state: 'queued' }); };
  await assert.rejects(f.router.request('/v1/channel', { platform: 'qq', enabled: false }), /收到新消息/);
  assert.equal(f.router.activePlatform, 'qq'); assert.equal(f.qq.engine.enabled, true); assert.equal(f.feishu.engine.enabled, false);
  assert.deepEqual(f.writes, []); assert.equal(f.qq.state.jobs[0].id, jobId); assert.equal(f.router.switching, false);
});

test('failed selection persistence reconnects the original profile without enabling the target', async () => {
  const f = await mocked({ writeSelection: async () => { throw new Error('disk full'); } });
  await assert.rejects(f.router.request('/v1/platform', { platform: 'feishu' }), /disk full/);
  assert.equal(f.qq.engine.enabled, true); assert.equal(f.feishu.engine.enabled, false); assert.equal(f.router.activePlatform, 'qq');
  assert.equal(f.router.switching, false); assert.equal((await f.router.request('/v1/status')).platform, 'qq');
});

test('an interrupted channel stop restores the original connection', async () => {
  const f = await mocked();
  f.qq.engine.deactivate = async () => { f.qq.engine.enabled = false; throw new Error('interrupted stop'); };
  await assert.rejects(f.router.request('/v1/channel', { platform: 'qq', enabled: false }), /interrupted stop/);
  assert.equal(f.qq.engine.enabled, true); assert.equal(f.feishu.engine.enabled, false);
  assert.equal(f.router.channels.qq, true); assert.equal(f.router.changingChannels.size, 0);
});

test('changing configuration view keeps pumping and queued writes retain their explicit scope', async () => {
  const pause = deferred(); const entered = deferred();
  const f = await mocked({ writeSelection: async () => { entered.resolve(); await pause.promise; } });
  const switching = f.router.request('/v1/platform', { platform: 'feishu' }); await entered.promise;
  assert.equal(await f.router.tick('qq'), true);
  const save = f.router.request('/v1/config', { platform: 'qq', appId: 'original-app' });
  pause.resolve(); await switching; await save;
  assert.deepEqual(f.qq.calls.at(-1), ['request', '/v1/config', { appId: 'original-app' }]);
  assert.equal(f.qq.engine.enabled, true); assert.equal(f.feishu.engine.enabled, false);
});

test('platforms cannot bind the same conversation through different paths or reuse a browser tab', async () => {
  const f = await mocked(); const original = { browserId: 'browser', tabId: 5, conversationUrl: 'https://chatgpt.com/c/conversation-one' };
  f.feishu.state.groups.push({ binding: original });
  for (const binding of [original,
    { ...original, tabId: 6, conversationUrl: 'https://chatgpt.com/g/custom/c/conversation-one/' },
    { ...original, conversationUrl: 'https://chatgpt.com/c/conversation-two' },
  ]) await assert.rejects(f.router.request('/v1/bind', { platform: 'qq', chatId: 'QQ_GROUP', ...binding }), error => error.status === 409);
  await f.router.request('/v1/bind', { platform: 'qq', chatId: 'QQ_GROUP', ...original, tabId: 6, conversationUrl: 'https://chatgpt.com/c/conversation-two' });
  assert.equal(f.qq.calls.filter(call => call[0] === 'request').length, 1);
});

class MemoryStorage {
  state = null; images = new Map();
  async readState() { return structuredClone(this.state); }
  async readImage(key) { return this.images.get(key) ?? null; }
  async listImageKeys() { return [...this.images.keys()]; }
  async commit({ expectedRevision, state, putImages = [], deleteImages = [] }) {
    if ((this.state?.revision ?? 0) !== expectedRevision) throw new StorageConflictError();
    for (const image of putImages) this.images.set(image.key, image.blob);
    for (const key of deleteImages) this.images.delete(key);
    this.state = { ...structuredClone(state), revision: expectedRevision + 1 }; return this.state.revision;
  }
}

async function integrated() {
  let selected; const engines = {}; const profiles = {};
  for (const [platform, Runtime, Store, appId, chatId, tabId] of [
    ['qq', QQRuntime, QQStore, '123456789', 'QQ_GROUP', 7],
    ['feishu', FeishuRuntime, FeishuStore, 'cli_fixture', 'oc_fixture', 8],
  ]) {
    const storage = new MemoryStorage(); const calls = []; const callbacks = [];
    let saved = { appId, appSecret: `${platform}-secret`, words: [`${platform} forbidden`] }; let filter;
    const store = await Store.open({ storage, moderate: text => filter(text) });
    const engine = new Runtime({ store, readConfig: async () => structuredClone(saved), writeConfig: async value => { saved = structuredClone(value); },
      defaultWords: ['default forbidden'], setWords: words => { filter = createWordFilter(words); },
      adapterFactory: options => {
        callbacks.push(options);
        return {
          async start() { calls.push(['start']); options.onState({ state: 'connected' }); },
          async stop() { calls.push(['stop']); },
          async reply(...args) { calls.push(['reply', args]); },
          async replyPost(...args) { calls.push(['post', args]); return { messageId: 'om_reply' }; },
          async createCard(...args) { calls.push(['card', args]); return { messageId: 'om_card' }; },
          async updateCard(...args) { calls.push(['patch', args]); },
        };
      },
    });
    engines[platform] = engine;
    profiles[platform] = { storage, calls, callbacks, saved: () => saved,
      caller: { browserId: 'browser', tabId, chatId, conversationUrl: `https://chatgpt.com/c/${platform}-conversation`, capabilities: ['image-input-v1'] },
    };
  }
  const router = new PlatformRouter({ engines, readSelection: async () => selected, writeSelection: async value => { selected = value; } });
  await router.init(); await engines.qq.connecting;
  return { router, engines, profiles, selected: () => selected };
}

test('real stores and adapters preserve configuration, moderation, bindings, deduplication and replies across round-trip switches', async () => {
  const f = await integrated(); const { router, engines, profiles } = f;
  for (const platform of ['qq', 'feishu', 'qq']) {
    await router.request('/v1/platform', { platform }); await router.request('/v1/channel', { platform, enabled: true }); await engines[platform].connecting;
    const p = profiles[platform];
    if (!(await engines[platform].store.status()).groups.some(group => group.chatId === p.caller.chatId)) await router.request('/v1/bind', { platform, ...p.caller });
    await router.request('/v1/moderation', { platform, words: [`${platform} forbidden`, `${platform} custom`] });
    const receiver = p.callbacks.at(-1).onMessage;
    const receipt = await receiver({ messageId: 'same-message-id', chatId: p.caller.chatId, text: 'question', createdAt: Date.now() });
    if (receipt.duplicate) { assert.equal(platform, 'qq'); continue; }
    const { job } = await router.request('/v1/poll', { platform, ...p.caller });
    assert.equal(job.platform, platform);
    const auth = { platform, ...p.caller, leaseToken: job.leaseToken };
    await router.request(`/v1/jobs/${job.id}/started`, auth);
    const other = platform === 'qq' ? 'feishu' : 'qq';
    await assert.rejects(router.request(`/v1/jobs/${job.id}/result`, { ...auth, platform: other, text: 'wrong destination' }));
    await router.request(`/v1/jobs/${job.id}/result`, { ...auth, text: `${platform} final answer` });
    await router.request('/v1/platform', { platform: other });
    await assert.rejects(router.request('/v1/channel', { platform, enabled: false }), error => error.status === 409);
    for (let i = 0; i < 6; i++) await router.tick();
    assert.equal((await engines[platform].store.status()).delivery.length, 0);
    assert.equal((await engines[platform].store.status()).jobs.length, 1);
    const output = JSON.stringify(p.calls.filter(call => call[0] === 'post'));
    assert.match(output, new RegExp(`${platform} final answer`)); assert.doesNotMatch(output, /wrong destination/);
    assert.doesNotMatch(output, new RegExp(`${other} final answer`));
  }
  assert.equal(f.selected(), 'qq'); assert.equal(engines.qq.enabled, true); assert.equal(engines.feishu.enabled, true);
  for (const platform of ['qq', 'feishu']) {
    const p = profiles[platform]; assert.equal(p.saved().appSecret, `${platform}-secret`);
    assert.deepEqual(p.saved().words, [`${platform} forbidden`, `${platform} custom`]);
    assert.equal((await engines[platform].store.status()).groups[0].chatId, p.caller.chatId);
    assert.equal((await engines[platform].store.status()).jobs.length, 1);
  }
  await router.request('/v1/channel', { platform: 'feishu', enabled: false });
  const stale = profiles.feishu.callbacks[0];
  await stale.onMessage({ messageId: 'stale-after-switch', chatId: 'oc_fixture', text: 'ignored', createdAt: Date.now() });
  assert.equal((await engines.feishu.store.status()).jobs.length, 1);
  await engines.qq.deactivate();
});


test('history clearing stays within the selected platform and works for a disabled assistant', async () => {
  const f = await mocked({ selected: 'feishu' }); await f.router.setEnabled(false);
  assert.deepEqual(await f.router.request('/v1/history/clear', { platform: 'feishu' }), { ok: true });
  await f.router.request('/v1/history/clear', { platform: 'qq' });
  assert.deepEqual(f.feishu.calls.filter(call => call[0] === 'request'), [['request', '/v1/history/clear', {}]]);
  assert.deepEqual(f.qq.calls.filter(call => call[0] === 'request'), [['request', '/v1/history/clear', {}]]);
});

for (const selected of ['qq', 'feishu']) test(`legacy ${selected} selection migrates only its enabled channel`, async () => {
  const writes = []; const f = await mocked({ selected, writeChannels: value => writes.push(value) });
  assert.deepEqual(writes, [{ qq: selected === 'qq', feishu: selected === 'feishu' }]);
  assert.equal(f.qq.engine.enabled, selected === 'qq'); assert.equal(f.feishu.engine.enabled, selected === 'feishu');
});

test('both enabled channels restore and assistant master switch preserves independent choices', async () => {
  const f = await mocked({ channels: { qq: true, feishu: true } });
  assert.equal(f.qq.engine.enabled, true); assert.equal(f.feishu.engine.enabled, true);
  await f.router.setEnabled(false);
  assert.equal(f.qq.engine.enabled, false); assert.equal(f.feishu.engine.enabled, false);
  assert.deepEqual(f.router.channels, { qq: true, feishu: true });
  await f.router.setEnabled(true);
  await f.router.request('/v1/channel', { platform: 'qq', enabled: false });
  assert.equal(f.qq.engine.enabled, false); assert.equal(f.feishu.engine.enabled, true);
  assert.equal((await f.router.request('/v1/poll', { platform: 'qq' })).job, null);
  assert.equal((await f.router.request('/v1/poll', { platform: 'feishu' })).job.platform, 'feishu');
});

test('channel preferences can be changed while assistant is off without connecting', async () => {
  const f = await mocked({ channels: { qq: false, feishu: false } });
  await f.router.setEnabled(false);
  await f.router.request('/v1/channel', { platform: 'feishu', enabled: true });
  assert.equal(f.feishu.engine.enabled, false);
  await f.router.setEnabled(true); assert.equal(f.feishu.engine.enabled, true); assert.equal(f.qq.engine.enabled, false);
});

test('a busy QQ channel does not prevent stopping Feishu or selecting its configuration', async () => {
  const f = await mocked({ channels: { qq: true, feishu: true } }); f.qq.state.jobs.push({ state: 'started' });
  await f.router.request('/v1/platform', { platform: 'feishu' });
  await f.router.request('/v1/channel', { platform: 'feishu', enabled: false });
  assert.equal(f.qq.engine.enabled, true); assert.equal(f.feishu.engine.enabled, false);
  await assert.rejects(f.router.setEnabled(false), /任务/);
});

test('channel persistence failures restore connection and preserve preferences', async () => {
  const f = await mocked({ channels: { qq: true, feishu: false }, writeChannels: () => { throw new Error('storage failed'); } });
  for (const [platform, enabled] of [['qq', false], ['feishu', true]]) {
    await assert.rejects(f.router.request('/v1/channel', { platform, enabled }), /storage failed/);
    assert.deepEqual(f.router.channels, { qq: true, feishu: false });
    assert.equal(f.qq.engine.enabled, true); assert.equal(f.feishu.engine.enabled, false);
  }
});

test('slow QQ tick does not block Feishu pumping', async () => {
  const f = await mocked({ channels: { qq: true, feishu: true } }); const hold = deferred();
  f.qq.engine.tick = () => hold.promise;
  const pending = f.router.tick('qq');
  assert.equal(await f.router.tick('feishu'), true);
  hold.resolve(true); assert.equal(await pending, true);
});

test('real QQ and Feishu can accept, execute and deliver simultaneous tasks to their own stores', async () => {
  const { router, engines, profiles } = await integrated();
  await router.request('/v1/channel', { platform: 'feishu', enabled: true });
  await engines.feishu.connecting;
  for (const platform of ['qq', 'feishu']) await router.request('/v1/bind', { platform, ...profiles[platform].caller });
  await Promise.all(['qq', 'feishu'].map(platform => profiles[platform].callbacks.at(-1).onMessage({ messageId: 'simultaneous-source', chatId: profiles[platform].caller.chatId, text: 'Question for ' + platform, createdAt: Date.now() })));
  const leased = await Promise.all(['qq', 'feishu'].map(platform => router.request('/v1/poll', { platform, ...profiles[platform].caller })));
  assert.equal(leased[0].job.platform, 'qq'); assert.equal(leased[1].job.platform, 'feishu');
  assert.equal(leased[0].job.prompt, 'Question for qq'); assert.equal(leased[1].job.prompt, 'Question for feishu');
  await router.request('/v1/platform', { platform: 'feishu' });
  for (const { job } of leased) {
    const auth = { platform: job.platform, ...profiles[job.platform].caller, leaseToken: job.leaseToken };
    await router.request(`/v1/jobs/${job.id}/started`, auth);
    await router.request(`/v1/jobs/${job.id}/result`, { ...auth, text: 'Unique answer for ' + job.platform });
  }
  for (let i = 0; i < 6; i++) await Promise.all(['qq', 'feishu'].map(platform => router.tick(platform)));
  for (const platform of ['qq', 'feishu']) {
    const posted = JSON.stringify(profiles[platform].calls.filter(call => call[0] === 'post'));
    assert.match(posted, new RegExp('Unique answer for ' + platform));
    assert.doesNotMatch(posted, new RegExp('Unique answer for ' + (platform === 'qq' ? 'feishu' : 'qq')));
    assert.equal((await engines[platform].store.status()).delivery.length, 0);
    await engines[platform].deactivate();
  }
});

test('invalid saved channel preferences fail before any connections are opened', async () => {
  for (const channels of [{}, { qq: 'true', feishu: false }, [], true]) {
    const qq = mockEngine('qq'), feishu = mockEngine('feishu');
    const router = new PlatformRouter({ engines: { qq: qq.engine, feishu: feishu.engine }, readSelection: async () => 'qq', writeSelection: async () => {}, readChannels: async () => channels });
    await assert.rejects(router.init(), /配置无效/);
    assert.equal(qq.calls.length, 0); assert.equal(feishu.calls.length, 0);
  }
});
