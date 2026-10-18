import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeStore, IMAGE_MAX_BYTES } from '../extension/feishu-store.js';
import { StorageConflictError } from '../extension/storage.js';

// A transaction-capable in-memory implementation of the documented storage
// interface. No accounts, Chrome profile, local service or network are used.
class MemoryStorage {
  state = null;
  images = new Map();
  fail = false;
  conflicts = 0;
  async readState() { return structuredClone(this.state); }
  async readImage(key) { if (this.readError) throw this.readError; return this.images.get(key) ?? null; }
  async listImageKeys() { return [...this.images.keys()]; }
  async commit({ expectedRevision, state, putImages = [], deleteImages = [] }) {
    await Promise.resolve();
    if (this.beforeCommit) await this.beforeCommit();
    if (this.fail) throw new Error('synthetic transaction failure');
    if ((this.state?.revision ?? 0) !== expectedRevision) { this.conflicts++; throw new StorageConflictError(); }
    const nextImages = new Map(this.images);
    for (const { key, blob } of putImages) { assert.ok(blob instanceof Blob); nextImages.set(key, blob); }
    for (const key of deleteImages) nextImages.delete(key);
    const revision = expectedRevision + 1;
    this.state = { ...structuredClone(state), revision }; this.images = nextImages;
    return revision;
  }
}

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB2sAAAAASUVORK5CYII=';
const PNG = Uint8Array.from(atob(PNG_BASE64), char => char.charCodeAt(0));
const caller = { chatId: 'oc_browser_a', browserId: 'browser-persistent', tabId: 41, conversationUrl: 'https://chatgpt.com/c/browser-conversation-a', capabilities: ['image-input-v1'] };
const other = { chatId: 'oc_browser_b', browserId: 'browser-persistent', tabId: 42, conversationUrl: 'https://chatgpt.com/c/browser-conversation-b', capabilities: ['image-input-v1'] };
const PRIVATE_PROMPT = 'PRIVATE_RESTRICTED_FIXTURE';
async function fixture() {
  const storage = new MemoryStorage();
  const clock = { now: 1_800_000_000_000, restricted: false, calls: [] };
  const options = { storage, now: () => clock.now, moderate: prompt => {
    clock.calls.push(prompt);
    return { blocked: clock.restricted && prompt.includes(PRIVATE_PROMPT), reason: 'keyword' };
  } };
  const store = await BridgeStore.open(options);
  await store.bind(caller); await store.bind(other);
  // Existing lifecycle regressions explicitly exercise the retained card mode.
  const ingest = (messageId, text = 'synthetic question', images = [], binding = caller) => store.ingest({ messageId, chatId: binding.chatId, text, images, createdAt: clock.now }, { replyStyle: 'card' });
  const lease = async (binding = caller) => { const { job } = await store.poll(binding); assert.ok(job); return { job, auth: { ...binding, leaseToken: job.leaseToken } }; };
  const download = async (buffer = PNG, mimeType = 'image/png') => {
    const item = await store.nextInputImage(); assert.ok(item);
    assert.equal(await store.inputImageDownloaded(item, { buffer, mimeType }), true);
    return item;
  };
  const completeCard = async id => { await store.cardCreated(id, 'om_card_fixture'); const item = await store.nextReply(); if (item?.id === id) await store.cardUpdated(id, item.revision); };
  return { store, storage, clock, options, ingest, lease, download, completeCard };
}

test('browser queue durably deduplicates events, serializes a group and lets another group progress', async () => {
  const f = await fixture();
  const first = await f.ingest('om_first'); const second = await f.ingest('om_second');
  assert.equal((await f.ingest('om_first')).duplicate, true);
  await f.ingest('om_other', 'independent', [], other);
  const { job, auth } = await f.lease();
  assert.equal(job.id, first.jobId); assert.equal((await f.store.poll(caller)).job, null);
  assert.ok((await f.store.poll(other)).job);
  await f.store.started(job.id, auth);
  await f.store.result(job.id, { ...auth, text: 'first answer' });
  await f.store.result(job.id, { ...auth, text: 'duplicate answer' });
  assert.equal(f.storage.state.jobs[0].prompt, undefined);
  assert.equal(f.storage.state.outbox.find(item => item.id === job.id).text, 'first answer');
  assert.equal((await f.lease()).job.id, second.jobId);
});

test('concurrent instances resolve CAS conflicts without duplicate events, leases or start authorization', async () => {
  const f = await fixture(); const second = await BridgeStore.open(f.options);
  const message = { messageId: 'om_race', chatId: caller.chatId, text: 'one question', createdAt: f.clock.now };
  const receipts = await Promise.all([f.store.ingest(message), second.ingest(message)]);
  assert.equal(receipts.filter(item => item.accepted).length, 1);
  assert.equal(receipts.filter(item => item.duplicate).length, 1);
  const polls = await Promise.all([f.store.poll(caller), second.poll(caller)]);
  assert.equal(polls.filter(item => item.job).length, 1);
  const job = polls.find(item => item.job).job; const auth = { ...caller, leaseToken: job.leaseToken };
  const starts = await Promise.allSettled([f.store.started(job.id, auth), second.started(job.id, auth)]);
  assert.equal(starts.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(starts.find(item => item.status === 'rejected').reason.status, 409);
  assert.ok(f.storage.conflicts > 0);
  assert.equal(f.storage.state.jobs.length, 1); assert.equal(f.storage.state.jobs[0].state, 'running');
});

test('cancellation keeps history and deduplication, removes private images and advances the queue with only the existing status card', async () => {
  const f = await fixture();
  const { jobId } = await f.ingest('om_cancel_images', 'private cancelled prompt', [{ imageKey: 'img_first' }, { imageKey: 'img_late' }]);
  await f.download(); const lateImage = await f.store.nextInputImage(); assert.equal(f.storage.images.size, 1);
  const next = await f.ingest('om_next_after_cancel');
  assert.deepEqual(await f.store.cancel(jobId), { ok: true });
  const revision = f.storage.state.revision;
  assert.deepEqual(await f.store.cancel(jobId), { ok: true }); assert.equal(f.storage.state.revision, revision);
  const cancelled = f.storage.state.jobs.find(job => job.id === jobId);
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.finishedAt, f.clock.now);
  for (const field of ['prompt', 'imageRefs', 'inputImages', 'uploads']) assert.equal(cancelled[field], undefined);
  assert.equal(f.storage.images.size, 0);
  assert.equal(await f.store.inputImageDownloaded(lateImage, { buffer: PNG, mimeType: 'image/png' }), false);
  await f.store.inputImageFailed(lateImage, { retryable: false });
  assert.equal(await f.store.nextInputImage(), null);
  const card = await f.store.nextReply();
  assert.equal(card.id, jobId); assert.equal(card.kind, 'card'); assert.equal(card.state, 'cancelled');
  assert.match(card.text, /已手动取消，未发送到 ChatGPT/);
  assert.equal(f.storage.state.outbox.filter(item => item.id === jobId).length, 1);
  assert.ok(f.storage.state.outbox.every(item => item.kind === 'card'));
  const status = await f.store.status();
  assert.equal(status.activeJobCount, 1); assert.equal(status.jobs.find(job => job.id === jobId).state, 'cancelled');
  assert.equal((await f.ingest('om_cancel_images')).duplicate, true);
  assert.equal((await f.store.poll(caller)).job.id, next.jobId);
  const reopened = await BridgeStore.open(f.options); await reopened.recover();
  assert.equal((await reopened.status()).jobs.find(job => job.id === jobId).state, 'cancelled');
  assert.equal((await reopened.nextReply()).state, 'cancelled');
  await reopened.unbind(caller);
});

