import test from 'node:test';
import assert from 'node:assert/strict';
import * as dom from '../extension/qwen-dom.js';
import { assistantForUrl, conversationUrl } from '../extension/shared.js';
import {page,user,answer,monaco,attachment,loaded,fileHarness,payload,png,url} from './helpers/qwen-fixture.js';
function state(doc,body) { const baseline=dom.snapshot(doc);user(doc);const submitted=dom.findSubmittedUser(doc,baseline,'Question');if(body!==undefined)answer(doc,body);return {baseline,submitted}; }
const candidate=(doc,s)=>dom.finalCandidate(doc,s.baseline,s.submitted);
function upload(doc,name='bridge-1.png',source) { const input=dom.composer(doc);dom.attachInputImage(doc,input,payload,name);return attachment(doc,name,source); }

test('Qwen reads completed background answers without page focus or painted action controls', () => {
  const { window: w } = page(), d = w.document;
  Object.defineProperties(d, { hidden: { value: true, configurable: true }, visibilityState: { value: 'hidden', configurable: true } });
  d.hasFocus = () => false;
  const s = state(d, '<div class="qwen-markdown-paragraph">Background answer</div>' + monaco());
  const row = s.submitted.closest('.qwen-chat-message-select-turn');
  row.style.contentVisibility = 'auto';
  d.querySelector('.response-message-footer').style.opacity = '0';
  Object.defineProperty(s.submitted.querySelector('.chunked-text-renderer-root'), 'innerText', { value: '', configurable: true });
  Object.defineProperty(d.querySelector('.qwen-markdown'), 'innerText', { value: '', configurable: true });
  assert.equal(candidate(d, s)?.text, 'Background answer\n\n```python\nprint(1 + 1)\n```');
  d.querySelector('.send-button use').setAttribute('xlink:href', '#qwpcicon-stop');
  assert.equal(candidate(d, s), null, 'background state never replaces the explicit completion checks');
});

test('Qwen prompt ownership reads structured DOM despite a temporarily empty rendered innerText', () => {
  const { window: w } = page(), d = w.document, baseline = dom.snapshot(d);
  const row = user(d, ''), body = row.querySelector('.chunked-text-renderer-root');
  body.innerHTML = '<p>first line</p><p>second<br>third</p>';
  Object.defineProperty(body, 'innerText', { value: '', configurable: true });
  const expected = 'first line\nsecond\nthird';
  assert.equal(dom.findSubmittedUser(d, baseline, expected), row);
  answer(d, '<p>Answer</p>');
  assert.equal(dom.finalCandidate(d, baseline, row).text, 'Answer');
  body.insertAdjacentHTML('beforeend', '<span hidden>different</span>');
  assert.throws(() => dom.finalCandidate(d, baseline, row), /内容被替换/);
});
test('Qwen confirmation timeout diagnostics report only state and lengths', () => {
  const { window: w } = page(), d = w.document, baseline = dom.snapshot(d);
  assert.match(dom.submissionWaitReason(d, baseline, 'private prompt'), /尚未出现/);
  const row = user(d, ''), body = row.querySelector('.chunked-text-renderer-root');
  body.remove(); assert.match(dom.submissionWaitReason(d, baseline, 'private prompt'), /尚未挂载/);
  row.querySelector('.chat-user-message').append(body); body.textContent = 'private';
  const reason = dom.submissionWaitReason(d, baseline, 'private prompt');
  assert.match(reason, /7\/14 字符/); assert.doesNotMatch(reason, /private|user-1/);
});

