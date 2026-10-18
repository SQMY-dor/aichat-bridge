import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkPump} from '../extension/work-pump.js';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function harness(step) {
 let now=0,id=0;const timers=new Map();const times=[];const errors=[];
 const pump=createWorkPump({step:async()=>{times.push(now);return step();},onError:e=>errors.push(e),now:()=>now,setTimeout:(fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id)});
 async function advance(ms) {const end=now+ms;for(let limit=0;limit<1000;limit++) {await flush();const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end){now=end;await flush();return;}now=next[1].at;timers.delete(next[0]);next[1].fn();}throw Error('timer runaway');}
 return {pump,advance,times,errors,timers};
}
test('nine ready operations drain in two seconds, rather than one step per second',async()=>{
 let work=9;const h=harness(()=>work-->0);h.pump.start();await h.advance(2000);
 assert.equal(work,0);assert.deepEqual(h.times,[0,250,500,750,1000,1250,1500,1750,2000]);h.pump.stop();
});
test('new work wakes an idle timer immediately, but wakes cannot bypass successful-step pacing',async()=>{
 let hasWork=false;const h=harness(()=>hasWork);h.pump.start();await h.advance(450);assert.deepEqual(h.times,[0]);
 hasWork=true;h.pump.wake();await h.advance(0);assert.deepEqual(h.times,[0,450]);
 await h.advance(20);h.pump.wake();h.pump.wake();await h.advance(229);assert.equal(h.times.length,2);await h.advance(1);assert.equal(h.times[2],700);h.pump.stop();
});
test('wake during an asynchronous step is retained without overlapping it',async()=>{
 let resolve;let active=0;let calls=0;const h=harness(async()=>{assert.equal(active++,0);calls++;if(calls===1)await new Promise(r=>{resolve=r;});active--;return false;});
 h.pump.start();await h.advance(0);h.pump.wake();await h.advance(500);assert.equal(calls,1);
 resolve();await h.advance(0);assert.equal(calls,2);assert.deepEqual(h.times,[0,500]);h.pump.stop();
});
test('errors fall back to a bounded idle retry and stop removes pending work',async()=>{
 const h=harness(()=>{throw Error('offline');});h.pump.start();await h.advance(999);assert.equal(h.errors.length,1);await h.advance(1);assert.equal(h.errors.length,2);
 h.pump.stop();h.pump.wake();await h.advance(5000);assert.equal(h.errors.length,2);assert.equal(h.timers.size,0);
});
test('stopping an in-flight step prevents its completion from scheduling more work',async()=>{
 let resolve;const h=harness(()=>new Promise(r=>{resolve=r;}));h.pump.start();await h.advance(0);h.pump.stop();resolve(true);await h.advance(2000);assert.equal(h.times.length,1);assert.equal(h.timers.size,0);
});
