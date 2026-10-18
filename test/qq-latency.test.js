import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as dom from '../extension/dom.js';
import * as shared from '../extension/shared.js';

const conversationUrl = 'https://chatgpt.com/c/qq-latency-fixture';
const prompt = 'Latency fixture';
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const generatedFixture = await fs.readFile(new URL('./fixtures/chatgpt-modern-generated-image.html', import.meta.url), 'utf8');
const productionSource = await fs.readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
// An optional external snapshot makes before/after measurements reproducible
// without making normal regression tests depend on a local temporary file.
const baselineSource = process.env.QQ_LATENCY_BASELINE_SOURCE
  ? await fs.readFile(process.env.QQ_LATENCY_BASELINE_SOURCE, 'utf8') : null;

async function benchmark({ source = productionSource, imageCount = 0, generationMs = 1000, imageReadMs = 0, imageReadDelays = [], imageStoreMs = 0 } = {}) {
  const page = new JSDOM('<main></main><div data-composer-body><div data-composer-attachments></div><div data-composer-markdown contenteditable="true" role="textbox"></div><button type="submit" aria-label="发送"></button></div>', { url: conversationUrl, runScripts: 'outside-only' });
  const win = page.window; const doc = win.document; const input = dom.composer(doc);
  let now = 1_800_000_000_000; let timerId = 0; let submittedAt; let finalVisibleAt; let firstCandidateAt;
  let terminal; let clicks = 0; let appDraft = ''; let resultAt; let activeReads = 0; let maxReadConcurrency = 0;
  const timers = new Map(); const messages = []; const reads = []; const writes = []; const candidates = [];
  const schedule = (callback, ms = 0) => { const id = ++timerId; timers.set(id, { at: now + ms, callback }); return id; };
  const pause = ms => ms ? new Promise(resolve => schedule(resolve, ms)) : Promise.resolve();
  win.Date = class extends Date { static now() { return now; } };
  win.setTimeout = schedule; win.clearTimeout = id => timers.delete(id);
  win.setInterval = () => 0; win.clearInterval = () => {};
  win.__testShared = shared;
  win.__testDom = {
    ...dom,
    finalCandidate(...args) {
      const candidate = dom.finalCandidate(...args);
      candidates.push({ at: now, present: Boolean(candidate) });
      if (candidate) {
        assert.ok(finalVisibleAt !== undefined && now >= finalVisibleAt, 'a streaming answer must not become an eligible final candidate');
        firstCandidateAt ??= now;
      }
      return candidate;
    },
    async readAnswerImage(image) {
      const index = Number(new URL(image.src).searchParams.get('id').split('-').at(-1));
      const record = { index, src: image.src, startedAt: now }; reads.push(record);
      assert.ok(now >= finalVisibleAt, 'image reads cannot start before the completed turn');
      maxReadConcurrency = Math.max(maxReadConcurrency, ++activeReads);
      try {
        await pause(imageReadDelays[index] ?? imageReadMs);
        return await dom.readAnswerImage(image, { fetchImpl: async url => {
          assert.match(url, /^https:\/\/chatgpt\.com\/backend-api\/estuary\/content\?id=latency-image-\d$/);
          return new Response(Uint8Array.from([...png, index]), { headers: { 'content-type': 'image/png' } });
        } });
      } finally { record.finishedAt = now; activeReads--; }
    },
  };
  doc.execCommand = (command, _ui, text) => { assert.equal(command, 'insertText'); input.textContent = text; return true; };
  input.addEventListener('input', () => { const text = dom.composerText(input); queueMicrotask(() => { appDraft = text; }); });
  doc.addEventListener('click', event => {
    if (!event.target.matches('button[type="submit"]')) return;
    clicks++; submittedAt = now; assert.equal(appDraft, prompt); input.textContent = '';
    if (imageCount) {
      doc.querySelector('main').innerHTML = generatedFixture;
      const gallery = doc.querySelector('[data-testid="generated-image-gallery"]');
      const template = gallery.querySelector('[data-image-transparency-backdrop-scope]').cloneNode(true);
      gallery.replaceChildren();
      for (let index = 0; index < imageCount; index++) {
        const preview = template.cloneNode(true); const image = preview.querySelector('img');
        image.src = `https://chatgpt.com/backend-api/estuary/content?id=latency-image-${index}`;
        Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 512 }, naturalHeight: { value: 512 } });
        gallery.append(preview);
      }
    } else {
      doc.querySelector('main').innerHTML = '<div data-turn-key="new"><div data-talvt-turn-state="complete"><div data-chatgpt-search-unit-key="new:0:user" data-chatgpt-search-message-ids="new-user"><div data-user-message-bubble="true"></div></div><div data-chatgpt-search-unit-key="new:1:assistant" data-chatgpt-search-message-ids="new-assistant"><div data-markdown-text-style="assistant-message"><p>Short completed answer.</p></div></div><div class="turn-action-controls"><button aria-label="复制">Copy</button></div></div></div>';
    }
    doc.querySelector('[data-user-message-bubble]').textContent = appDraft;
    const turn = doc.querySelector('[data-talvt-turn-state]'); turn.setAttribute('data-talvt-turn-state', 'streaming');
    // Full, unchanged-looking output is present throughout generation; only
    // the actual completion marker makes it eligible for final collection.
    schedule(() => { turn.setAttribute('data-talvt-turn-state', 'complete'); finalVisibleAt = now; }, generationMs);
  });
  win.chrome = { runtime: { id: 'latency-fixture', getURL: path => path, onMessage: { addListener() {} }, async sendMessage(message) {
    messages.push({ type: message.type, at: now });
    let data = { ok: true };
    if (message.type === 'bridge:poll') data = { job: messages.filter(item => item.type === 'bridge:poll').length === 1 ? { id: 'latency-job', prompt, conversationUrl, timeoutMs: 240000, images: [] } : null };
    if (message.type === 'bridge:image') {
      assert.ok(now >= finalVisibleAt, 'image output cannot start before the completed turn');
      assert.equal(message.mimeType, 'image/png');
      assert.equal(message.base64, Buffer.from([...png, message.index]).toString('base64'), 'image bytes must stay paired with their original index');
      const record = { index: message.index, startedAt: now }; writes.push(record);
      await pause(imageStoreMs); record.finishedAt = now;
      data = { imageId: String(message.index + 1).repeat(64) };
    }
    if (['bridge:result', 'bridge:error'].includes(message.type)) { terminal = message; resultAt = now; }
    return { ok: true, data };
  } } };
  try {
    // Execute actual orchestration; replace extension module loading only.
    win.eval(source
      .replace("await import(chrome.runtime.getURL('dom.js'))", 'globalThis.__testDom')
      .replace("await import(chrome.runtime.getURL('shared.js'))", 'globalThis.__testShared'));
    // Advance only after actual promise/stream microtasks settle. This also
    // keeps the script's real RPC watchdog timers ordered behind quick RPCs.
    for (let step = 0; !terminal && step < 2000; step++) {
      await new Promise(resolve => setImmediate(resolve));
      if (terminal) break;
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      assert.ok(next, 'fixture stalled without a scheduled timer');
      timers.delete(next[0]); now = next[1].at; next[1].callback();
    }
    assert.ok(terminal, 'fixture did not finish within the virtual scheduling budget');
    assert.equal(terminal.type, 'bridge:result', terminal.error); assert.equal(clicks, 1);
    assert.ok(firstCandidateAt >= finalVisibleAt); assert.ok(resultAt >= firstCandidateAt);
    assert.equal(terminal.images.length, imageCount);
    assert.deepEqual([...terminal.images], Array.from({ length: imageCount }, (_, index) => String(index + 1).repeat(64)));
    assert.equal(terminal.text, imageCount ? '' : 'Short completed answer.');
    assert.equal(messages.filter(message => message.type === 'bridge:result').length, 1);
    return {
      imageCount, generationMs, imageReadMs, imageReadDelays, imageStoreMs, maxReadConcurrency,
      finalMarkerToResultMs: resultAt - finalVisibleAt,
      firstCandidateToResultMs: resultAt - firstCandidateAt,
      completionDetectionMs: firstCandidateAt - finalVisibleAt,
      submittedToResultMs: resultAt - submittedAt,
      reads, writes, candidates, finalVisibleAt,
    };
  } finally { timers.clear(); page.window.close(); }
}

