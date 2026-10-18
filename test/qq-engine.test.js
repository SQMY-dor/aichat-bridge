import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeStore} from '../extension/qq-store.js';
import {ExtensionEngine} from '../extension/qq-runtime.js';
import {createWordFilter} from '../extension/moderation.js';
const caller={chatId:'GROUP_ENGINE',browserId:'engine-test',tabId:3,conversationUrl:'https://chatgpt.com/c/engine-test-conversation',capabilities:['image-input-v1']};
const PNG=Uint8Array.from([137,80,78,71,13,10,26,10,1]);
async function setup(overrides={}) {
 let data=null;const images=new Map();const clock={now:Date.now()};let config={appId:'123456789',appSecret:'private-fixture-secret'};let filter=createWordFilter(['测试禁词']);
 const store=await BridgeStore.open({now:()=>clock.now,moderate:p=>filter(p),storage:{
  async readState(){return structuredClone(data);},async readImage(k){return images.get(k);},async listImageKeys(){return [...images.keys()];},
  async commit({expectedRevision,state,putImages=[],deleteImages=[]}){assert.equal(data?.revision??0,expectedRevision);data={...structuredClone(state),revision:expectedRevision+1};for(const x of putImages)images.set(x.key,x.blob);for(const k of deleteImages)images.delete(k);return data.revision;}
 }});
 const calls=[];const callbacks=[];
 const engine=new ExtensionEngine({store,readConfig:async()=>config,writeConfig:async next=>{config=next;},defaultWords:['测试禁词'],setWords:w=>{filter=createWordFilter(w);},adapterFactory:opts=>{
  callbacks.push(opts);return {async start(){opts.onState({state:'connected'});},async stop(){},async reply(x){calls.push(['reply',x]);},async replyPost(x){calls.push(['post',x]);},async replyImage(x){calls.push(['image',x]);},async downloadImage(x){calls.push(['download',x]);return {buffer:PNG,mimeType:'image/png'};},async uploadImage(x){calls.push(['upload',x]);return {imageKey:'file-info'};},...overrides};
 }});
 await engine.init();await engine.connecting;await store.bind(caller);
 const receive=(id,text='hello',extra={})=>callbacks.at(-1).onMessage({messageId:id,chatId:caller.chatId,createdAt:clock.now,text,...extra});
 const start=async()=>{const {job}=await store.poll(caller);assert.ok(job);const auth={...caller,leaseToken:job.leaseToken};await store.started(job.id,auth);return {job,auth};};
 return {engine,store,clock,calls,callbacks,receive,start,config:()=>config,data:()=>data};
}
test('QQ integration filters first, submits one job and acknowledges final markdown only',async()=>{
 const f=await setup();await f.receive('blocked','测试 禁词');await f.engine.tick();assert.equal(f.calls[0][0],'reply');assert.equal(f.calls[0][1].msgSeq,1);
 await f.receive('normal');await f.engine.tick();assert.equal(f.calls.length,1);const {job,auth}=await f.start();
 await f.engine.request(`/v1/jobs/${job.id}/result`,{...auth,text:'**答案**'});await f.engine.tick();
 assert.equal(f.calls.at(-1)[0],'post');assert.deepEqual(f.calls.at(-1)[1],{chatId:caller.chatId,messageId:'normal',post:'**答案**',msgSeq:1,expiresAt:f.clock.now+295000});
 assert.equal((await f.engine.status()).jobs[0].state,'completed');assert.doesNotMatch(JSON.stringify(await f.engine.status()),/private-fixture-secret|hello|答案/);
});
test('QQ integration downloads attachment then uploads and sends generated image with its assigned slot',async()=>{
 const f=await setup();const url='https://multimedia.nt.qq.com.cn/download?id=fixture';await f.receive('image-request','image',{images:[{imageKey:url}]});await f.engine.tick();assert.deepEqual(f.calls[0],['download',{imageKey:url}]);
 const {job,auth}=await f.start();const img=await f.store.image(job.id,{...auth,index:0,buffer:PNG,mimeType:'image/png'});await f.store.result(job.id,{...auth,text:'',images:[img.imageId]});
 await f.engine.tick();assert.equal(f.calls.at(-1)[0],'upload');assert.equal(f.calls.at(-1)[1].chatId,caller.chatId);assert.equal((await f.engine.status()).jobs[0].state,'delivering');
 await f.engine.tick();assert.deepEqual(f.calls.at(-1),['image',{chatId:caller.chatId,messageId:'image-request',imageKey:'file-info',msgSeq:1,expiresAt:f.clock.now+295000}]);assert.equal((await f.engine.status()).jobs[0].state,'completed');
});
test('QQ transient send retries freeze msg_seq instead of consuming a new reply slot',async()=>{
 let attempts=0;const payloads=[];const f=await setup({async replyPost(x){payloads.push(x);if(attempts++===0)throw new Error('offline');}});await f.receive('retry');const {job,auth}=await f.start();await f.store.result(job.id,{...auth,text:'retry once'});
 await f.engine.tick();f.clock.now+=5000;await f.engine.tick();assert.equal(payloads.length,2);assert.deepEqual(payloads[0],payloads[1]);assert.equal(payloads[1].msgSeq,1);
});
test('QQ permanent rejection is visible and never creates a sixth notification',async()=>{
 const f=await setup({async replyPost(){throw Object.assign(new Error('permission'),{retryable:false});}});await f.receive('reject');const {job,auth}=await f.start();await f.store.result(job.id,{...auth,text:'answer'});await f.engine.tick();
 assert.equal((await f.engine.status()).jobs[0].state,'failed');assert.equal(await f.store.nextReply(),null);assert.equal(f.data().outbox.length,1);
});
test('QQ engine ticks cannot overlap and duplicate outbound delivery',async()=>{
 let release;let count=0;const f=await setup({async reply(){count++;await new Promise(r=>{release=r;});}});await f.receive('blocked','测试禁词');const tick=f.engine.tick();
 while(!release)await new Promise(r=>setImmediate(r));await f.engine.tick();assert.equal(count,1);release();await tick;
});
test('QQ credentials reject legacy app IDs and prevent app changes with existing group ownership',async()=>{
 const f=await setup();await assert.rejects(f.engine.configure({appId:'cli_legacy',appSecret:'x'}),/数字标识/);
 await assert.rejects(f.engine.configure({appId:'987654321',appSecret:'other'}),/原应用/);await f.engine.connecting;assert.equal(f.config().appId,'123456789');
 await f.engine.configure({appId:'123456789',appSecret:''});await f.engine.connecting;assert.equal(f.config().appSecret,'private-fixture-secret');
});
test('QQ reconfiguration revokes old adapter events and moderation hot updates queued work',async()=>{
 const f=await setup();const old=f.callbacks[0];await f.engine.configure({appId:'123456789',appSecret:'rotated'});await f.engine.connecting;
 await old.onMessage({messageId:'old-event',chatId:caller.chatId,text:'hello',createdAt:f.clock.now});assert.equal(f.data().jobs.length,0);
 await f.receive('new-event','新禁词');await f.engine.saveWords({words:['新禁词']});assert.equal((await f.store.poll(caller)).job,null);assert.equal((await f.engine.status()).jobs[0].state,'failed');
});
test('QQ rendering errors are terminal client errors, never endless 500 result retries',async()=>{
 const f=await setup();await f.receive('long-code');const {job,auth}=await f.start();await assert.rejects(f.engine.request(`/v1/jobs/${job.id}/result`,{...auth,text:'```js\n'+ 'x'.repeat(5000)+'\n```'}),e=>e.status===400);assert.equal(await f.store.nextReply(),null);
});

test('completed QQ output takes priority over an unrelated input-image download',async()=>{
 const f=await setup();await f.receive('answer-first');const {job,auth}=await f.start();
 await f.store.result(job.id,{...auth,text:'ready'});
 await f.receive('next-with-image','question',{images:[{imageKey:'https://multimedia.nt.qq.com.cn/download?id=later'}]});
 await f.engine.tick();assert.equal(f.calls[0][0],'post');assert.equal(f.calls[0][1].messageId,'answer-first');
 await f.engine.tick();assert.equal(f.calls[1][0],'download');
});
test('QQ receipt and final-result commit notify the pump without awaiting network delivery',async()=>{
 const f=await setup();let wakes=0;f.engine.onWork=()=>{wakes++;};await f.receive('wake');assert.equal(wakes,1);
 const {job,auth}=await f.start();await f.engine.request(`/v1/jobs/${job.id}/result`,{...auth,text:'wake answer'});assert.equal(wakes,2);assert.equal(f.calls.length,0);
 await f.engine.tick();assert.equal(f.calls[0][0],'post');
});
