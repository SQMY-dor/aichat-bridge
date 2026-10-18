import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeStore as QQStore } from '../extension/qq-store.js';
import { BridgeStore as FeishuStore } from '../extension/feishu-store.js';
import { StorageConflictError } from '../extension/storage.js';
class MemoryStorage {
  constructor(state) { this.state = state; this.images = new Map([['unrelated-media', new Blob(['image'])]]); }
  async readState() { return structuredClone(this.state); }
  async listImageKeys() { return [...this.images.keys()]; }
  async readImage(key) { return this.images.get(key); }
  async commit({ expectedRevision, state, deleteImages = [] }) {
    if (this.beforeCommit) await this.beforeCommit();
    if (this.fail) throw new Error('storage failure');
    if (expectedRevision !== this.state.revision) throw new StorageConflictError();
    this.state = { ...structuredClone(state), revision: expectedRevision + 1 };
    for (const key of deleteImages) this.images.delete(key);
    return this.state.revision;
  }
}
function state() {
  const jobs = ['completed', 'failed', 'cancelled', 'queued', 'leased', 'running'].map((state, index) => ({ id: `job${index}`, chatId: 'group', state, createdAt: 1800000000000 }));
  jobs.push({ id: 'delivering', state: 'completed', createdAt: 1800000000000, answerDelivery: { state: 'pending' } });
  jobs.push({ id: 'card-pending', state: 'completed', createdAt: 1800000000000 });
  jobs.push({ id: 'image-pending', state: 'failed', createdAt: 1800000000000 });
  return { version: 1, revision: 0, jobs, groups: {}, seen: { message: 1800000000000 }, receipts: { message: { nextSeq: 2 } }, outbox: [{ id: 'card-pending', kind: 'card' }, { id: 'image-reply', jobId: 'image-pending', kind: 'post' }] };
}
for (const [platform, Store] of [['QQ', QQStore], ['Feishu', FeishuStore]]) {
  test(`${platform}: clearing persists only finished display records and preserves live work, delivery and deduplication`, async () => {
    const initial = state(); const storage = new MemoryStorage(initial); const store = await Store.open({ storage });
    assert.equal((await store.status()).clearableHistoryCount, 3);
    assert.deepEqual(await store.clearHistory(), { ok: true, count: 3 });
    const reopened = await Store.open({ storage });
    assert.deepEqual((await reopened.status()).jobs.map(job => job.id).sort(), ['job3', 'job4', 'job5', 'delivering', 'card-pending', 'image-pending'].sort());
    assert.deepEqual(await reopened.clearHistory(), { ok: true, count: 0 });
    assert.deepEqual(storage.state.outbox, initial.outbox); assert.deepEqual(storage.state.seen, initial.seen);
    assert.deepEqual(storage.state.receipts, initial.receipts); assert.equal(storage.state.jobs.length, initial.jobs.length);
    assert.equal(storage.images.size, 1);
    assert.equal((await reopened.ingest({ messageId: 'message', chatId: 'group', text: 'duplicate' })).duplicate, true);
  });
  test(`${platform}: a failed clear does not hide history and a CAS retry rechecks newly pending delivery`, async () => {
    const initial = state(); initial.jobs = [initial.jobs[0]]; initial.outbox = [];
    const storage = new MemoryStorage(initial); const store = await Store.open({ storage });
    storage.fail = true; await assert.rejects(store.clearHistory(), /storage failure/);
    assert.equal((await store.status()).jobs.length, 1); storage.fail = false;
    storage.beforeCommit = async () => {
      delete storage.beforeCommit;
      storage.state.revision++; storage.state.outbox.push({ id: 'racing-reply', jobId: 'job0' });
    };
    assert.deepEqual(await store.clearHistory(), { ok: true, count: 0 });
    assert.equal((await store.status()).jobs.length, 1); assert.equal(storage.state.jobs[0].historyCleared, undefined);
  });
  test(`${platform}: clearing covers old records beyond the displayed 100 and later tasks stay visible`, async () => {
    const initial = state(); initial.outbox = []; initial.jobs = Array.from({ length: 130 }, (_, i) => ({ id: `old${i}`, state: 'completed', createdAt: 1800000000000 }));
    const storage = new MemoryStorage(initial); const store = await Store.open({ storage });
    assert.equal((await store.status()).jobs.length, 100);
    assert.equal((await store.clearHistory()).count, 130);
    storage.state.jobs.push({ id: 'new', state: 'completed', createdAt: 1800000000001 }); storage.state.revision++;
    assert.deepEqual((await store.status()).jobs.map(job => job.id), ['new']);
  });
}
