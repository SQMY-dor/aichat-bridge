// Browser implementation of the official SDK's pbbp2 Header/Frame wire schema.
// Reference: @larksuiteoapi/node-sdk WSClient and its generated pbbp2.Frame.
// uint64 sequence/log IDs stay BigInt so acknowledgements never lose precision.
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const utf8 = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const invalid = () => new Error('飞书长连接数据格式无效');
function bytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw invalid();
}
function join(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (length > MAX_FRAME_BYTES) throw invalid();
  const output = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
function varint(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw invalid();
  let number;
  try { number = BigInt(value); } catch { throw invalid(); }
  if (number < 0n || number > 0xffffffffffffffffn) throw invalid();
  const output = [];
  do { let part = Number(number & 127n); number >>= 7n; if (number) part |= 128; output.push(part); } while (number);
  return Uint8Array.from(output);
}
function field(id, value, wire = 2) {
  return wire === 0 ? join([varint(id * 8), varint(value)]) : join([varint(id * 8 + 2), varint(value.length), value]);
}
export function encodeFrame(frame) {
  const chunks = ['SeqID', 'LogID', 'service', 'method'].map((name, i) => field(i + 1, frame[name] ?? 0, 0));
  if (!Array.isArray(frame.headers ?? []) || (frame.headers?.length ?? 0) > 64) throw invalid();
  for (const header of frame.headers ?? []) {
    if (typeof header.key !== 'string' || typeof header.value !== 'string' || header.key.length > 128 || header.value.length > 8192) throw invalid();
    chunks.push(field(5, join([field(1, utf8.encode(header.key)), field(2, utf8.encode(header.value))])));
  }
  for (const [id, name] of [[6, 'payloadEncoding'], [7, 'payloadType'], [9, 'LogIDNew']]) if (frame[name] !== undefined) {
    if (typeof frame[name] !== 'string') throw invalid();
    chunks.push(field(id, utf8.encode(frame[name])));
  }
  if (frame.payload !== undefined) chunks.push(field(8, bytes(frame.payload)));
  return join(chunks);
}
function reader(value) {
  const input = bytes(value); let offset = 0;
  if (input.length > MAX_FRAME_BYTES) throw invalid();
  const integer = () => {
    let output = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= input.length) throw invalid();
      const part = input[offset++];
      if (i === 9 && part > 1) throw invalid();
      output |= BigInt(part & 127) << BigInt(i * 7);
      if (!(part & 128)) return output;
    }
    throw invalid();
  };
  const take = length => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > input.length) throw invalid();
    const result = input.subarray(offset, offset + length); offset += length; return result;
  };
  return {
    get done() { return offset === input.length; }, integer,
    block: () => take(Number(integer())),
    skip(wire) { if (wire === 0) integer(); else if (wire === 1) take(8); else if (wire === 2) take(Number(integer())); else if (wire === 5) take(4); else throw invalid(); },
  };
}
function decodeHeader(value) {
  const r = reader(value); const output = {};
  while (!r.done) {
    const tag = Number(r.integer()); const id = tag >>> 3; const wire = tag & 7;
    if (!id) throw invalid();
    if ([1, 2].includes(id)) { if (wire !== 2) throw invalid(); output[id === 1 ? 'key' : 'value'] = decoder.decode(r.block()); }
    else r.skip(wire);
  }
  if (typeof output.key !== 'string' || typeof output.value !== 'string' || output.key.length > 128 || output.value.length > 8192) throw invalid();
  return output;
}
export function decodeFrame(value) {
  const r = reader(value); const output = { headers: [] };
  while (!r.done) {
    const tag = Number(r.integer()); const id = tag >>> 3; const wire = tag & 7;
    if (!id) throw invalid();
    if (id >= 1 && id <= 4) {
      if (wire !== 0) throw invalid();
      const number = r.integer();
      if (id > 2 && number > 0x7fffffffn) throw invalid();
      output[['SeqID', 'LogID', 'service', 'method'][id - 1]] = id <= 2 ? number : Number(number);
    } else if (id >= 5 && id <= 9) {
      if (wire !== 2) throw invalid();
      const data = r.block();
      if (id === 5) { if (output.headers.length >= 64) throw invalid(); output.headers.push(decodeHeader(data)); }
      else output[{ 6: 'payloadEncoding', 7: 'payloadType', 8: 'payload', 9: 'LogIDNew' }[id]] = id === 8 ? data : decoder.decode(data);
    } else r.skip(wire);
  }
  if (!['SeqID', 'LogID', 'service', 'method'].every(name => Object.hasOwn(output, name))) throw invalid();
  return output;
}
export function frameHeaders(frame) {
  const result = Object.create(null);
  for (const { key, value } of frame.headers) { if (Object.hasOwn(result, key)) throw invalid(); result[key] = value; }
  return result;
}
export class EventAssembler {
  constructor({ now = Date.now } = {}) { this.now = now; this.pending = new Map(); }
  clear() { this.pending.clear(); }
  add(frame) {
    for (const [id, item] of this.pending) if (this.now() - item.createdAt > 15000) this.pending.delete(id);
    const headers = frameHeaders(frame);
    if (headers.type !== 'event') return null;
    const { message_id: id } = headers;
    if (typeof id !== 'string' || !id || id.length > 256 || !/^\d+$/.test(headers.sum ?? '') || !/^\d+$/.test(headers.seq ?? '')) throw invalid();
    const sum = Number(headers.sum); const seq = Number(headers.seq);
    if (!Number.isInteger(sum) || sum < 1 || sum > 64 || !Number.isInteger(seq) || seq < 0 || seq >= sum || !frame.payload) throw invalid();
    if (!this.pending.has(id)) {
      if (this.pending.size >= 128) throw invalid();
      this.pending.set(id, { createdAt: this.now(), sum, chunks: new Map(), bytes: 0 });
    }
    const item = this.pending.get(id); const previous = item.chunks.get(seq);
    if (item.sum !== sum || (previous && (previous.length !== frame.payload.length || previous.some((byte, index) => byte !== frame.payload[index])))) { this.pending.delete(id); throw invalid(); }
    if (!previous) { item.chunks.set(seq, frame.payload.slice()); item.bytes += frame.payload.length; }
    if (item.bytes > MAX_FRAME_BYTES || [...this.pending.values()].reduce((total, entry) => total + entry.bytes, 0) > 8 * MAX_FRAME_BYTES) { this.pending.delete(id); throw invalid(); }
    if (item.chunks.size !== sum) return null;
    this.pending.delete(id);
    const raw = join(Array.from({ length: sum }, (_, index) => item.chunks.get(index)));
    let payload;
    try { payload = JSON.parse(decoder.decode(raw)); } catch { throw invalid(); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid();
    return { messageId: id, payload };
  }
}