function diagnostic(t, name, result) {
  const { reads, writes, candidates, finalVisibleAt, ...metrics } = result;
  t.diagnostic(`${name}: ${JSON.stringify(metrics)}`);
}

test('latency benchmark: short completed text reaches bridge:result without network or storage delay', async t => {
  const result = await benchmark(); diagnostic(t, 'short-text', result);
  assert.ok(result.finalMarkerToResultMs < 1500, 'completed short text must not retain the old multi-second finalization wait');
  assert.equal(result.reads.length, 0); assert.equal(result.writes.length, 0);
});

test('latency benchmark: four generated images separate finalization wait from bounded image work', async t => {
  const immediate = await benchmark({ imageCount: 4 }); diagnostic(t, 'four-images-immediate', immediate);
  const delayed = await benchmark({ imageCount: 4, imageReadMs: 120, imageStoreMs: 80 }); diagnostic(t, 'four-images-synthetic-io', delayed);
  assert.ok(immediate.finalMarkerToResultMs < 1800, 'completed image galleries must not retain the old multi-second finalization wait');
  assert.ok(delayed.firstCandidateToResultMs - immediate.firstCandidateToResultMs < 4 * (120 + 80), 'image reads should overlap instead of adding four sequential read delays');
  assert.equal(delayed.reads.length, 4); assert.equal(delayed.writes.length, 4);
  assert.equal(delayed.maxReadConcurrency, 2);
  assert.deepEqual(delayed.writes.map(write => write.index), [0, 1, 2, 3]);
  for (let index = 0; index < 4; index++) {
    assert.ok(delayed.reads[index].finishedAt <= delayed.writes[index].startedAt);
    if (index) assert.ok(delayed.writes[index].startedAt >= delayed.writes[index - 1].finishedAt);
  }
});

