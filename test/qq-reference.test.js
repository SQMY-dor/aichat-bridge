import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage } from '../extension/qq-message.js';
import { BridgeStore } from '../extension/qq-store.js';
import { createWordFilter } from '../extension/moderation.js';

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const image = index => ({ content_type: 'image/png', size: PNG.length + 1, url: `https://gchat.qpic.cn/fixture-${index}.png` });
const now = 1_800_000_000_000;
const caller = { chatId: 'REFERENCE_GROUP', browserId: 'reference-browser', tabId: 7, conversationUrl: 'https://chatgpt.com/c/reference-fixture', capabilities: ['image-input-v1'] };
const event = extras => ({ t: 'GROUP_AT_MESSAGE_CREATE', d: {
  id: 'ref_message', group_openid: caller.chatId, author: { member_openid: 'reference-user' },
  timestamp: new Date(now).toISOString(), message_type: 103, content: '如何评价这张图？', ...extras,
} });
async function fixture() {
  let saved; const blobs = new Map(); const filter = createWordFilter(['禁词fixture']);
  const store = await BridgeStore.open({ now: () => now, moderate: filter, storage: {
    async readState() { return saved ? structuredClone(saved) : null; },
    async listImageKeys() { return [...blobs.keys()]; }, async readImage(key) { return blobs.get(key) ?? null; },
    async commit({ expectedRevision, state, putImages = [], deleteImages = [] }) {
      assert.equal(expectedRevision, saved?.revision ?? 0);
      for (const image of putImages) blobs.set(image.key, image.blob);
      for (const key of deleteImages) blobs.delete(key);
      saved = { ...structuredClone(state), revision: expectedRevision + 1 }; return saved.revision;
    },
  } });
  await store.bind(caller); return { store, blobs };
}

test('a QQ quoted image and current question reach the ordinary GPT image lease together', async () => {
  const f = await fixture();
  const message = normalizeMessage(event({ msg_elements: [{ message_type: 0, content: '此前发的图片', attachments: [image(0)] }] }));
  assert.equal(message.unsupportedAttachments, undefined);
  assert.equal((await f.store.ingest(message)).accepted, true);
  assert.equal((await f.store.poll(caller)).job, null);
  const item = await f.store.nextInputImage(); assert.equal(item.imageKey, image(0).url);
  await f.store.inputImageDownloaded(item, { buffer: Uint8Array.from([...PNG, 0]), mimeType: 'image/png' });
  const { job } = await f.store.poll(caller);
  assert.match(job.prompt, /如何评价这张图/); assert.match(job.prompt, /此前发的图片/);
  assert.equal(job.images.length, 1);
  const auth = { ...caller, leaseToken: job.leaseToken }; await f.store.started(job.id, auth);
  const payload = await f.store.inputImage(job.id, { ...auth, imageId: job.images[0].id });
  assert.deepEqual(Buffer.from(payload.base64, 'base64'), Buffer.from([...PNG, 0]));
  assert.equal((await f.store.poll(caller)).job, null, 'the same reference never causes another lease');
});

test('current and quoted images share ordered durable preparation and the four-image limit', async () => {
  const f = await fixture();
  const message = normalizeMessage(event({ attachments: [image(0)], msg_elements: [
    { attachments: [image(1), image(0)], msg_elements: [{ attachments: [image(2)] }] }, { attachments: [image(3)] },
  ] }));
  assert.equal((await f.store.ingest(message)).accepted, true);
  for (let index = 0; index < 4; index++) {
    assert.equal((await f.store.poll(caller)).job, null);
    const item = await f.store.nextInputImage(); assert.equal(item.imageKey, image(index).url);
    await f.store.inputImageDownloaded(item, { buffer: Uint8Array.from([...PNG, index]), mimeType: 'image/png' });
  }
  const { job } = await f.store.poll(caller); assert.equal(job.images.length, 4);
  assert.equal(f.blobs.size, 4); assert.equal(new Set(job.images.map(image => image.id)).size, 4);
  const auth = { ...caller, leaseToken: job.leaseToken }; await f.store.started(job.id, auth);
  for (const [index, image] of job.images.entries()) {
    const payload = await f.store.inputImage(job.id, { ...auth, imageId: image.id });
    assert.deepEqual(Buffer.from(payload.base64, 'base64'), Buffer.from([...PNG, index]));
  }
  const excessive = normalizeMessage(event({ id: 'five-reference-images', attachments: [image(0)], msg_elements: [{ attachments: [image(1), image(2), image(3), image(4)] }] }));
  assert.equal((await f.store.ingest(excessive)).accepted, false);
  assert.match((await f.store.nextReply()).text, /4 张图片/);
  assert.equal((await f.store.status()).jobs.length, 1);
});

test('both public QQ reference text shapes normalize into one bounded ordinary text task', async () => {
  for (const extra of [
    { content: '你跟群里的小肥鱼聊两句', msg_elements: [{ message_type: 103, content: '你想让我跟谁聊两句？' }] },
    { content: ' ', msg_elements: [{ content: '=== 消息 1 ===\n[消息内容] 请评价\n=== 消息 2 ===\n[消息内容] 解释一下' }] },
  ]) {
    const f = await fixture(); const message = normalizeMessage(event(extra));
    assert.equal((await f.store.ingest(message)).accepted, true);
    const { job } = await f.store.poll(caller); assert.equal(job.prompt, message.text);
    assert.ok(job.prompt.length <= 12000); assert.equal(job.images, undefined);
    assert.equal((await f.store.status()).jobs.length, 1);
  }
});

test('missing reference images and excessive context stop with specific feedback before GPT sees partial text', async () => {
  const cases = [
    [{ msg_elements: [{ attachments: [{ content_type: 'image/png' }] }] }, /引用图片/],
    [{ msg_elements: [{ content: 'x'.repeat(12001) }] }, /过多或过长/],
    [{ content: ' ', msg_elements: [] }, /没有提供/],
  ];
  for (const [extra, explanation] of cases) {
    const f = await fixture(); const message = normalizeMessage(event(extra));
    assert.equal((await f.store.ingest(message)).accepted, false);
    assert.equal((await f.store.status()).jobs.length, 0); assert.equal((await f.store.poll(caller)).job, null);
    assert.equal(await f.store.nextInputImage(), null); assert.match((await f.store.nextReply()).text, explanation);
  }
});

test('quoted text still passes the word filter before any referenced image is downloaded', async () => {
  const f = await fixture();
  const message = normalizeMessage(event({ msg_elements: [{ content: '禁词fixture', attachments: [image(0)] }] }));
  assert.equal((await f.store.ingest(message)).blocked, true);
  assert.equal((await f.store.status()).jobs.length, 0); assert.equal(await f.store.nextInputImage(), null); assert.equal(f.blobs.size, 0);
});