test('cancellation patches a known status card and survives an in-flight queued card receipt without duplicate cards', async () => {
  for (const alreadyCreated of [false, true]) {
    const f = await fixture(); const { jobId } = await f.ingest('om_cancel_card');
    const queued = await f.store.nextReply();
    if (alreadyCreated) await f.store.cardCreated(jobId, 'om_original_card');
    await f.store.cancel(jobId);
    if (!alreadyCreated) await f.store.cardCreated(jobId, 'om_original_card');
    await f.store.cardUpdated(jobId, queued.revision);
    await f.store.replyFailed(jobId, queued.revision);
    const cancelled = await f.store.nextReply();
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.cardMessageId, 'om_original_card');
    assert.equal(cancelled.id, queued.id); assert.equal(cancelled.revision, queued.revision + 1);
    assert.equal(cancelled.attempts, 0); assert.equal(f.storage.state.outbox.length, 1);
    await f.store.cardUpdated(jobId, cancelled.revision);
    assert.equal(await f.store.nextReply(), null);
  }
});

test('cancellation rejects unknown and already started or ended jobs without changing them', async () => {
  for (const state of ['leased', 'running', 'completed', 'failed']) {
    const f = await fixture(); await f.ingest('om_nonqueued_cancel'); const { job, auth } = await f.lease();
    if (state !== 'leased') await f.store.started(job.id, auth);
    if (state === 'completed') await f.store.result(job.id, { ...auth, text: 'already answered' });
    if (state === 'failed') await f.store.error(job.id, { ...auth, error: 'already failed' });
    const snapshot = structuredClone(f.storage.state);
    await assert.rejects(f.store.cancel(job.id), error => error.status === 409 && /只能取消排队/.test(error.message));
    await assert.rejects(f.store.cancel('missing-job'), error => error.status === 404);
    await assert.rejects(f.store.cancel(null), error => error.status === 400);
    assert.deepEqual(f.storage.state, snapshot);
  }
});

test('status keeps an old queued task visible and cancellable alongside the newest 100 ended jobs', async () => {
  const f = await fixture(); const queued = await f.ingest('om_old_queued'); const history = [];
  for (let index = 0; index < 105; index++) {
    f.clock.now += 1;
    const { jobId } = await f.ingest(`om_newer_ended_${index}`); history.push(jobId); await f.store.cancel(jobId);
  }
  const status = await f.store.status();
  assert.deepEqual(status.jobs.map(job => job.id), [...history.slice(-100).reverse(), queued.jobId]);
  assert.equal(status.jobs.at(-1).state, 'queued'); assert.equal(status.activeJobCount, 1);
  assert.deepEqual(status.queuedChatIds, [caller.chatId]);
  await f.store.cancel(status.jobs.at(-1).id);
  assert.equal(f.storage.state.jobs.find(job => job.id === queued.jobId).state, 'cancelled');
  const finished = await f.store.status();
  assert.equal(finished.activeJobCount, 0); assert.equal(finished.jobs.length, 100); assert.deepEqual(finished.queuedChatIds, []);
});

test('cancellation commits state, card revision and input image deletion atomically', async () => {
  const f = await fixture(); const { jobId } = await f.ingest('om_atomic_cancel', 'private queued text', [{ imageKey: 'img_atomic' }]);
  await f.download(); const snapshot = structuredClone(f.storage.state);
  f.storage.fail = true;
  await assert.rejects(f.store.cancel(jobId), /transaction failure/);
  assert.deepEqual(f.storage.state, snapshot); assert.equal(f.storage.images.size, 1);
  f.storage.fail = false; await f.store.cancel(jobId);
  assert.equal(f.storage.state.jobs[0].state, 'cancelled'); assert.equal(f.storage.images.size, 0);
  assert.equal((await f.store.nextReply()).state, 'cancelled');
});

test('cancellation and polling resolve cross-context races without cancelling an issued lease or leasing a cancelled task', async () => {
  for (const winner of ['cancel', 'poll']) {
    const f = await fixture(); const { jobId } = await f.ingest('om_cancel_race'); const second = await BridgeStore.open(f.options);
    let entered; let release; let held = false;
    const waiting = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
    f.storage.beforeCommit = () => { if (!held) { held = true; entered(); return gate; } };
    const pending = winner === 'cancel' ? f.store.poll(caller) : f.store.cancel(jobId);
    await waiting;
    if (winner === 'cancel') {
      await second.cancel(jobId); release();
      assert.equal((await pending).job, null); assert.equal(f.storage.state.jobs[0].state, 'cancelled');
    } else {
      assert.equal((await second.poll(caller)).job.id, jobId); release();
      await assert.rejects(pending, error => error.status === 409); assert.equal(f.storage.state.jobs[0].state, 'leased');
    }
    assert.ok(f.storage.conflicts > 0);
  }
});

