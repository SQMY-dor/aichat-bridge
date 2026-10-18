import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { imagesVisuallyMatch } from '../extension/image-equivalence.js';
import { createImageDecoder } from './helpers/image-decoder.js';

const fixture = name => readFile(new URL(`./fixtures/image-equivalence/${name}`, import.meta.url));
const source = await fixture('source.png');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
function assertClosed(decoder) {
  assert.ok(decoder.bitmaps.length > 0);
  assert.ok(decoder.bitmaps.every(bitmap => bitmap.closeCount === 1), 'all decoded images close exactly once');
  assert.ok(decoder.canvases.every(canvas => canvas.width === 1 && canvas.height === 1), 'temporary pixel buffers are released');
}

test('real local decoding accepts same pixels, JPEG/WebP recompression and proportional previews', async () => {
  for (const name of ['source.png', 'source-reencoded.png', 'source-q85.jpg', 'source-q85.webp', 'source-half.png', 'source-half-q85.jpg']) {
    const bytes = await fixture(name); const decoder = createImageDecoder();
    if (name !== 'source.png') assert.notDeepEqual(bytes, source, `${name} is not the original byte stream`);
    assert.equal(await imagesVisuallyMatch(decoder.win, source, bytes), true, name);
    assert.equal(decoder.bitmaps.length, 2, `${name} uses a real decoder for both images`);
    assert.ok(decoder.canvases.every(canvas => Math.max(canvas.createdWidth, canvas.createdHeight) <= 256));
    if (name.startsWith('source-half')) assert.ok(decoder.canvases.every(canvas => canvas.createdWidth <= 192 && canvas.createdHeight <= 144), 'smaller previews are not upsampled');
    assertClosed(decoder);
  }
});

test('real local decoding rejects different content, rotation, mirroring and crops', async () => {
  for (const name of ['different.png', 'source-rotated.png', 'source-flipped.png', 'source-cropped.png']) {
    const decoder = createImageDecoder();
    assert.equal(await imagesVisuallyMatch(decoder.win, source, await fixture(name)), false, name);
    assertClosed(decoder);
  }
});

test('a large matching white background cannot conceal a locally changed colored region', async () => {
  const decoder = createImageDecoder();
  assert.equal(await imagesVisuallyMatch(decoder.win, await fixture('white-background.png'), await fixture('white-background-changed.png')), false);
  assertClosed(decoder);
});

test('transparent originals accept white compositing but reject an incorrect dark matte', async () => {
  const alpha = await fixture('alpha.png');
  for (const [name, matches] of [['alpha-flattened.png', true], ['alpha-black.png', false]]) {
    const decoder = createImageDecoder();
    assert.equal(await imagesVisuallyMatch(decoder.win, alpha, await fixture(name)), matches, name);
    assertClosed(decoder);
  }
});

test('a very small preview of a larger original is insufficient to validate its content', async () => {
  const decoder = createImageDecoder();
  assert.equal(await imagesVisuallyMatch(decoder.win, source, await fixture('source-tiny.png')), false);
  assert.equal(decoder.canvases.length, 0);
  assertClosed(decoder);
});

test('invalid formats, empty buffers and excessive encoded sizes fail before allocation', async () => {
  const invalid = [new Uint8Array(), new Uint8Array([1, 2, 3]), new Uint8Array(10_000_001), 'not bytes'];
  for (const bytes of invalid) for (const position of ['original', 'preview']) {
    const decoder = createImageDecoder();
    await assert.rejects(imagesVisuallyMatch(decoder.win, position === 'original' ? bytes : source, position === 'preview' ? bytes : source), /校验大小|解码/);
    assert.equal(decoder.decodeCalls.length, 0); assert.equal(decoder.canvases.length, 0);
  }
});

test('genuine image decoding failures retain no successful prior image', async () => {
  for (const position of ['original', 'preview']) {
    const decoder = createImageDecoder(); const truncated = source.subarray(0, 32);
    await assert.rejects(imagesVisuallyMatch(decoder.win, position === 'original' ? truncated : source, position === 'preview' ? truncated : source));
    assert.equal(decoder.bitmaps.length, position === 'original' ? 0 : 1);
    assert.ok(decoder.bitmaps.every(bitmap => bitmap.closeCount === 1));
    assert.equal(decoder.canvases.length, 0);
  }
});

test('missing decoding or canvas facilities fail explicitly', async () => {
  for (const name of ['createImageBitmap', 'OffscreenCanvas', 'Blob']) {
    const decoder = createImageDecoder(); delete decoder.win[name];
    await assert.rejects(imagesVisuallyMatch(decoder.win, source, source), /无法比较/);
    assert.equal(decoder.bitmaps.length, 0);
  }
});

test('decoded dimension limits reject invalid and oversized metadata before canvas allocation', async () => {
  // These synthetic decoder results test limits without allocating large pixel
  // buffers; format and real decoder behavior are exercised by other tests.
  for (const [width, height] of [[0, 12], [12, 0], [-1, 12], [12.5, 12], [32769, 1], [10000, 5000], [Infinity, 2]]) {
    for (const position of ['original', 'preview']) {
      const decoder = createImageDecoder(); const nativeDecode = decoder.win.createImageBitmap; let calls = 0;
      const invalid = { width, height, closeCount: 0, close() { this.closeCount++; } };
      decoder.win.createImageBitmap = async (...args) => {
        calls++;
        if (calls === (position === 'original' ? 1 : 2)) return invalid;
        return nativeDecode(...args);
      };
      await assert.rejects(imagesVisuallyMatch(decoder.win, source, source), /解码尺寸/);
      assert.equal(invalid.closeCount, 1); assert.equal(decoder.canvases.length, 0);
      assert.ok(decoder.bitmaps.every(bitmap => bitmap.closeCount === 1));
    }
  }
});

test('canvas errors close both decoded images and release their temporary buffers', async () => {
  const decoder = createImageDecoder(); const NativeCanvas = decoder.win.OffscreenCanvas;
  decoder.win.OffscreenCanvas = class extends NativeCanvas {
    constructor(...args) { const canvas = super(...args); canvas.getContext = () => null; return canvas; }
  };
  await assert.rejects(imagesVisuallyMatch(decoder.win, source, source), /无法比较/);
  assertClosed(decoder);
});

test('already cancelled comparisons never decode images', async () => {
  const decoder = createImageDecoder(); const controller = new AbortController(); controller.abort();
  await assert.rejects(imagesVisuallyMatch(decoder.win, source, source, controller.signal), /取消/);
  assert.equal(decoder.decodeCalls.length, 0);
});

test('cancelling either in-flight decode rejects promptly and closes its late bitmap once', async () => {
  for (const gatedCall of [1, 2]) {
    const decoder = createImageDecoder(); const nativeDecode = decoder.win.createImageBitmap;
    const started = deferred(); const release = deferred(); const controller = new AbortController(); let calls = 0;
    decoder.win.createImageBitmap = async (...args) => {
      calls++; const bitmap = await nativeDecode(...args);
      if (calls === gatedCall) { started.resolve(); await release.promise; }
      return bitmap;
    };
    const result = imagesVisuallyMatch(decoder.win, source, source, controller.signal);
    await started.promise; controller.abort();
    await assert.rejects(result, /取消/);
    assert.equal(decoder.bitmaps.at(-1).closeCount, 0, 'the unresolved decode has not yet returned its image');
    if (gatedCall === 2) assert.equal(decoder.bitmaps[0].closeCount, 1, 'the original is closed immediately');
    release.resolve(); await settle();
    assertClosed(decoder); assert.equal(decoder.canvases.length, 0);
  }
});