test('Qwen waits for prompt renderer mount and chunks without claiming partial text', () => {
  const { window: w } = page(), d = w.document, baseline = dom.snapshot(d);
  const row = user(d, ''), body = row.querySelector('.chunked-text-renderer-root');
  body.remove();
  assert.equal(dom.findSubmittedUser(d, baseline, '123'), null);
  row.querySelector('.chat-user-message').append(body);
  for (const partial of ['', '1', '12']) {
    body.querySelector('p').textContent = partial;
    assert.equal(dom.findSubmittedUser(d, baseline, '123'), null);
    assert.equal(baseline.submittedText, undefined);
  }
  body.querySelector('p').textContent = '123';
  assert.equal(dom.findSubmittedUser(d, baseline, '123'), row);
  answer(d, '<p>Answer</p>');
  assert.equal(dom.finalCandidate(d, baseline, row).text, 'Answer');
  body.querySelector('p').textContent = '12';
  assert.throws(() => dom.finalCandidate(d, baseline, row), /内容被替换/);
});
test('Qwen still rejects a different prompt, duplicate renderer and additional users while waiting', () => {
  for (const mutation of ['different', 'duplicate', 'extra-user']) {
    const { window: w } = page(), d = w.document, baseline = dom.snapshot(d);
    const row = user(d, ''), body = row.querySelector('.chunked-text-renderer-root');
    assert.equal(dom.findSubmittedUser(d, baseline, '123'), null);
    if (mutation === 'different') body.querySelector('p').textContent = '124';
    if (mutation === 'duplicate') body.after(body.cloneNode(true));
    if (mutation === 'extra-user') user(d, '123', 'other');
    assert.throws(() => dom.findSubmittedUser(d, baseline, '123'), dom.PageSafetyError);
  }
});
test('Qwen inherited disabled controls cannot authorize input, send, upload or completion', () => {
  const { window: w } = page(), d = w.document, s = state(d, '<p>Answer</p>');
  const input = dom.composer(d), button = dom.sendButton(d, input);
  const disabled = d.createElement('fieldset'); disabled.disabled = true;
  button.before(disabled); disabled.append(button);
  assert.equal(button.disabled, false);
  assert.equal(dom.sendButton(d, input), null);
  const footer = d.querySelector('.response-message-footer'), disabledFooter = disabled.cloneNode(false);
  footer.before(disabledFooter); disabledFooter.append(footer);
  assert.equal(candidate(d, s), null);
  disabledFooter.disabled = false;
  const disabledInput = disabled.cloneNode(false); input.before(disabledInput); disabledInput.append(input);
  assert.throws(() => dom.composer(d), /不可用/);
  disabledInput.disabled = false;
  const field = d.querySelector('#filesUpload'), disabledFiles = disabled.cloneNode(false);
  field.before(disabledFiles); disabledFiles.append(field); fileHarness(w);
  assert.throws(() => dom.attachInputImage(d, input, payload, 'test.png'), /上传入口不可用/);
});

for (const iconType of ['xlink', 'href', 'namespace-prefix']) {
  test(`Qwen completed answer and disabled idle send agree for ${iconType} SVG`, () => {
    const { window: w } = page(), d = w.document;
    const s = state(d, '<p>Completed answer</p>');
    const button = d.querySelector('.send-button'), icon = button.querySelector('use');
    icon.removeAttribute('xlink:href');
    if (iconType === 'href') icon.setAttribute('href', '#qwpcicon-sendChat');
    else icon.setAttributeNS('http://www.w3.org/1999/xlink', `${iconType === 'xlink' ? 'xlink' : 'link'}:href`, '#qwpcicon-sendChat');
    button.disabled = true;
    assert.equal(dom.generating(d), false);
    assert.equal(dom.assertReady(d), dom.composer(d));
    assert.equal(candidate(d, s).text, 'Completed answer');
    assert.equal(dom.sendButton(d, dom.composer(d)), null);
    button.disabled = false;
    assert.equal(dom.sendButton(d, dom.composer(d)), button);
  });
}
for (const kind of ['stop-icon', 'unknown-icon', 'missing-icon', 'stop-label']) {
  test(`Qwen keeps completed-looking answers blocked with ${kind}`, () => {
    const { window: w } = page(), d = w.document, s = state(d, '<p>Still streaming</p>');
    const button = d.querySelector('.send-button'), icon = button.querySelector('use');
    if (kind === 'missing-icon') icon.remove();
    else if (kind === 'stop-label') button.setAttribute('aria-label', '停止');
    else icon.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', kind === 'stop-icon' ? '#qwpcicon-stop' : '#unknown');
    assert.equal(dom.generating(d), true);
    assert.equal(candidate(d, s), null);
    assert.throws(() => dom.assertReady(d), /正在生成/);
  });
}