test('an image download already committing cannot restore a concurrently cancelled task', async () => {
  const f = await fixture(); const { jobId } = await f.ingest('om_cancel_download', 'private image', [{ imageKey: 'img_late_cancelled' }]);
  const item = await f.store.nextInputImage(); const second = await BridgeStore.open(f.options);
  let entered; let release; let held = false;
  const waiting = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  f.storage.beforeCommit = () => { if (!held) { held = true; entered(); return gate; } };
  const pending = f.store.inputImageDownloaded(item, { buffer: PNG, mimeType: 'image/png' });
  await waiting; await second.cancel(jobId); release();
  assert.equal(await pending, false); assert.equal(f.storage.images.size, 0);
  assert.equal((await f.store.poll(caller)).job, null); assert.equal((await f.store.nextReply()).state, 'cancelled');
  assert.deepEqual((await f.store.status()).queuedChatIds, []); assert.ok(f.storage.conflicts > 0);
});

test('a start is not acknowledged until the storage transaction finishes and a failed write does not consume the lease', async () => {
  const f = await fixture(); await f.ingest('om_start'); const { job, auth } = await f.lease();
  let finish; let entered; const waiting = new Promise(resolve => { entered = resolve; });
  f.storage.beforeCommit = () => { entered(); return new Promise(resolve => { finish = resolve; }); };
  let authorized = false;
  const pending = f.store.started(job.id, auth).then(value => { authorized = true; return value; });
  await waiting;
  assert.equal(authorized, false); assert.equal(f.storage.state.jobs[0].state, 'leased');
  f.storage.fail = true; finish();
  await assert.rejects(pending, /transaction failure/);
  assert.equal(authorized, false); assert.equal(f.storage.state.jobs[0].state, 'leased');
  f.storage.fail = false; f.storage.beforeCommit = null;
  assert.deepEqual(await f.store.started(job.id, auth), { ok: true });
  await assert.rejects(f.store.started(job.id, auth), /不会再次提交/);
});

test('identity validation prevents cross-tab reads and submissions and duplicate conversation bindings', async () => {
  const f = await fixture(); await f.ingest('om_identity'); const { job, auth } = await f.lease();
  for (const mismatch of [{ tabId: 99 }, { browserId: 'other-browser' }, { conversationUrl: other.conversationUrl }, { leaseToken: 'wrong' }]) await assert.rejects(f.store.started(job.id, { ...auth, ...mismatch }), /不匹配/);
  await assert.rejects(f.store.bind({ ...other, conversationUrl: `${caller.conversationUrl}?x=1#part` }), /已经绑定/);
  await assert.rejects(f.store.bind({ ...other, conversationUrl: 'https://chatgpt.com/g/custom/c/browser-conversation-a' }), /已经绑定/);
  await assert.rejects(f.store.unbind(caller), /待完成/);
  await assert.rejects(f.store.bind({ ...caller, conversationUrl: 'https://evil.example/c/browser-conversation-a' }), /chatgpt/);
});

test('opening storage never recovers automatically; explicit recovery fails pending work and atomically clears private pixels', async () => {
  const f = await fixture(); await f.ingest('om_restart', 'private prompt', [{ imageKey: 'img_private' }]);
  await f.download(); const { job, auth } = await f.lease(); await f.store.started(job.id, auth);
  await f.ingest('om_queued');
  const reopened = await BridgeStore.open(f.options);
  assert.equal(reopened.data.jobs[0].state, 'running'); assert.equal(f.storage.images.size, 1);
  await reopened.recover();
  assert.ok(f.storage.state.jobs.every(job => job.state === 'failed' && !job.prompt && !job.inputImages));
  assert.equal(f.storage.images.size, 0); assert.equal((await reopened.poll(caller)).job, null);
  const count = f.storage.state.outbox.length; await reopened.recover(); assert.equal(f.storage.state.outbox.length, count);
  assert.equal((await reopened.ingest({ messageId: 'om_restart', chatId: caller.chatId, text: 'duplicate', createdAt: f.clock.now })).duplicate, true);
});

test('input images are Blob records, require complete preparation and capability, and are read only through the current lease', async () => {
  const f = await fixture();
  await f.ingest('om_images', '', [{ imageKey: 'img_private_one' }, { imageKey: 'img_private_two' }]);
  await f.ingest('om_after_images', 'later text');
  assert.equal((await f.store.poll(caller)).job, null); await f.download(); assert.equal((await f.store.poll(caller)).job, null);
  await f.download(new Blob([PNG], { type: 'image/png' }));
  const legacy = { ...caller }; delete legacy.capabilities;
  assert.match((await f.store.poll(legacy)).notice, /重新加载/);
  const { job, auth } = await f.lease();
  assert.equal(job.prompt, '请分析这条消息中的图片。'); assert.equal(job.images.length, 1);
  assert.equal(f.storage.images.size, 1); assert.ok([...f.storage.images.values()][0] instanceof Blob);
  assert.doesNotMatch(JSON.stringify(job), /img_private|base64/);
  const image = job.images[0];
  const result = await f.store.inputImage(job.id, { ...auth, imageId: image.id });
  assert.equal(result.base64, PNG_BASE64); assert.equal(result.name, image.name);
  await assert.rejects(f.store.inputImage(job.id, { ...auth, tabId: 99, imageId: image.id }), /不匹配/);
  await assert.rejects(f.store.inputImage(job.id, { ...auth, imageId: 'f'.repeat(64) }), /不属于/);
  const status = JSON.stringify(await f.store.status());
  for (const secret of [PNG_BASE64, 'img_private', image.id, job.leaseToken]) assert.ok(!status.includes(secret));
  await f.store.error(job.id, { ...auth, error: 'upload was not confirmed' });
  assert.equal(f.storage.images.size, 0);
  await assert.rejects(f.store.inputImage(job.id, { ...auth, imageId: image.id }), /结束或失效/);
  assert.equal((await f.lease()).job.prompt, 'later text');
});

test('input state and Blob writes are atomic; quota failures cannot leave ready metadata or orphan pixels', async () => {
  const f = await fixture(); await f.ingest('om_atomic_input', 'picture', [{ imageKey: 'img_atomic' }]);
  const item = await f.store.nextInputImage(); f.storage.fail = true;
  await assert.rejects(f.store.inputImageDownloaded(item, { buffer: PNG, mimeType: 'image/png' }), /transaction failure/);
  assert.equal(f.storage.images.size, 0); assert.equal(f.storage.state.jobs[0].imageRefs[0].ready, undefined);
  f.storage.fail = false; await f.download();
  const { job, auth } = await f.lease();
  f.storage.fail = true;
  await assert.rejects(f.store.error(job.id, { ...auth, error: 'stop' }), /transaction failure/);
  assert.equal(f.storage.images.size, 1); assert.equal(f.storage.state.jobs[0].state, 'leased');
  f.storage.fail = false; await f.store.error(job.id, { ...auth, error: 'stop' }); assert.equal(f.storage.images.size, 0);
});

