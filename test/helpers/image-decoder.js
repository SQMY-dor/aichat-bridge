import { createCanvas, loadImage } from '@napi-rs/canvas';

// A real local decoder for the browser-facing image comparison helper. This
// does not launch a browser or connect to any running browser/profile.
export function createImageDecoder() {
  const bitmaps = []; const canvases = []; const decodeCalls = [];
  const win = {
    Blob,
    async createImageBitmap(blob, options) {
      decodeCalls.push({ bytes: blob.size, options });
      const bitmap = await loadImage(Buffer.from(await blob.arrayBuffer()));
      bitmap.closeCount = 0;
      bitmap.close = () => { bitmap.closeCount++; };
      bitmaps.push(bitmap);
      return bitmap;
    },
    OffscreenCanvas: class {
      constructor(width, height) {
        const canvas = createCanvas(width, height);
        canvas.createdWidth = width; canvas.createdHeight = height;
        canvases.push(canvas);
        return canvas;
      }
    },
  };
  return { win, bitmaps, canvases, decodeCalls };
}
