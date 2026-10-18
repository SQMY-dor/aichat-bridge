import { createCanvas, loadImage } from '@napi-rs/canvas';
import { writeFile } from 'node:fs/promises';
import { deflateSync, inflateSync } from 'node:zlib';

// All artwork is synthetic and drawn here without fonts, random data, network
// assets, or user images. Run this file with Node from any working directory.
const output = new URL('./', import.meta.url);
const width = 384; const height = 288;
const canvas = createCanvas(width, height); const ctx = canvas.getContext('2d');
const gradient = ctx.createLinearGradient(0, 0, width, height);
gradient.addColorStop(0, '#d2eaf9'); gradient.addColorStop(0.55, '#f4d59f'); gradient.addColorStop(1, '#638fb7');
ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
ctx.fillStyle = '#416a48'; ctx.beginPath(); ctx.moveTo(0, 240); ctx.lineTo(111, 85); ctx.lineTo(223, 240); ctx.closePath(); ctx.fill();
ctx.fillStyle = '#779154'; ctx.beginPath(); ctx.moveTo(113, 288); ctx.lineTo(279, 100); ctx.lineTo(384, 250); ctx.lineTo(384, 288); ctx.closePath(); ctx.fill();
ctx.fillStyle = '#d36b3d'; ctx.fillRect(227, 167, 85, 67);
ctx.fillStyle = '#3d3547'; ctx.beginPath(); ctx.moveTo(215, 169); ctx.lineTo(270, 125); ctx.lineTo(326, 169); ctx.closePath(); ctx.fill();
ctx.fillStyle = '#e7d3ae'; ctx.fillRect(242, 183, 18, 18); ctx.fillRect(279, 183, 18, 18);
ctx.fillStyle = '#6c3d2c'; ctx.fillRect(263, 206, 17, 28);
ctx.fillStyle = '#f8edbb'; ctx.beginPath(); ctx.arc(316, 51, 23, 0, Math.PI * 2); ctx.fill();
ctx.strokeStyle = '#a9d4e1'; ctx.lineWidth = 11; ctx.beginPath(); ctx.moveTo(0, 271); ctx.bezierCurveTo(97, 229, 181, 301, 384, 257); ctx.stroke();
for (let i = 0; i < 9; i++) {
  ctx.fillStyle = i % 2 ? '#6d456a' : '#bb6974';
  ctx.beginPath(); ctx.arc(22 + i * 16, 244 + (i % 3) * 8, 4, 0, Math.PI * 2); ctx.fill();
}
const save = async (name, bytes) => writeFile(new URL(name, output), bytes);
const png = canvas.encodeSync('png');
await save('source.png', png);
await save('source-q85.jpg', canvas.encodeSync('jpeg', 85));
await save('source-q85.webp', canvas.encodeSync('webp', 85));

// Recompress the exact same PNG scanlines with DEFLATE level zero. This is a
// genuinely different encoding with identical decoded pixels.
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const header = Buffer.from(type); const length = Buffer.alloc(4); const crc = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([header, bytes])));
  return Buffer.concat([length, header, bytes, crc]);
}
const chunks = []; const compressed = [];
for (let offset = 8; offset < png.length;) {
  const length = png.readUInt32BE(offset); const type = png.toString('ascii', offset + 4, offset + 8);
  const bytes = png.subarray(offset + 8, offset + 8 + length);
  if (type === 'IDAT') compressed.push(bytes); else chunks.push({ type, bytes });
  offset += length + 12;
}
await save('source-reencoded.png', Buffer.concat([
  png.subarray(0, 8),
  ...chunks.filter(value => value.type !== 'IEND').map(value => chunk(value.type, value.bytes)),
  chunk('IDAT', deflateSync(inflateSync(Buffer.concat(compressed)), { level: 0 })),
  chunk('IEND', Buffer.alloc(0)),
]));

const half = createCanvas(width / 2, height / 2); half.getContext('2d').drawImage(canvas, 0, 0, width / 2, height / 2);
await save('source-half.png', half.encodeSync('png'));
await save('source-half-q85.jpg', half.encodeSync('jpeg', 85));
const tiny = createCanvas(48, 36); tiny.getContext('2d').drawImage(canvas, 0, 0, 48, 36);
await save('source-tiny.png', tiny.encodeSync('png'));
const rotated = createCanvas(height, width); const rotatedCtx = rotated.getContext('2d');
rotatedCtx.translate(height, 0); rotatedCtx.rotate(Math.PI / 2); rotatedCtx.drawImage(canvas, 0, 0);
await save('source-rotated.png', rotated.encodeSync('png'));
const flipped = createCanvas(width, height); const flippedCtx = flipped.getContext('2d');
flippedCtx.translate(width, 0); flippedCtx.scale(-1, 1); flippedCtx.drawImage(canvas, 0, 0);
await save('source-flipped.png', flipped.encodeSync('png'));
const crop = createCanvas(width, height);
crop.getContext('2d').drawImage(canvas, 48, 36, 288, 216, 0, 0, width, height);
await save('source-cropped.png', crop.encodeSync('png'));
const other = createCanvas(width, height); const otherCtx = other.getContext('2d');
otherCtx.fillStyle = '#142a43'; otherCtx.fillRect(0, 0, width, height);
for (let i = 0; i < 8; i++) { otherCtx.fillStyle = i % 2 ? '#c14551' : '#dcd59e'; otherCtx.fillRect(i * 48, 0, 24, height); }
await save('different.png', other.encodeSync('png'));

const white = createCanvas(width, height); const whiteCtx = white.getContext('2d');
whiteCtx.fillStyle = '#ffffff'; whiteCtx.fillRect(0, 0, width, height);
whiteCtx.fillStyle = '#252a31'; whiteCtx.fillRect(28, 34, 186, 9); whiteCtx.fillRect(28, 52, 135, 5);
whiteCtx.fillStyle = '#3178bd'; whiteCtx.fillRect(276, 202, 24, 24);
await save('white-background.png', white.encodeSync('png'));
whiteCtx.fillStyle = '#cf3548'; whiteCtx.fillRect(276, 202, 24, 24);
await save('white-background-changed.png', white.encodeSync('png'));

const alpha = createCanvas(width, height); const alphaCtx = alpha.getContext('2d');
alphaCtx.fillStyle = 'rgba(70,120,210,0.4)'; alphaCtx.fillRect(20, 25, 240, 140);
alphaCtx.fillStyle = 'rgba(210,75,40,0.8)'; alphaCtx.beginPath(); alphaCtx.arc(250, 181, 57, 0, Math.PI * 2); alphaCtx.fill();
await save('alpha.png', alpha.encodeSync('png'));
const flattened = createCanvas(width, height); const flattenedCtx = flattened.getContext('2d');
flattenedCtx.fillStyle = '#ffffff'; flattenedCtx.fillRect(0, 0, width, height); flattenedCtx.drawImage(alpha, 0, 0);
await save('alpha-flattened.png', flattened.encodeSync('png'));
flattenedCtx.fillStyle = '#000000'; flattenedCtx.fillRect(0, 0, width, height); flattenedCtx.drawImage(alpha, 0, 0);
await save('alpha-black.png', flattened.encodeSync('png'));

// Confirm the PNG recompression fixture is genuinely decodable before writing
// a success result. All other images were encoded by the native canvas codec.
await loadImage(new URL('source-reencoded.png', output).pathname);
console.log('Generated synthetic image-equivalence fixtures.');