test('concurrent image reads preserve image bytes and upload order when reads finish out of order', async t => {
  const result = await benchmark({ imageCount: 4, imageReadDelays: [240, 20, 120, 40], imageStoreMs: 80 });
  diagnostic(t, 'four-images-out-of-order-reads', result);
  assert.equal(result.maxReadConcurrency, 2);
  assert.ok(result.reads[1].finishedAt < result.reads[0].finishedAt, 'fixture must complete a later image before the first');
  assert.deepEqual(result.writes.map(write => write.index), [0, 1, 2, 3]);
});

test('unchanged text and loaded images cannot finish early while the page still marks the answer as generating', async t => {
  for (const imageCount of [0, 4]) {
    const result = await benchmark({ imageCount, generationMs: 10000 }); diagnostic(t, `streaming-${imageCount}-images`, result);
    const duringGeneration = result.candidates.filter(candidate => candidate.at < result.finalVisibleAt);
    assert.ok(duringGeneration.length > 10, 'exercise a stable-looking answer for several seconds before completion');
    assert.ok(duringGeneration.every(candidate => !candidate.present));
    assert.ok(result.submittedToResultMs >= 10000);
  }
});

test('optional before/after benchmark executes both real content script sources', { skip: !baselineSource }, async t => {
  for (const [name, options] of [
    ['short-text', {}],
    ['four-images-immediate', { imageCount: 4 }],
    ['four-images-synthetic-io', { imageCount: 4, imageReadMs: 120, imageStoreMs: 80 }],
  ]) {
    const before = await benchmark({ ...options, source: baselineSource });
    const after = await benchmark(options);
    diagnostic(t, `${name}-before`, before); diagnostic(t, `${name}-after`, after);
    assert.ok(after.finalMarkerToResultMs < before.finalMarkerToResultMs, `${name} must improve actual completion-to-result latency`);
    t.diagnostic(`${name}-saved-ms: ${before.finalMarkerToResultMs - after.finalMarkerToResultMs}`);
  }
});