test('input reads reauthorize after asynchronous Blob access if another extension context ends the job', async () => {
  const f = await fixture(); await f.ingest('om_read_race', 'picture', [{ imageKey: 'img_read_race' }]); await f.download();
  const { job, auth } = await f.lease(); const second = await BridgeStore.open(f.options);
  let enter; let finish;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const read = f.storage.readImage.bind(f.storage);
  f.storage.readImage = async key => { const blob = await read(key); enter(); await gate; return blob; };
  const pending = f.store.inputImage(job.id, { ...auth, imageId: job.images[0].id });
  await entered;
  await second.error(job.id, { ...auth, error: 'task stopped in another context' });
  finish();
  await assert.rejects(pending, /结束或失效/);
  assert.equal(f.storage.images.size, 0);
});

test('image count, magic, size and aggregate limits prevent any partial question from being leased', async () => {
  const f = await fixture();
  assert.equal((await f.ingest('om_five', 'too many', Array.from({ length: 5 }, (_, i) => ({ imageKey: `img_${i}` })))).accepted, false);
  await f.ingest('om_large', 'large pictures', Array.from({ length: 4 }, (_, i) => ({ imageKey: `img_${i}` })));
  const item = await f.store.nextInputImage();
  await assert.rejects(f.store.inputImageDownloaded(item, { buffer: PNG, mimeType: 'image/jpeg' }), /不一致/);
  await assert.rejects(f.store.inputImageDownloaded(item, { buffer: new Uint8Array(IMAGE_MAX_BYTES + 1), mimeType: 'image/png' }), /10 MB/);
  const large = new Uint8Array(IMAGE_MAX_BYTES); large.set(PNG);
  for (let i = 0; i < 3; i++) { large[large.length - 1] = i; await f.download(large); }
  const last = await f.store.nextInputImage();
  await assert.rejects(f.store.inputImageDownloaded(last, { buffer: PNG, mimeType: 'image/png' }), /30 MB/);
  assert.equal((await f.store.poll(caller)).job, null);
  await f.store.inputImageFailed(last, { retryable: false });
  assert.equal(f.storage.images.size, 0); assert.equal(f.storage.state.jobs[0].state, 'failed');
});

test('download failures have a bounded retry delay and late callbacks cannot revive expired work', async () => {
  const f = await fixture(); await f.ingest('om_retry', 'picture', [{ imageKey: 'img_retry' }]);
  for (let i = 0; i < 3; i++) {
    const item = await f.store.nextInputImage(); assert.ok(item);
    await f.store.inputImageFailed(item);
    assert.equal(await f.store.nextInputImage(), null); f.clock.now += 5000;
  }
  assert.equal(f.storage.state.jobs[0].state, 'failed');
  await f.ingest('om_late', 'picture', [{ imageKey: 'img_late' }]);
  const late = await f.store.nextInputImage(); f.clock.now += 16 * 60_000; await f.store.sweep();
  assert.equal(await f.store.inputImageDownloaded(late, { buffer: PNG, mimeType: 'image/png' }), false);
  assert.equal(f.storage.images.size, 0); assert.equal((await f.store.poll(caller)).job, null);
});

test('generated output stays separate from same-content input and preserves its durable Feishu key across reopening', async () => {
  const f = await fixture(); await f.ingest('om_roundtrip', 'repaint', [{ imageKey: 'img_input' }]); await f.download();
  const { job, auth } = await f.lease(); await f.store.started(job.id, auth);
  const upload = await f.store.image(job.id, { ...auth, index: 0, mimeType: 'image/png', base64: PNG_BASE64 });
  assert.equal(upload.imageId, job.images[0].id); assert.equal(f.storage.images.size, 2);
  assert.deepEqual(await f.store.image(job.id, { ...auth, index: 0, mimeType: 'image/png', base64: PNG_BASE64 }), upload);
  await f.store.result(job.id, { ...auth, text: '', images: [upload.imageId] });
  assert.equal(f.storage.images.size, 1); assert.ok([...f.storage.images.keys()][0].startsWith('output:'));
  await f.completeCard(job.id);
  let item = await f.store.nextReply(); const bytes = await f.store.imageBuffer(item);
  assert.ok(bytes instanceof Uint8Array); assert.deepEqual(bytes, PNG);
  await f.store.imageUploaded(item.id, 'img_uploaded_receipt');
  const reopened = await BridgeStore.open(f.options); await reopened.recover(); item = await reopened.nextReply();
  assert.equal(item.imageKey, 'img_uploaded_receipt'); assert.equal(item.image.id, upload.imageId);
  await reopened.replySent(item.id); assert.equal(f.storage.images.size, 0);
});

test('generated uploads are ordered and transactional; result failure cannot delete input or acknowledge an answer', async () => {
  const f = await fixture(); await f.ingest('om_output_atomic', 'picture', [{ imageKey: 'img_input' }]); await f.download();
  const { job, auth } = await f.lease(); await f.store.started(job.id, auth);
  await assert.rejects(f.store.image(job.id, { ...auth, index: 1, mimeType: 'image/png', base64: PNG_BASE64 }), /按顺序/);
  f.storage.fail = true;
  await assert.rejects(f.store.image(job.id, { ...auth, index: 0, mimeType: 'image/png', base64: PNG_BASE64 }), /transaction failure/);
  assert.equal(f.storage.images.size, 1); assert.equal(f.storage.state.jobs[0].uploads, undefined);
  f.storage.fail = false;
  const { imageId } = await f.store.image(job.id, { ...auth, index: 0, mimeType: 'image/png', base64: PNG_BASE64 });
  await assert.rejects(f.store.result(job.id, { ...auth, text: 'answer', images: [] }), /不一致/);
  f.storage.fail = true;
  await assert.rejects(f.store.result(job.id, { ...auth, text: 'answer', images: [imageId] }), /transaction failure/);
  assert.equal(f.storage.state.jobs[0].state, 'running'); assert.equal(f.storage.images.size, 2);
  f.storage.fail = false; await f.store.result(job.id, { ...auth, text: 'answer', images: [imageId] }); assert.equal(f.storage.images.size, 1);
});

