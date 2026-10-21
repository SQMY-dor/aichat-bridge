import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeStore, OUTPUT_IMAGE_MAX_BYTES } from '../extension/qq-store.js';
import { StorageConflictError } from '../extension/storage.js';

class MemoryStorage {
  state = null; images = new Map();
  async readState() { return structuredClone(this.state); }
  async readImage(key) { return this.images.get(key) ?? null; }
  async listImageKeys() { return [...this.images.keys()]; }
  async commit({ expectedRevision, state, putImages = [], deleteImages = [] }) {
    await Promise.resolve();
    if (this.beforeCommit) await this.beforeCommit();
    if (this.fail) throw new Error('synthetic transaction failure');
    if ((this.state?.revision ?? 0) !== expectedRevision) throw new StorageConflictError();
    for (const {key,blob} of putImages) this.images.set(key,blob);
    for (const key of deleteImages) this.images.delete(key);
    const revision = expectedRevision + 1;
    this.state = {...structuredClone(state),revision}; return revision;
  }
}
const caller = { chatId: 'GROUP_OPENID_A', browserId:'persistent', tabId:4, conversationUrl:'https://chatgpt.com/c/qq-conversation', capabilities:['image-input-v1'] };
const PNG = Uint8Array.from([137,80,78,71,13,10,26,10,1]);
async function fixture() {
  const storage = new MemoryStorage(); const clock = {now:1_800_000_000_000, blocked:false};
  const options = {storage,now:()=>clock.now,moderate:()=>({blocked:clock.blocked,reason:'keyword'})};
  const store = await BridgeStore.open(options); await store.bind(caller);
  const ingest = (id='message1',extra={}) => store.ingest({messageId:id,chatId:caller.chatId,text:'hello',createdAt:clock.now,...extra});
  const start = async () => { const {job}=await store.poll(caller); assert.ok(job); const auth={...caller,leaseToken:job.leaseToken}; await store.started(job.id,auth); return {job,auth}; };
  return {store,storage,clock,options,ingest,start};
}
test('QQ status uses local queue; final posts alone consume reply slots', async()=>{
 const f=await fixture(); await f.ingest(); assert.equal(await f.store.nextReply(),null);
 const {job,auth}=await f.start(); assert.equal(await f.store.nextReply(),null);
 await f.store.result(job.id,{...auth,text:'**你好**\n\n```js\n  x();\n```'});
 const item=await f.store.nextReply(); assert.equal(item.kind,'post'); assert.equal(item.msgSeq,1); assert.match(item.post,/x\(\)/);
 assert.equal((await f.store.status()).jobs[0].state,'delivering');
 await f.store.replySent(item.id); assert.equal((await f.store.status()).jobs[0].state,'completed'); assert.equal(await f.store.nextReply(),null);
});
test('QQ final text plus four images have exactly five stable sequences and no completion message',async()=>{
 const f=await fixture(); await f.ingest(); const {job,auth}=await f.start(); const ids=[];
 for(let index=0;index<4;index++) ids.push((await f.store.image(job.id,{...auth,index,buffer:new Uint8Array([...PNG,index]),mimeType:'image/png'})).imageId);
 await f.store.result(job.id,{...auth,text:'结果',images:ids});
 assert.deepEqual(f.storage.state.outbox.map(x=>x.msgSeq),[1,2,3,4,5]);
 const original=await f.store.nextReply(); await f.store.replyFailed(original.id); f.clock.now+=5000;
 assert.equal((await f.store.nextReply()).msgSeq,1);
 for(let i=0;i<5;i++){const item=await f.store.nextReply();assert.ok(item);await f.store.replySent(item.id);}
 assert.equal(await f.store.nextReply(),null);assert.equal((await f.store.status()).jobs[0].state,'completed');
});
test('QQ reply window starts at original event timestamp, never extends on leasing/retry',async()=>{
 const f=await fixture();const sent=f.clock.now-60_000;await f.ingest('older',{createdAt:sent});
 const {job,auth}=await f.start();
 // 网页侧可以等很久（不再等于 QQ 窗口），但真正投递用的 outbox 严格用原始消息时间戳。
 assert.ok(job.timeoutMs>190_000,'生成等待不应再被 QQ 的 5 分钟窗口截断');
 await f.store.result(job.id,{...auth,text:'answer'});const item=await f.store.nextReply();assert.equal(item.expiresAt,sent+295_000);
 f.clock.now=sent+295_001;await f.store.sweep();assert.equal(await f.store.nextReply(),null);
});
test('a queued job keeps waiting for the web page past the QQ window instead of failing early',async()=>{
 const f=await fixture();await f.ingest();
 // 越过旧的 251 秒门槛：任务仍在等待网页，不应被判超时。
 f.clock.now+=251_000;await f.store.sweep();
 assert.equal((await f.store.status()).jobs[0].state,'queued','不应在 QQ 窗口到点时就放弃生成');
 assert.equal(await f.store.nextReply(),null);
 // 页面此时才来领取，应当拿到任务（窗口靠投递时再判断）。
 const {job}=await f.start();assert.ok(job);
});