test('Qwen binds only international private conversations',()=>{
  assert.equal(conversationUrl(url+'?x=1#hash','qwen'),url);assert.equal(assistantForUrl(url),'qwen');
  for(const bad of ['https://qwen.ai/c/12345678','https://chat.qwen.ai.evil.test/c/12345678','http://chat.qwen.ai/c/12345678','https://user:pass@chat.qwen.ai/c/12345678','https://chat.qwen.ai/','https://chat.qwen.ai/s/12345678','https://chat.qwen.ai/c/short']) assert.equal(conversationUrl(bad,'qwen'),null,bad);
});
test('Qwen scoped textarea and send icon support native controlled input',()=>{const {window:w}=page();const d=w.document,i=dom.assertReady(d);let edits=0;i.addEventListener('input',()=>edits++);dom.insertPrompt(d,i,'hello\nworld');assert.equal(i.value,'hello\nworld');assert.equal(edits,1);assert.equal(dom.generating(d),false);assert.ok(dom.sendButton(d,i));assert.throws(()=>dom.assertReady(d),/草稿/);});
for(const mutation of ['duplicate','hidden-duplicate','readonly','disabled','inert','dialog','attachment']) test('Qwen refuses unsafe composer: '+mutation,()=>{const {window:w}=page();const d=w.document,i=dom.composer(d);if(mutation.includes('duplicate')){const x=i.cloneNode(true);x.hidden=mutation==='hidden-duplicate';i.after(x);}if(mutation==='readonly')i.readOnly=true;if(mutation==='disabled')i.disabled=true;if(mutation==='inert')i.parentElement.setAttribute('inert','');if(mutation==='dialog')d.body.insertAdjacentHTML('beforeend','<div role="dialog"></div>');if(mutation==='attachment')attachment(d,'human.png');assert.throws(()=>dom.assertReady(d),dom.PageSafetyError);});
test('Qwen stop icon, disabled sends and incomplete previous answers wait',()=>{const {window:w}=page();const d=w.document,i=dom.composer(d),b=dom.sendButton(d,i);b.disabled=true;assert.equal(dom.sendButton(d,i),null);b.disabled=false;b.querySelector('use').setAttribute('xlink:href','#qwpcicon-stop');assert.equal(dom.generating(d),true);assert.equal(dom.sendButton(d,i),null);b.querySelector('use').setAttribute('xlink:href','#qwpcicon-sendChat');user(d);assert.throws(()=>dom.assertReady(d),/尚未明确完成/);answer(d);assert.equal(dom.assertReady(d),i);});
test('Qwen keeps prose, code indentation and blank lines; drops thoughts, line numbers and code controls',()=>{const {window:w}=page();const d=w.document,s=state(d,'<div class="qwen-markdown-paragraph">你好</div>'+monaco(['if True:','    print(1 + 1)','','print(2)']));const r=candidate(d,s);assert.equal(r.text,'你好\n\n```python\nif True:\n    print(1 + 1)\n\nprint(2)\n```');});
for(const mutation of ['missing-footer','wrong-message','wrong-chat','code-copy-only','busy','stop']) test('Qwen only completes with this answer own matching footer: '+mutation,()=>{const {window:w}=page();const d=w.document,s=state(d,monaco());const footer=d.querySelector('.response-message-footer');if(mutation==='missing-footer'||mutation==='code-copy-only')footer.remove();if(mutation==='wrong-message')footer.firstElementChild.dataset.msgId='other';if(mutation==='wrong-chat')footer.firstElementChild.dataset.chatId='other';if(mutation==='busy')d.querySelector('.phase-answer').setAttribute('aria-busy','true');if(mutation==='stop')d.querySelector('.send-button use').setAttribute('xlink:href','#stop');assert.equal(candidate(d,s),null);});
for(const mutation of ['extra-user','hidden-user','edited','wrong-conversation','duplicate-id']) test('Qwen protects response ownership: '+mutation,()=>{const {window:w}=page();const d=w.document,s=state(d,'<p>Answer</p>');if(mutation.includes('user')){const u=user(d,'Other','user-2');if(mutation==='hidden-user')u.hidden=true;}if(mutation==='edited')s.submitted.querySelector('p').textContent='Changed';if(mutation==='wrong-conversation')w.history.replaceState({},'', '/c/other-conversation');if(mutation==='duplicate-id')s.submitted.after(s.submitted.cloneNode(true));assert.throws(()=>candidate(d,s),dom.PageSafetyError);});
test('Qwen repeated prompts use last baseline anchor and error cards stop',()=>{const {window:w}=page();const d=w.document;user(d,'Question','old-user');answer(d,'<p>Old</p>','old-answer');const s=state(d,'<p>New</p>');assert.equal(candidate(d,s).text,'New');d.querySelector('#chat-response-message-answer-1').insertAdjacentHTML('beforeend','<div role="alert">Failed</div>');assert.throws(()=>candidate(d,s),/网页回复失败/);});
for(const mutation of ['folded','gap','virtual','line-count','overflow','scroll'])test('Qwen never sends incomplete Monaco code: '+mutation,()=>{const {window:w}=page();const d=w.document,s=state(d,monaco(['one','two']));if(mutation==='folded')d.querySelector('[aria-expanded]').setAttribute('aria-expanded','false');if(mutation==='gap')d.querySelector('.view-line').style.top='20px';if(mutation==='virtual')d.querySelector('.view-lines').style.height='200px';if(mutation==='line-count')d.querySelector('.line-numbers').remove();if(mutation==='overflow')d.querySelector('.view-line').innerHTML='<span class="mtkoverflow">truncated</span>';if(mutation==='scroll'){d.querySelector('.scrollbar').classList.remove('invisible');d.querySelector('.slider').style.height='10px';}assert.throws(()=>candidate(d,s),/代码未完整展开/);});
test('Qwen uploads four native files sequentially, accepts cleared FileList and hover-only remove controls',()=>{const {window:w}=page();const d=w.document,i=dom.composer(d);let count=0;const h=fileHarness(w,()=>{count++;});const names=[];for(let n=1;n<=4;n++){const name=`bridge-${n}.png`;upload(d,name);h.files=[];names.push(name);assert.equal(dom.inputAttachmentState(i,names).ready,true);}assert.equal(count,4);dom.releaseInputImages(i);assert.equal(dom.inputAttachmentState(i,names).ready,false);});
for(const mutation of ['blob','not-loaded','wrong-name','wrong-path','extra','progress','foreign-file','replacement','removed','alert'])test('Qwen validates native attachment completion: '+mutation,()=>{const {window:w}=page();const d=w.document,i=dom.composer(d),h=fileHarness(w),c=upload(d),img=c.querySelector('img');if(mutation==='blob')img.src='blob:https://chat.qwen.ai/preview';if(mutation==='not-loaded')loaded(img,{complete:false});if(mutation==='wrong-name')img.alt='human.png';if(mutation==='wrong-path')img.src='https://qwen-webui-prod.oss-accelerate.aliyuncs.com/upload_other.png';if(mutation==='extra')attachment(d,'human.png');if(mutation==='progress')c.insertAdjacentHTML('beforeend','<div role="progressbar"></div>');if(mutation==='foreign-file')h.files=[new w.File([png],'human.png')];if(mutation==='alert')c.insertAdjacentHTML('beforeend','<div role="alert">Upload failed</div>');if(mutation==='replacement'||mutation==='removed'){assert.equal(dom.inputAttachmentState(i,['bridge-1.png']).ready,true);if(mutation==='replacement')c.replaceWith(c.cloneNode(true));else c.remove();}if(['foreign-file','replacement','alert'].includes(mutation))assert.throws(()=>dom.inputAttachmentState(i,['bridge-1.png']),dom.PageSafetyError);else assert.equal(dom.inputAttachmentState(i,['bridge-1.png']).ready,false);});
test('Qwen transfers upload ownership only to an empty remounted textarea in the same composer',()=>{const {window:w}=page();const d=w.document;fileHarness(w);let i=dom.composer(d);upload(d);const next=i.cloneNode(true);i.replaceWith(next);assert.equal(dom.refreshComposer(d,i),next);assert.equal(dom.inputAttachmentState(next,['bridge-1.png']).ready,true);const later=next.cloneNode(true);later.value='human draft';next.replaceWith(later);assert.throws(()=>dom.refreshComposer(d,next),/草稿/);});
test('Qwen does not recover arbitrary replaced containers or text-only drafts',()=>{for(const image of [false,true]){const {window:w}=page();const d=w.document;fileHarness(w);const i=dom.composer(d);if(image)upload(d);const scope=dom.composerScope(i);scope.replaceWith(scope.cloneNode(true));assert.equal(dom.refreshComposer(d,i),i);}});
test('Qwen output images are scoped, deduplicated and external sources skipped',()=>{const {window:w}=page();const d=w.document,s=state(d,'<p>Images</p><img src="https://qwen-webui-prod.oss-accelerate.aliyuncs.com/answer.png"><img src="blob:https://chat.qwen.ai/answer"><img src="https://example.com/external.png">');d.querySelectorAll('.phase-answer img').forEach(x=>loaded(x));const r=candidate(d,s);assert.equal(r.images.length,2);assert.equal(r.skippedImages,1);for(const src of ['http://chat.qwen.ai/i.png','https://chat.qwen.ai.evil.test/a','blob:https://evil.test/a','https://a:b@chat.qwen.ai/i'])assert.throws(()=>dom.answerImageSource(src));});
test('Qwen bounded image reader uses no credentials or redirects and validates formats',async()=>{let options;const r=await dom.readAnswerImage({src:'https://qwen-webui-prod.oss-accelerate.aliyuncs.com/answer.png'},{fetchImpl:async(_src,o)=>{options=o;return new Response(png,{headers:{'content-type':'image/png'}});}});assert.equal(r.base64,payload.base64);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');await assert.rejects(dom.readAnswerImage({src:'https://chat.qwen.ai/image'},{fetchImpl:async()=>new Response('html',{headers:{'content-type':'text/html'}})}),/格式不支持/);await assert.rejects(dom.readAnswerImage({src:'https://chat.qwen.ai/image'},{fetchImpl:()=>new Promise(()=>{}),timeoutMs:5}),/超时/);});