test('missing or corrupt generated blobs are permanent failures while database read errors stay retryable', async () => {
  const f = await fixture(); await f.ingest('om_corrupt'); const { job, auth } = await f.lease(); await f.store.started(job.id, auth);
  const { imageId } = await f.store.image(job.id, { ...auth, index: 0, mimeType: 'image/png', base64: PNG_BASE64 });
  await f.store.result(job.id, { ...auth, text: 'answer', images: [imageId] }); await f.completeCard(job.id);
  const item = await f.store.nextReply(); const key = [...f.storage.images.keys()][0]; const original = f.storage.images.get(key);
  f.storage.images.delete(key);
  await assert.rejects(f.store.imageBuffer(item), error => error.code === 'image_missing' && error.retryable === false);
  const changed = new Uint8Array(PNG); changed[changed.length - 1] ^= 1;
  f.storage.images.set(key, new Blob([changed]));
  await assert.rejects(f.store.imageBuffer(item), error => error.code === 'image_corrupt' && error.retryable === false);
  f.storage.images.set(key, original); f.storage.readError = new Error('temporary storage problem');
  await assert.rejects(f.store.imageBuffer(item), error => error.retryable !== false); f.storage.readError = null;
  await f.store.imageReplyRejected(item.id); await f.store.imageReplyRejected(item.id);
  const notice = await f.store.nextReply(); assert.equal(notice.id, `${item.id}:failure`);
  assert.match(notice.text, /图片未能回传/); assert.equal(f.storage.state.jobs[0].state, 'completed');
  await f.store.replySent(notice.id); await f.store.imageReplyRejected(item.id); assert.equal(await f.store.nextReply(), null);
});

test('card receipt races preserve newer revisions and retry deadlines without a duplicate status card', async () => {
  const f = await fixture(); const { jobId } = await f.ingest('om_card_race');
  const creation = await f.store.nextReply(); const { job, auth } = await f.lease(); await f.store.started(job.id, auth);
  const running = await f.store.nextReply(); await f.store.result(job.id, { ...auth, text: 'final answer' });
  await f.store.replyFailed(jobId, creation.revision);
  assert.equal((await f.store.nextReply()).attempts, 0);
  await f.store.cardCreated(jobId, 'om_status_card');
  const final = await f.store.nextReply(); assert.equal(final.cardMessageId, 'om_status_card'); assert.equal(final.text, 'final answer');
  assert.equal(final.createdAt, creation.createdAt);
  await f.store.cardUpdated(jobId, running.revision); assert.equal((await f.store.nextReply()).text, 'final answer');
  await f.store.cardUpdated(jobId, final.revision); assert.equal(await f.store.nextReply(), null);
});

test('moderation rejects text and images without retaining content and duplicate events have one notice', async () => {
  const f = await fixture(); f.clock.restricted = true;
  assert.deepEqual(await f.ingest('om_blocked', PRIVATE_PROMPT, [{ imageKey: 'img_private_blocked' }]), { accepted: false, blocked: true });
  assert.equal((await f.ingest('om_blocked', PRIVATE_PROMPT)).duplicate, true);
  assert.equal(f.storage.state.jobs.length, 0); assert.equal(f.storage.state.outbox.length, 1);
  assert.match(f.storage.state.outbox[0].text, /已拦截/);
  assert.equal(await f.store.nextInputImage(), null); assert.equal(f.storage.images.size, 0);
  assert.ok(!JSON.stringify(f.storage.state).includes(PRIVATE_PROMPT)); assert.doesNotMatch(JSON.stringify(f.storage.state), /img_private_blocked/);
  f.store.moderate = () => { throw new Error('PRIVATE_FILTER_ERROR'); };
  assert.equal((await f.ingest('om_filter_failure', 'normal')).blocked, true);
  assert.match(f.storage.state.outbox.at(-1).text, /配置不可用/); assert.doesNotMatch(JSON.stringify(f.storage.state), /PRIVATE_FILTER_ERROR/);
});

test('hot moderation blocks the head, clears downloaded blobs and refuses late callbacks while later text can progress', async () => {
  const f = await fixture(); const first = await f.ingest('om_hot', PRIVATE_PROMPT, [{ imageKey: 'img_one' }, { imageKey: 'img_two' }]);
  await f.download(); const inFlight = await f.store.nextInputImage(); await f.ingest('om_allowed', 'allowed question');
  f.clock.restricted = true;
  assert.equal((await f.lease()).job.prompt, 'allowed question');
  assert.equal(f.storage.state.jobs.find(job => job.id === first.jobId).blocked, true); assert.equal(f.storage.images.size, 0);
  assert.equal(await f.store.inputImageDownloaded(inFlight, { buffer: PNG, mimeType: 'image/png' }), false); assert.equal(f.storage.images.size, 0);
  assert.equal(f.storage.state.outbox.find(item => item.id === first.jobId).state, 'blocked');
  assert.ok(!JSON.stringify(f.storage.state).includes(PRIVATE_PROMPT));
});

test('download callback rechecks policy after asynchronous hashing and saves no blocked pixels', async () => {
  const f = await fixture(); await f.ingest('om_async_policy', PRIVATE_PROMPT, [{ imageKey: 'img_policy' }]);
  const item = await f.store.nextInputImage(); let checks = 0;
  f.store.moderate = () => ({ blocked: ++checks > 1, reason: 'keyword' });
  assert.equal(await f.store.inputImageDownloaded(item, { buffer: PNG, mimeType: 'image/png' }), false);
  assert.equal(f.storage.images.size, 0); assert.equal(f.storage.state.jobs[0].blocked, true);
});

test('leased moderation authenticates first and persists a blocked state before 409; subsequent errors are idempotent', async () => {
  const f = await fixture(); await f.ingest('om_leased_policy', PRIVATE_PROMPT); const { job, auth } = await f.lease();
  f.clock.restricted = true; f.clock.calls.length = 0;
  await assert.rejects(f.store.started(job.id, { ...auth, leaseToken: 'wrong' }), /不匹配/); assert.equal(f.clock.calls.length, 0);
  f.storage.fail = true; await assert.rejects(f.store.started(job.id, auth), /transaction failure/); assert.equal(f.storage.state.jobs[0].state, 'leased');
  f.storage.fail = false; await assert.rejects(f.store.started(job.id, auth), error => error.status === 409 && /已拦截/.test(error.message));
  assert.equal(f.storage.state.jobs[0].blocked, true); assert.equal(f.storage.state.jobs[0].prompt, undefined);
  const before = structuredClone(f.storage.state);
  assert.deepEqual(await f.store.error(job.id, { ...auth, error: 'PRIVATE_WORKER_ERROR' }), { ok: true });
  assert.deepEqual(f.storage.state, before);
  await f.store.cardCreated(job.id, 'om_inflight_card');
  assert.equal((await f.store.nextReply()).state, 'blocked'); assert.equal((await f.store.nextReply()).cardMessageId, 'om_inflight_card');
});

