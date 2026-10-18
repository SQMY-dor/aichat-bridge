import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeStore as QQStore } from '../extension/qq-store.js';
import { BridgeStore as FeishuStore } from '../extension/feishu-store.js';
import { resultTiming } from '../extension/shared.js';

const outputTiming = { confirmationMs: 800, imagePreparationMs: 0, background: false };
const baseTime = 1_800_000_000_000;
async function fixture(Store, chatId) {
  let state; let now = baseTime;
  const images = new Map();
  const store = await Store.open({ now: () => now, moderate: () => ({ blocked: false }), storage: {
    async readState() { return state ? structuredClone(state) : null; },
    async readImage(key) { return images.get(key) ?? null; },
    async listImageKeys() { return [...images.keys()]; },
    async commit({ expectedRevision, state: next, putImages = [], deleteImages = [] }) {
      assert.equal(state?.revision ?? 0, expectedRevision);
      for (const image of putImages) images.set(image.key, image.blob);
      for (const key of deleteImages) images.delete(key);
      state = { ...structuredClone(next), revision: expectedRevision + 1 }; return state.revision;
    },
  } });
  const caller = { chatId, browserId: 'timing-browser', tabId: 6, conversationUrl: 'https://chatgpt.com/c/inbound-timing' };
  await store.bind(caller);
  return { store, caller, state: () => state, advance: ms => { now += ms; } };
}

test('optional input preparation durations are bounded and do not retain arbitrary page fields', () => {
  for (const inputPreparationMs of [0, 700, 600000]) {
    assert.deepEqual(resultTiming({ ...outputTiming, inputPreparationMs, prompt: 'private page text', token: 'private' }), { ...outputTiming, inputPreparationMs });
  }
  for (const inputPreparationMs of [-1, 600001, Infinity, NaN, 0.5, '700', {}, null]) {
    assert.deepEqual(resultTiming({ ...outputTiming, inputPreparationMs }), outputTiming);
  }
  assert.deepEqual(resultTiming(outputTiming), outputTiming);
});

for (const [name, Store, chatId] of [['QQ', QQStore, 'GROUP_TIMING'], ['Feishu', FeishuStore, 'oc_timing']]) {
  test(`${name}: queued wake targets and controls retain old tasks alongside limited recent history`, async () => {
    const f = await fixture(Store, chatId);
    await f.store.ingest({ messageId: 'om_queued', chatId, text: 'question', createdAt: baseTime });
    f.state().jobs.push(...Array.from({ length: 100 }, (_, index) => ({ id: `finished-${index}`, chatId: 'other-group', state: 'completed', createdAt: baseTime + index + 1 })));
    const status = await f.store.status();
    assert.equal(status.jobs.length, 101); assert.ok(status.jobs.slice(0, 100).every(job => job.state === 'completed'));
    assert.equal(status.jobs.at(-1).state, 'queued'); assert.equal(status.jobs.at(-1).chatId, chatId);
    assert.equal(status.activeJobCount, 1);
    assert.deepEqual(status.queuedChatIds, [chatId]);
  });

  test(`${name}: inbound timing covers local queue handoff and editor preparation without affecting authorization`, async () => {
    const f = await fixture(Store, chatId);
    await f.store.ingest({ messageId: 'om_timing', chatId, text: 'private question', createdAt: baseTime });
    assert.equal((await f.store.status()).jobs[0].timing, undefined);
    f.advance(4000);
    const { job } = await f.store.poll(f.caller);
    assert.equal((await f.store.status()).jobs[0].timing, undefined);
    f.advance(25);
    const auth = { ...f.caller, leaseToken: job.leaseToken };
    await f.store.started(job.id, auth);
    assert.deepEqual((await f.store.status()).jobs[0].timing, { handoffMs: 4025 });
    f.advance(15000);
    assert.deepEqual((await f.store.status()).jobs[0].timing, { handoffMs: 4025 });
    await f.store.result(job.id, { ...auth, text: 'private answer', timing: { ...outputTiming, inputPreparationMs: 2700, token: 'never-persist-this' } });
    const timings = (await f.store.status()).jobs[0].timing;
    assert.equal(timings.handoffMs, 4025); assert.equal(timings.inputPreparationMs, 2700);
    assert.equal(timings.confirmationMs, 800); assert.equal(timings.imagePreparationMs, 0);
    assert.doesNotMatch(JSON.stringify(f.state()), /never-persist-this/);
    assert.doesNotMatch(JSON.stringify(await f.store.status()), /private question|private answer/);
  });

  test(`${name}: legacy tasks without a start timestamp never invent inbound waiting time`, async () => {
    const f = await fixture(Store, chatId);
    await f.store.ingest({ messageId: 'om_legacy', chatId, text: 'question', createdAt: baseTime });
    const { job } = await f.store.poll(f.caller); const auth = { ...f.caller, leaseToken: job.leaseToken };
    await f.store.started(job.id, auth); await f.store.result(job.id, { ...auth, text: 'answer' });
    delete f.state().jobs[0].startedAt;
    f.advance(100000);
    assert.equal((await f.store.status()).jobs[0].timing?.handoffMs, undefined);
    assert.equal((await f.store.status()).jobs[0].timing?.inputPreparationMs, undefined);
  });
}