test('an answer that arrives after the QQ window is kept instead of silently dropped',async()=>{
 const f=await fixture();await f.ingest();
 const {job,auth}=await f.start();
 // 页面写完了，但 QQ 的 5 分钟已过。
 f.clock.now+=300_001;
 let result;
 try { result=await f.store.result(job.id,{...auth,text:'很久之后才写完的答案'}); }
 catch (e) { console.log('RESULT THREW:', e.message); throw e; }
 assert.equal(result.delivered,false);assert.equal(result.reason,'expired-window');
 const status=await f.store.status();
 const finished=status.jobs[0];
 assert.equal(finished.state,'completed','答案有效，任务应完成而不是失败');
 assert.equal(finished.answerText,'很久之后才写完的答案','完整答案必须保留下来');
 assert.equal(finished.deliveryState,'expired-window');
 assert.match(finished.notice,/5 分钟被动回复窗口已过/);
 assert.equal(await f.store.nextReply(),null,'不应尝试向已关闭的窗口投递');
});
test('QQ four inbound images are all durable before one lease and original order is preserved',async()=>{
 const f=await fixture();await f.ingest('multi',{images:Array.from({length:4},(_,i)=>({imageKey:`https://multimedia.nt.qq.com.cn/download?id=${i}`}))});
 for(let i=0;i<4;i++){assert.equal((await f.store.poll(caller)).job,null);const image=await f.store.nextInputImage();assert.equal(image.index,i);await f.store.inputImageDownloaded(image,{buffer:new Uint8Array([...PNG,i]),mimeType:'image/png'});}
 const {job}=await f.start();assert.equal(job.images.length,4);assert.equal((await f.store.poll(caller)).job,null);
});
test('QQ rejects oversized output images before sending a partial answer',async()=>{
 const f=await fixture();await f.ingest();const {job,auth}=await f.start();const image=new Uint8Array(OUTPUT_IMAGE_MAX_BYTES+1);image.set(PNG);
 await assert.rejects(f.store.image(job.id,{...auth,index:0,buffer:image,mimeType:'image/png'}),/4.9 MB/);assert.equal(f.storage.images.size,0);
});
test('QQ too many final parts abort atomically, then sends just one useful failure',async()=>{
 const f=await fixture();await f.ingest();const {job,auth}=await f.start();
 await assert.rejects(f.store.result(job.id,{...auth,text:'字'.repeat(10000)}),/5 条/);assert.equal(await f.store.nextReply(),null);
 await f.store.error(job.id,{...auth,error:'正文过长，请在网页查看完整回复'});const notice=await f.store.nextReply();assert.equal(notice.msgSeq,1);assert.match(notice.text,/正文过长/);
});
test('QQ unsupported attachment and moderation reject the whole message without opening a webpage task',async()=>{
 const f=await fixture();await f.ingest('bad',{unsupportedAttachments:true});assert.equal(f.storage.state.jobs.length,0);assert.match((await f.store.nextReply()).text,/不支持/);
 f.clock.blocked=true;await f.ingest('blocked');assert.equal(f.storage.state.jobs.length,0);assert.ok(f.storage.state.outbox.every(x=>x.msgSeq===1));
});
test('QQ permanently rejected image creates no extra unbudgeted group message',async()=>{
 const f=await fixture();await f.ingest();const {job,auth}=await f.start();const receipt=await f.store.image(job.id,{...auth,index:0,buffer:PNG,mimeType:'image/png'});
 await f.store.result(job.id,{...auth,text:'',images:[receipt.imageId]});const image=await f.store.nextReply();await f.store.imageReplyRejected(image.id);
 assert.equal(await f.store.nextReply(),null);assert.equal(f.storage.state.outbox.length,1);assert.equal((await f.store.status()).jobs[0].state,'failed');
});
test('QQ restart fails an active lease and deduplicates replay without resubmitting',async()=>{
 const f=await fixture();await f.ingest();await f.start();const restored=await BridgeStore.open(f.options);await restored.recover();
 assert.equal((await restored.poll(caller)).job,null);assert.equal((await f.ingest()).duplicate,true);assert.equal(f.storage.state.jobs.length,1);
});
test('QQ two contexts cannot both lease the same event',async()=>{
 const f=await fixture();await f.ingest();const second=await BridgeStore.open(f.options);const results=await Promise.all([f.store.poll(caller),second.poll(caller)]);assert.equal(results.filter(x=>x.job).length,1);
});