test('running tasks are not retroactively moderated and input is deleted on successful completion', async () => {
  const f = await fixture(); await f.ingest('om_running_policy', PRIVATE_PROMPT, [{ imageKey: 'img_running' }]); await f.download();
  const { job, auth } = await f.lease(); await f.store.started(job.id, auth);
  f.clock.restricted = true; f.clock.calls.length = 0;
  await f.store.sweep(); assert.equal(await f.store.nextInputImage(), null); assert.equal((await f.store.poll(caller)).job, null);
  assert.equal(f.clock.calls.length, 0); assert.equal(f.storage.state.jobs[0].state, 'running');
  await f.store.result(job.id, { ...auth, text: 'normal finished answer' });
  assert.equal(f.storage.state.jobs[0].state, 'completed'); assert.equal(f.storage.state.jobs[0].blocked, undefined); assert.equal(f.storage.images.size, 0);
});

test('migration imports only validated bindings and recent deduplication without copying jobs, leases or credentials', async () => {
  const storage = new MemoryStorage(); const now = 1_800_000_000_000;
  const store = await BridgeStore.open({ storage, now: () => now, moderate: () => ({ blocked: false }) });
  const input = { groups: { [caller.chatId]: { chatId: caller.chatId, binding: { ...caller, version: 'OLD_VERSION', appSecret: 'PRIVATE_SECRET' }, prompt: 'PRIVATE_PROMPT', lastSeen: now } }, seen: { om_recent: now, om_old: now - 8 * 86_400_000, om_future: now + 60 * 60_000 }, jobs: [{ prompt: 'PRIVATE_JOB' }], outbox: [{ text: 'PRIVATE_ANSWER' }], appSecret: 'PRIVATE_SECRET' };
  assert.deepEqual(await store.importBindings(input), { ok: true, groups: 1, seen: 1 });
  assert.equal(storage.state.jobs.length, 0); assert.equal(storage.state.outbox.length, 0);
  assert.equal(storage.state.groups[caller.chatId].binding.browserId, caller.browserId);
  assert.notEqual(storage.state.groups[caller.chatId].binding.version, 'OLD_VERSION');
  assert.deepEqual(storage.state.seen, { om_recent: now });
  assert.doesNotMatch(JSON.stringify(storage.state), /PRIVATE_|OLD_VERSION/);
  assert.equal((await store.ingest({ messageId: 'om_recent', chatId: caller.chatId, text: 'replayed event', createdAt: now })).duplicate, true);
  assert.equal((await store.ingest({ messageId: 'om_new', chatId: caller.chatId, text: 'new event', createdAt: now })).accepted, true);
  await assert.rejects(store.importBindings(input), /已有任务/);
});

test('invalid and conflicting migrations are rejected atomically and cannot overwrite existing bindings', async () => {
  const storage = new MemoryStorage(); const store = await BridgeStore.open({ storage, moderate: () => ({ blocked: false }) });
  await assert.rejects(store.importBindings({ groups: [{ chatId: caller.chatId, binding: caller }, { chatId: other.chatId, binding: { ...other, conversationUrl: caller.conversationUrl } }] }), /多个群/);
  assert.equal(storage.state, null);
  await assert.rejects(store.importBindings({ groups: [{ chatId: '../wrong', binding: caller }] }), /oc_/);
  await assert.rejects(store.importBindings({ groups: [{ chatId: caller.chatId, binding: { ...caller, conversationUrl: 'https://example.test/c/unsafe' } }] }), /chatgpt/);
  await store.bind(caller);
  const before = structuredClone(storage.state);
  await assert.rejects(store.importBindings({ groups: [{ chatId: caller.chatId, binding: { ...caller, tabId: 999 } }] }), /已有绑定冲突/);
  assert.deepEqual(storage.state, before);
});

test('sweep deletes orphan Blob records, expires queued work and retains only the bounded delivery history', async () => {
  const f = await fixture(); await f.ingest('om_expire', 'picture', [{ imageKey: 'img_expire' }]); await f.download();
  f.storage.images.set('input:orphan', new Blob([PNG])); f.storage.images.set('unrelated-record', new Blob(['keep']));
  await f.store.sweep(); assert.equal(f.storage.images.has('input:orphan'), false); assert.equal(f.storage.images.size, 2);
  f.clock.now += 16 * 60_000; await f.store.sweep();
  assert.equal(f.storage.state.jobs[0].state, 'failed'); assert.equal(f.storage.images.size, 1);
  f.clock.now += 46 * 60_000; await f.store.sweep(); assert.equal((await f.store.status()).delivery[0].state, 'needs_attention');
  f.clock.now += 8 * 86_400_000; await f.store.sweep(); assert.equal(f.storage.state.jobs.length, 0); assert.equal(f.storage.state.outbox.length, 0); assert.deepEqual(f.storage.state.seen, {});
});

test('a failed ingest does not mark an event seen, and omitted moderation safely blocks new work', async () => {
  const f = await fixture(); f.storage.fail = true;
  await assert.rejects(f.ingest('om_failed_event'), /transaction failure/); assert.equal(f.storage.state.seen.om_failed_event, undefined);
  f.storage.fail = false; assert.equal((await f.ingest('om_failed_event')).accepted, true);
  const storage = new MemoryStorage(); const store = await BridgeStore.open({ storage, now: () => f.clock.now }); await store.bind(caller);
  assert.deepEqual(await store.ingest({ messageId: 'om_no_filter', chatId: caller.chatId, text: 'question', createdAt: f.clock.now }), { accepted: false, blocked: true });
  assert.match(storage.state.outbox[0].text, /配置不可用/); assert.equal(storage.state.jobs.length, 0);
});

async function separateJob(f, id = 'om_separate') {
  await f.store.ingest({ messageId: id, chatId: caller.chatId, text: 'separate answer please', createdAt: f.clock.now });
  const { job, auth } = await f.lease(); await f.store.started(job.id, auth);
  return { job, auth };
}

