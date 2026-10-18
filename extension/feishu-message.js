// Browser-safe message normalization and inert text replies, shared with the local adapter semantics.
const EVENT_NAME = "im.message.receive_v1";
const CONTENT_LIMIT = 16000;
const byteLength = value => new TextEncoder().encode(value).byteLength;
function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/\s/.test(value);
}

function isResourceId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

function parsePost(content, ownKeys, botOpenId) {
  // Received posts have one title/content object, not the locale envelope used
  // when sending posts. Never recurse into forwarded/quoted message bodies or
  // media covers. Only img nodes in this exact message become attachments.
  if (!content || typeof content !== 'object' || Array.isArray(content) || !Array.isArray(content.content)) return null;
  if (content.title !== undefined && typeof content.title !== 'string') return null;
  let mentioned = false;
  const paragraphs = [];
  const imageKeys = new Set();
  for (const row of content.content) {
    if (!Array.isArray(row)) return null;
    let text = '';
    for (const node of row) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
      if (node.tag === 'text') {
        if (typeof node.text !== 'string') return null;
        text += node.text;
      } else if (node.tag === 'a') {
        if (typeof node.text !== 'string' || typeof node.href !== 'string' || !node.href.trim()) return null;
        // Preserve a pasted link as question text. The bridge does not open it.
        text += !node.text || node.text === node.href ? node.href : `${node.text} (${node.href})`;
      } else if (node.tag === 'at') {
        if (ownKeys.has(node.user_id) || node.user_id === botOpenId) mentioned = true;
        else {
          if (!isId(node.user_id)) return null;
          text += node.user_id;
        }
      } else if (node.tag === 'img') {
        if (!isResourceId(node.image_key) || !node.image_key.startsWith('img_')) return null;
        imageKeys.add(node.image_key);
      } else return null;
    }
    if (text.trim()) paragraphs.push(text);
  }
  if (!mentioned) return null;
  const text = [content.title ?? '', ...paragraphs].filter((part) => part.trim()).join('\n').trim();
  // Preserve every attachment here. The store rejects >4 atomically, instead
  // of silently submitting an incomplete subset of a user's message.
  const images = [...imageKeys].map((imageKey) => ({ imageKey }));
  if (!text && !images.length) return null;
  return { text: text || '请分析这条消息中的图片。', ...(images.length ? { images } : {}) };
}

/** The SDK supplies event contents; accepting the documented envelope also aids fixtures. */
export function normalizeMessage(payload, botOpenId) {
  if (!isId(botOpenId) || !payload || typeof payload !== 'object') return null;
  if (payload.header?.event_type && payload.header.event_type !== EVENT_NAME) return null;
  const event = payload.event ?? payload;
  const { sender, message } = event;
  if (sender?.sender_type !== 'user' || message?.chat_type !== 'group' || !['text', 'post'].includes(message.message_type)) return null;
  const senderId = sender.sender_id?.open_id;
  if (!isId(senderId) || senderId === botOpenId || !isId(message.message_id) || !isId(message.chat_id)) return null;
  if (!Array.isArray(message.mentions) || typeof message.content !== 'string') return null;
  const ownKeys = new Set(message.mentions
    .filter((mention) => mention?.id?.open_id === botOpenId && /^@_user_\d+$/.test(mention.key))
    .map((mention) => mention.key));
  if (!ownKeys.size) return null;
  let content;
  try { content = JSON.parse(message.content); } catch { return null; }
  const createdAt = Number(message.create_time);
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return null;
  const identity = { messageId: message.message_id, chatId: message.chat_id, senderId, createdAt };
  if (message.message_type === 'post') {
    const post = parsePost(content, ownKeys, botOpenId);
    return post ? { ...identity, ...post } : null;
  }
  if (typeof content?.text !== 'string') return null;
  let mentioned = false;
  const text = content.text.replace(/@_user_\d+/g, (key) => {
    if (!ownKeys.has(key)) return key;
    mentioned = true;
    return '';
  }).trim();
  if (!mentioned || !text) return null;
  return { ...identity, text };
}

/** Feishu's text API interprets <at> tags, even when msg_type is text. */
export function neutralizeMentions(text) {
  return text.replace(/<(?=\/?\s*at(?:\s|>|\/))/giu, '＜');
}

/** Bound the serialized text content in bytes, retaining graphemes whenever they fit. */
export function splitReplyText(text, maxBytes = CONTENT_LIMIT) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('回复内容不能为空');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 32) throw new Error('回复分段大小无效');
  const clean = neutralizeMentions(text.toWellFormed());
  const emptyBytes = byteLength(JSON.stringify({ text: '' }));
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
  const chunks = [];
  let chunk = '';
  let bytes = emptyBytes;
  function append(unit) {
    const size = byteLength(JSON.stringify(unit)) - 2;
    if (bytes + size > maxBytes && chunk) {
      chunks.push(chunk);
      chunk = '';
      bytes = emptyBytes;
    }
    chunk += unit;
    bytes += size;
  }
  for (const { segment } of segmenter.segment(clean)) {
    if (byteLength(JSON.stringify(segment)) - 2 + emptyBytes <= maxBytes) append(segment);
    // A maliciously long combining sequence can exceed a whole message. In that
    // case preserve code points, while still enforcing the byte bound.
    else for (const point of segment) append(point);
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