test('QQ cancellation keeps history and deduplication, removes private images and lets the next queued task proceed without group replies', async () => {
  const f = await fixture();
  const { jobId } = await f.ingest('cancel-images', { text: 'private cancelled prompt', images: [0, 1].map(index => ({ imageKey: `https://multimedia.nt.qq.com.cn/download?id=${index}` })) });
  const firstImage = await f.store.nextInputImage();
  await f.store.inputImageDownloaded(firstImage, { buffer: PNG, mimeType: 'image/png' });
  const lateImage = await f.store.nextInputImage();
  assert.equal(f.storage.images.size, 1);
  const next = await f.ingest('next-after-cancel');
  assert.deepEqual(await f.store.cancel(jobId), { ok: true });
  const revision = f.storage.state.revision;
  assert.deepEqual(await f.store.cancel(jobId), { ok: true });
  assert.equal(f.storage.state.revision, revision);
  const cancelled = f.storage.state.jobs.find(job => job.id === jobId);
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.finishedAt, f.clock.now);
  for (const field of ['prompt', 'imageRefs', 'inputImages', 'uploads']) assert.equal(cancelled[field], undefined);
  assert.equal(f.storage.images.size, 0);
  assert.equal(await f.store.inputImageDownloaded(lateImage, { buffer: PNG, mimeType: 'image/png' }), false);
  await f.store.inputImageFailed(lateImage, { retryable: false });
  assert.equal(await f.store.nextInputImage(), null);
  assert.equal(await f.store.nextReply(), null); assert.equal(f.storage.state.outbox.length, 0);
  assert.equal(f.storage.state.receipts['cancel-images'].nextSeq, 1);
  const status = await f.store.status();
  assert.equal(status.activeJobCount, 1); assert.equal(status.jobs.find(job => job.id === jobId).state, 'cancelled');
  assert.equal((await f.ingest('cancel-images')).duplicate, true);
  assert.equal((await f.store.poll(caller)).job.id, next.jobId);
  const reopened = await BridgeStore.open(f.options); await reopened.recover();
  assert.equal((await reopened.status()).jobs.find(job => job.id === jobId).state, 'cancelled');
  await reopened.unbind(caller);
});