test('new jobs default to separate while explicit card and historical jobs keep their original answer mode', async () => {
  const f = await fixture(); const { job, auth } = await separateJob(f);
  assert.equal(f.storage.state.jobs[0].replyStyle, 'separate');
  await f.store.result(job.id, { ...auth, text: 'new separate answer' });
  assert.ok(f.storage.state.outbox.some(item => item.kind === 'post'));
  assert.equal(f.storage.state.outbox.find(item => item.id === job.id).state, 'sending');
  await f.ingest('om_old', 'historical question');
  const historical = f.storage.state.jobs.find(item => item.messageId === 'om_old'); delete historical.replyStyle;
  const old = await f.lease(); await f.store.started(old.job.id, old.auth);
  await f.store.result(old.job.id, { ...old.auth, text: 'historical full card answer' });
  const oldCard = f.storage.state.outbox.find(item => item.id === old.job.id);
  assert.equal(oldCard.state, 'completed'); assert.equal(oldCard.text, 'historical full card answer');
  assert.equal(f.storage.state.outbox.some(item => item.kind === 'post' && item.jobId === old.job.id), false);
  await assert.rejects(f.store.ingest({ messageId: 'om_invalid_mode', chatId: caller.chatId, text: 'question', createdAt: f.clock.now }, { replyStyle: 'invalid' }), /回复方式无效/);
  assert.equal(f.storage.state.seen.om_invalid_mode, undefined);
});

test('separate answers keep full text and code out of status cards and confirm completion only after every post and image', async () => {
  const f = await fixture(); const { job, auth } = await separateJob(f);
  const answer = 'PRIVATE_FINAL_BODY\n\n```python\nprint("exact code")\n```';
  const { imageId } = await f.store.image(job.id, { ...auth, index: 0, mimeType: 'image/png', base64: PNG_BASE64 });
  await f.store.result(job.id, { ...auth, text: answer, images: [imageId] });
  const sending = f.storage.state.outbox.find(item => item.id === job.id);
  assert.equal(sending.state, 'sending'); assert.doesNotMatch(sending.text, /已发送|PRIVATE_FINAL_BODY|print/);
  const parts = f.storage.state.outbox.filter(item => item.kind === 'post');
  assert.ok(parts.length); assert.ok(JSON.stringify(parts).includes('PRIVATE_FINAL_BODY')); assert.ok(JSON.stringify(parts).includes('code_block'));
  await f.completeCard(job.id);
  for (const [index, part] of parts.entries()) {
    assert.equal((await f.store.nextReply()).id, `${job.id}:post:${index}`);
    await f.store.replySent(part.id);
  }
  assert.equal(f.storage.state.jobs[0].answerDelivery.state, 'pending');
  assert.equal(f.storage.state.outbox.some(item => item.id === job.id && item.state === 'completed'), false);
  const image = await f.store.nextReply(); assert.equal(image.kind, 'image');
  await f.store.imageUploaded(image.id, 'img_saved'); await f.store.replySent(image.id);
  const final = await f.store.nextReply();
  assert.equal(final.kind, 'card'); assert.equal(final.state, 'completed'); assert.match(final.text, /正文和图片已发送/);
  assert.equal(final.cardMessageId, 'om_card_fixture'); assert.doesNotMatch(final.text, /PRIVATE_FINAL_BODY|print/);
  assert.equal(f.storage.images.size, 0);
  const delivered = structuredClone(f.storage.state.jobs[0].answerDelivery);
  await f.store.replySent(image.id); assert.deepEqual(f.storage.state.jobs[0].answerDelivery, delivered);
});

test('split post contents and IDs survive partial delivery, backoff and reopening without regenerating completed parts', async () => {
  const f = await fixture(); const { job, auth } = await separateJob(f);
  await f.store.result(job.id, { ...auth, text: 'Long answer line.\n'.repeat(4000) }); await f.completeCard(job.id);
  const parts = structuredClone(f.storage.state.outbox.filter(item => item.kind === 'post')); assert.ok(parts.length > 1);
  await f.store.replySent(parts[0].id); await f.store.replyFailed(parts[1].id);
  assert.equal(await f.store.nextReply(), null);
  const reopened = await BridgeStore.open(f.options); await reopened.recover(); f.clock.now += 3000;
  const retry = await reopened.nextReply(); assert.equal(retry.id, parts[1].id); assert.deepEqual(retry.post, parts[1].post);
  assert.equal(f.storage.state.outbox.some(item => item.id === parts[0].id), false);
  for (const part of parts.slice(1)) { assert.equal((await reopened.nextReply()).id, part.id); await reopened.replySent(part.id); }
  assert.equal((await reopened.nextReply()).state, 'completed');
  assert.equal(f.storage.state.jobs[0].answerDelivery.sentPosts, parts.length);
});

test('a failed final-result or post acknowledgement transaction cannot claim the answer was delivered', async () => {
  const f = await fixture(); const { job, auth } = await separateJob(f);
  f.storage.fail = true;
  await assert.rejects(f.store.result(job.id, { ...auth, text: 'answer to persist' }), /transaction failure/);
  assert.equal(f.storage.state.jobs[0].state, 'running'); assert.equal(f.storage.state.outbox.some(item => item.kind === 'post'), false);
  f.storage.fail = false; await f.store.result(job.id, { ...auth, text: 'answer to persist' }); await f.completeCard(job.id);
  const item = await f.store.nextReply(); f.storage.fail = true;
  await assert.rejects(f.store.replySent(item.id), /transaction failure/);
  assert.equal(f.storage.state.jobs[0].answerDelivery.state, 'pending'); assert.equal(f.storage.state.jobs[0].answerDelivery.sentPosts, 0);
  assert.ok(f.storage.state.outbox.some(part => part.id === item.id));
  f.storage.fail = false; await f.store.replySent(item.id);
  assert.equal((await f.store.nextReply()).state, 'completed');
});

test('a permanent post rejection retains unsent parts and changes the same status card to failed instead of sending forever', async () => {
  const f = await fixture(); const { job, auth } = await separateJob(f);
  await f.store.result(job.id, { ...auth, text: 'Unsatisfied delivery section.\n'.repeat(2400) }); await f.completeCard(job.id);
  const first = await f.store.nextReply(); await f.store.postReplyRejected(first.id);
  assert.ok(f.storage.state.outbox.filter(item => item.kind === 'post').every(item => item.abandoned));
  assert.equal(f.storage.state.jobs[0].answerDelivery.state, 'failed');
  const final = await f.store.nextReply(); assert.equal(final.kind, 'card'); assert.equal(final.state, 'failed');
  assert.equal(final.cardMessageId, 'om_card_fixture'); assert.match(final.text, /未能全部送达/); assert.doesNotMatch(final.text, /已发送|Unsatisfied/);
  const revision = final.revision; await f.store.postReplyRejected(first.id); assert.equal((await f.store.nextReply()).revision, revision);
  assert.ok((await f.store.status()).delivery.some(item => item.state === 'needs_attention'));
});

