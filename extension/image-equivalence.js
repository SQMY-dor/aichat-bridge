// A newly pasted preview can be re-encoded or resized by the website. This
// check supplements fresh-card/source ownership; it is not a file hash or an
// assertion that a lossy thumbnail preserves every detail of the original.
const MAX_BYTES = 10_000_000;
const MAX_PIXELS = 40_000_000;
const MAX_AXIS = 32768;
const SAMPLE_EDGE = 256;

function abortIfNeeded(signal) {
  if (signal?.aborted) throw new Error('图片内容校验已取消');
}

function imageType(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_BYTES) throw new Error('图片内容校验大小超限');
  const starts = values => values.every((value, index) => bytes[index] === value);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (starts([255, 216, 255])) return 'image/jpeg';
  if (starts([82, 73, 70, 70]) && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value)) return 'image/webp';
  throw new Error('无法解码图片预览，仅支持 PNG、JPEG 和 WebP');
}

async function decode(win, bytes, signal) {
  abortIfNeeded(signal);
  const type = imageType(bytes);
  // ImageBitmap decoding itself cannot be aborted. Close a late result rather
  // than allowing a cancelled task to retain or use it.
  let onAbort; let discarded = false;
  const pending = Promise.resolve().then(() => {
    abortIfNeeded(signal);
    return win.createImageBitmap(new win.Blob([bytes], { type }));
  }).then(bitmap => {
    if (discarded || signal?.aborted) { bitmap.close(); throw new Error('图片内容校验已取消'); }
    return bitmap;
  });
  const cancelled = new Promise((_, reject) => {
    onAbort = () => { discarded = true; reject(new Error('图片内容校验已取消')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  try { return await Promise.race([pending, cancelled]); }
  finally { signal?.removeEventListener('abort', onAbort); }
}

function validDimensions(bitmap) {
  const { width, height } = bitmap;
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width <= MAX_AXIS && height <= MAX_AXIS && width * height <= MAX_PIXELS;
}

function sample(win, bitmap, width, height) {
  const canvas = new win.OffscreenCanvas(width, height);
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('当前浏览器无法比较图片预览');
    // White compositing also accepts the website flattening transparent PNGs.
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height).data;
  } finally { canvas.width = 1; canvas.height = 1; }
}

function closePixels(left, right, width, height) {
  // Keep both global and local error small: a matching large background must
  // not hide a different picture in one region. No hash-only resemblance test.
  const tileSize = 16; const columns = Math.ceil(width / tileSize);
  const totals = new Float64Array(columns * Math.ceil(height / tileSize));
  const counts = new Uint32Array(totals.length);
  let sum = 0; let squared = 0; let outliers = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = (y * width + x) * 4;
    const tile = Math.floor(y / tileSize) * columns + Math.floor(x / tileSize);
    let max = 0;
    for (let channel = 0; channel < 3; channel++) {
      const difference = Math.abs(left[pixel + channel] - right[pixel + channel]);
      sum += difference; squared += difference * difference; totals[tile] += difference;
      max = Math.max(max, difference);
    }
    counts[tile] += 3;
    if (max > 48) outliers++;
  }
  const channels = width * height * 3;
  return sum / channels <= 6 && Math.sqrt(squared / channels) <= 14 &&
    outliers / (width * height) <= 0.01 && totals.every((total, index) => total / counts[index] <= 18);
}

export async function imagesVisuallyMatch(win, originalBytes, previewBytes, signal) {
  abortIfNeeded(signal);
  if (typeof win.createImageBitmap !== 'function' || typeof win.OffscreenCanvas !== 'function' || typeof win.Blob !== 'function') throw new Error('当前浏览器无法比较转码后的图片预览');
  // Validate both inputs before allocating any decoded image.
  imageType(originalBytes); imageType(previewBytes);
  let original; let preview;
  try {
    original = await decode(win, originalBytes, signal);
    if (!validDimensions(original)) throw new Error('原图解码尺寸超过校验限制');
    preview = await decode(win, previewBytes, signal);
    if (!validDimensions(preview)) throw new Error('预览图解码尺寸超过校验限制');
    abortIfNeeded(signal);
    const originalRatio = original.width / original.height; const previewRatio = preview.width / preview.height;
    if (Math.abs(originalRatio - previewRatio) / Math.max(originalRatio, previewRatio) > 0.015) return false;
    const originalEdge = Math.max(original.width, original.height); const previewEdge = Math.max(preview.width, preview.height);
    if (originalEdge >= 64 && previewEdge < 64) return false;
    const edge = Math.min(SAMPLE_EDGE, originalEdge, previewEdge);
    const width = Math.max(1, Math.round(edge * original.width / originalEdge));
    const height = Math.max(1, Math.round(edge * original.height / originalEdge));
    const left = sample(win, original, width, height); const right = sample(win, preview, width, height);
    abortIfNeeded(signal);
    return closePixels(left, right, width, height);
  } finally { original?.close(); preview?.close(); }
}