test('QQ cancellation rejects unknown and already started or ended jobs without changing them', async () => {
  for (const state of ['leased', 'running', 'completed', 'failed']) {
    const f = await fixture(); await f.ingest();
    const { job } = await f.store.poll(caller); const auth = { ...caller, leaseToken: job.leaseToken };
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

test('QQ status keeps an old queued task visible and cancellable alongside the newest 100 ended jobs', async () => {
  const f = await fixture(); const queued = await f.ingest('old-queued'); const history = [];
  for (let index = 0; index < 105; index++) {
    f.clock.now += 1;
    const { jobId } = await f.ingest(`newer-ended-${index}`); history.push(jobId); await f.store.cancel(jobId);
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

test('QQ cancellation commits the terminal state and image deletion atomically', async () => {
  const f = await fixture(); const { jobId } = await f.ingest('atomic-cancel', { images: [{ imageKey: 'https://multimedia.nt.qq.com.cn/download?id=atomic' }] });
  await f.store.inputImageDownloaded(await f.store.nextInputImage(), { buffer: PNG, mimeType: 'image/png' });
  f.storage.fail = true;
  await assert.rejects(f.store.cancel(jobId), /transaction failure/);
  assert.equal(f.storage.state.jobs[0].state, 'queued'); assert.equal(f.storage.state.jobs[0].prompt, 'hello'); assert.equal(f.storage.images.size, 1);
  f.storage.fail = false; await f.store.cancel(jobId);
  assert.equal(f.storage.state.jobs[0].state, 'cancelled'); assert.equal(f.storage.images.size, 0);
});

test('QQ cancellation and polling resolve cross-context races without cancelling an issued lease or leasing a cancelled task', async () => {
  for (const winner of ['cancel', 'poll']) {
    const f = await fixture(); const { jobId } = await f.ingest(); const second = await BridgeStore.open(f.options);
    let entered; let release; let held = false;
    const waiting = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
    f.storage.beforeCommit = () => { if (!held) { held = true; entered(); return gate; } };
    const pending = winner === 'cancel' ? f.store.poll(caller) : f.store.cancel(jobId);
    await waiting;
    if (winner === 'cancel') {
      await second.cancel(jobId); release();
      assert.equal((await pending).job, null);
      assert.equal(f.storage.state.jobs[0].state, 'cancelled');
    } else {
      assert.equal((await second.poll(caller)).job.id, jobId); release();
      await assert.rejects(pending, error => error.status === 409);
      assert.equal(f.storage.state.jobs[0].state, 'leased');
    }
  }
});

test('QQ an image download already committing cannot restore a concurrently cancelled task', async () => {
  const f = await fixture(); const { jobId } = await f.ingest('cancel-download', { images: [{ imageKey: 'https://multimedia.nt.qq.com.cn/download?id=late' }] });
  const item = await f.store.nextInputImage(); const second = await BridgeStore.open(f.options);
  let entered; let release; let held = false;
  const waiting = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  f.storage.beforeCommit = () => { if (!held) { held = true; entered(); return gate; } };
  const pending = f.store.inputImageDownloaded(item, { buffer: PNG, mimeType: 'image/png' });
  await waiting; await second.cancel(jobId); release();
  assert.equal(await pending, false); assert.equal(f.storage.images.size, 0);
  assert.equal((await f.store.poll(caller)).job, null); assert.equal(await f.store.nextReply(), null);
  assert.deepEqual((await f.store.status()).queuedChatIds, []);
});
test('QQ group binding rejects prototype keys and enforces distinct conversations',async()=>{
 const f=await fixture();await assert.rejects(f.store.bind({...caller,chatId:'__proto__'}),/group_openid/);
 await assert.rejects(f.store.bind({...caller,chatId:'ANOTHER_GROUP'}),/独立对话/);
});
test('QQ old events do not generate replies after the five minute window',async()=>{
 const f=await fixture();assert.equal((await f.ingest('stale',{createdAt:f.clock.now-300_000})).stale,true);assert.equal(await f.store.nextReply(),null);
});
export {MemoryStorage};

test('QQ group IDs matching inherited object names are handled as ordinary owned keys',async()=>{
 const f=await fixture();for(const id of ['toString','valueOf','hasOwnProperty']) {
   await f.store.bind({...caller,chatId:id,tabId:90+id.length,conversationUrl:'https://chatgpt.com/c/test-'+id});
   assert.ok(Object.hasOwn(f.storage.state.groups,id));assert.equal(Object.prototype[id].binding,undefined);
 }
});
test('QQ expired file_info is reuploaded with the original persisted reply sequence',async()=>{
 const f=await fixture();await f.ingest();const {job,auth}=await f.start();const receipt=await f.store.image(job.id,{...auth,index:0,buffer:PNG,mimeType:'image/png'});
 await f.store.result(job.id,{...auth,text:'',images:[receipt.imageId]});const image=await f.store.nextReply();await f.store.imageUploaded(image.id,'short-lived',2);
 assert.equal((await f.store.nextReply()).imageKey,'short-lived');f.clock.now+=2100;const retry=await f.store.nextReply();assert.equal(retry.imageKey,undefined);assert.equal(retry.msgSeq,1);assert.equal((await f.store.imageBuffer(retry)).byteLength,PNG.byteLength);
});

test('QQ delivery timings separate page confirmation, queue wait and transport without retaining arbitrary page fields',async()=>{
 const f=await fixture();await f.ingest();const {job,auth}=await f.start();
 await f.store.result(job.id,{...auth,text:'answer',timing:{confirmationMs:800,imagePreparationMs:0,background:true,secret:'must-not-persist'}});
 f.clock.now+=200;const item=await f.store.nextReply();await f.store.deliveryStarted(item.id);f.clock.now+=450;await f.store.replySent(item.id);
 assert.deepEqual((await f.store.status()).jobs[0].timing,{confirmationMs:800,imagePreparationMs:0,background:true,handoffMs:0,queueMs:200,deliveryMs:450,firstReplyMs:650});
 assert.doesNotMatch(JSON.stringify(f.storage.state),/must-not-persist/);
});
test('QQ invalid diagnostic fields do not change answer delivery or deadlines',async()=>{
 const f=await fixture();await f.ingest();const {job,auth}=await f.start();await f.store.result(job.id,{...auth,text:'answer',timing:{confirmationMs:-1,imagePreparationMs:Infinity,background:'yes'}});
 const item=await f.store.nextReply();assert.equal(item.msgSeq,1);assert.equal(f.storage.state.jobs[0].timing,undefined);
 await f.store.replySent(item.id);assert.equal((await f.store.status()).jobs[0].state,'completed');
});

test('QQ completed legacy jobs do not invent growing queue delays from absent historical timings',async()=>{
 const f=await fixture();await f.ingest();const {job,auth}=await f.start();await f.store.result(job.id,{...auth,text:'legacy answer'});
 const item=await f.store.nextReply();await f.store.replySent(item.id);
 const old=f.storage.state.jobs[0];delete old.timing;delete old.answerDelivery.startedAt;delete old.answerDelivery.firstSentAt;delete old.answerDelivery.finishedAt;
 f.clock.now+=86400000;assert.deepEqual((await f.store.status()).jobs[0].timing,{handoffMs:0});
 f.clock.now+=86400000;assert.deepEqual((await f.store.status()).jobs[0].timing,{handoffMs:0});
});