test('expired post retries leave a failed status, and a known card can patch beyond an older revision retry window', async () => {
  const f = await fixture(); const { job, auth } = await separateJob(f);
  // The queued card was created, but the sending PATCH is still in outbox.
  await f.store.cardCreated(job.id, 'om_known_status');
  await f.store.result(job.id, { ...auth, text: 'body that times out' });
  assert.equal((await f.store.nextReply()).state, 'sending');
  f.clock.now += 46 * 60_000; await f.store.sweep();
  const final = await f.store.nextReply();
  assert.equal(final.kind, 'card'); assert.equal(final.state, 'failed'); assert.equal(final.cardMessageId, 'om_known_status');
  assert.equal(final.abandoned, undefined); assert.equal(final.createdAt, f.clock.now);
  assert.ok(f.storage.state.outbox.filter(item => item.kind === 'post').every(item => item.abandoned));
  assert.equal(f.storage.state.jobs[0].answerDelivery.state, 'failed');
});

test('image-only separate answers send no artificial body post and report image failure on the status card', async () => {
  const f = await fixture(); const { job, auth } = await separateJob(f);
  const { imageId } = await f.store.image(job.id, { ...auth, index: 0, mimeType: 'image/png', base64: PNG_BASE64 });
  await f.store.result(job.id, { ...auth, text: '', images: [imageId] }); await f.completeCard(job.id);
  assert.equal(f.storage.state.outbox.some(item => item.kind === 'post'), false);
  const image = await f.store.nextReply(); await f.store.imageReplyRejected(image.id);
  const final = f.storage.state.outbox.find(item => item.id === job.id);
  assert.equal(final.state, 'failed'); assert.doesNotMatch(final.text, /已发送/);
  assert.equal(f.storage.state.jobs[0].answerDelivery.state, 'failed');
});

test('an old running-card receipt cannot remove or back off a newer sending or completed revision', async () => {
  const f = await fixture(); const { job, auth } = await separateJob(f);
  await f.store.cardCreated(job.id, 'om_status_same');
  const running = await f.store.nextReply(); assert.equal(running.state, 'running');
  await f.store.result(job.id, { ...auth, text: 'standalone complete answer' });
  const sending = await f.store.nextReply(); assert.equal(sending.state, 'sending');
  await f.store.cardUpdated(job.id, running.revision); await f.store.replyFailed(job.id, running.revision);
  assert.deepEqual(await f.store.nextReply(), sending);
  await f.store.cardUpdated(job.id, sending.revision);
  const post = await f.store.nextReply(); await f.store.replySent(post.id);
  const final = await f.store.nextReply(); assert.equal(final.state, 'completed');
  await f.store.cardUpdated(job.id, sending.revision); await f.store.replyFailed(job.id, sending.revision);
  await f.store.replySent(post.id);
  assert.deepEqual(await f.store.nextReply(), final);
  assert.equal(f.storage.state.jobs[0].answerDelivery.sentPosts, 1);
});

test('permanent post rejection abandons later body sections but still delivers images before the failed final card', async () => {
  const f = await fixture(); const { job, auth } = await separateJob(f);
  const { imageId } = await f.store.image(job.id, { ...auth, index: 0, mimeType: 'image/png', base64: PNG_BASE64 });
  await f.store.result(job.id, { ...auth, text: 'Long body and image.\n'.repeat(2400), images: [imageId] });
  await f.completeCard(job.id);
  const first = await f.store.nextReply(); await f.store.postReplyRejected(first.id);
  const abandoned = f.storage.state.outbox.filter(item => item.kind === 'post');
  assert.ok(abandoned.length > 1); assert.ok(abandoned.every(item => item.abandoned));
  assert.equal(f.storage.state.jobs[0].answerDelivery.state, 'pending');
  const image = await f.store.nextReply(); assert.equal(image.kind, 'image'); assert.equal(image.abandoned, undefined);
  await f.store.imageUploaded(image.id, 'img_after_body_failure'); await f.store.replySent(image.id);
  const final = await f.store.nextReply(); assert.equal(final.state, 'failed'); assert.equal(final.cardMessageId, 'om_card_fixture');
  assert.equal(f.storage.state.jobs[0].answerDelivery.sentImages, 1);
  assert.equal(f.storage.state.jobs[0].answerDelivery.sentPosts, 0);
  assert.equal(f.storage.images.size, 0);
});

test('generated images enforce four slots, ten MB per image and thirty MB total before creating any image replies', async () => {
  const f = await fixture(); const { job, auth } = await separateJob(f, 'om_output_limits');
  await assert.rejects(f.store.image(job.id, { ...auth, index: 4, mimeType: 'image/png', buffer: PNG }), /4 张/);
  await assert.rejects(f.store.image(job.id, { ...auth, index: 0, mimeType: 'image/png', buffer: new Uint8Array(IMAGE_MAX_BYTES + 1) }), /10 MB/);
  assert.equal(f.storage.images.size, 0);
  const large = new Uint8Array(IMAGE_MAX_BYTES); large.set(PNG); const ids = [];
  for (let index = 0; index < 3; index++) {
    large[large.length - 1] = index;
    ids.push((await f.store.image(job.id, { ...auth, index, mimeType: 'image/png', buffer: large })).imageId);
  }
  assert.equal(f.storage.state.jobs[0].uploads.reduce((sum, image) => sum + image.bytes, 0), 30_000_000);
  await assert.rejects(f.store.image(job.id, { ...auth, index: 3, mimeType: 'image/png', buffer: PNG }), /30 MB/);
  await assert.rejects(f.store.result(job.id, { ...auth, text: 'partial answer', images: ids.slice(0, 2) }), /不一致/);
  assert.equal(f.storage.state.outbox.some(item => item.kind === 'image'), false);
  await f.store.result(job.id, { ...auth, text: '', images: ids });
  assert.equal(f.storage.state.outbox.filter(item => item.kind === 'image').length, 3);
  assert.equal(f.storage.state.jobs[0].answerDelivery.state, 'pending');
});
