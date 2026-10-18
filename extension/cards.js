// Browser-safe counterpart of src/cards.js; no Node or remote dependencies.
import { ASSISTANT_NAMES } from './shared.js';
const byteLength = value => new TextEncoder().encode(value).byteLength;
// Official cards use a 30 KB limit. Include the outer JSON string escaping in
// our smaller limit, leaving room for Feishu's rendering/style overhead.
export const CARD_REQUEST_LIMIT = 24_000;
const CARD_METADATA_RESERVE = 1_500;
const STATUS = Object.freeze({
  queued: { title: '已排队', color: 'blue', text: '已加入队列，等待发送到 ChatGPT。' },
  running: { title: '正在生成', color: 'orange', text: 'ChatGPT 正在生成回复，请稍候。' },
  sending: { title: '正在发送', color: 'orange', text: '回复已生成，正在发送正文和图片。' },
  completed: { title: '已完成', color: 'green' },
  failed: { title: '未完成', color: 'red', text: '本次请求未能完成，请查看扩展运行状态。' },
  cancelled: { title: '已取消', color: 'grey', text: '已手动取消，未发送到 ChatGPT。' },
  blocked: { title: '已拦截', color: 'red', text: '这条消息触发本群关键词限制，未发送到 ChatGPT。' },
});

function linesOf(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function compactFenceLines(text) {
  const lines = linesOf(text.toWellFormed());
  for (let index = 0; index < lines.length; index += 1) {
    const plain = lines[index].replace(/\r?\n$/, '');
    const opening = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/.exec(plain);
    if (!opening || (opening[2][0] === '`' && opening[3].includes('`'))) continue;
    const original = opening[2];
    let closing = index + 1;
    let longestTicks = 0; let longestTildes = 0;
    for (; closing < lines.length; closing += 1) {
      const delimiter = /^ {0,3}(`+|~+)[ \t]*(?:\r?\n)?$/.exec(lines[closing]);
      if (!delimiter) continue;
      if (delimiter[1][0] === original[0] && delimiter[1].length >= original.length) break;
      if (delimiter[1][0] === '`') longestTicks = Math.max(longestTicks, delimiter[1].length);
      else longestTildes = Math.max(longestTildes, delimiter[1].length);
    }
    let marker = original;
    // DOM extraction deliberately chooses a fence longer than every backtick
    // run, including runs inside strings. Only standalone delimiter lines can
    // close a fenced block, so a much shorter safe marker usually suffices.
    if (original.length > 64 && (closing < lines.length || index + 1 < lines.length)) {
      const ticks = Math.max(3, longestTicks + 1);
      const tildes = Math.max(3, longestTildes + 1);
      marker = !opening[3].includes('`') && ticks <= tildes ? '`'.repeat(ticks) : '~'.repeat(tildes);
      lines[index] = opening[1] + marker + opening[3] + (lines[index].endsWith('\n') ? '\n' : '');
    }
    // Closing markers carry no code text or language metadata. Canonicalize
    // an excessive closing run instead of trying to split a structural line.
    if (closing < lines.length && (marker !== original || byteLength(lines[closing]) > 1_024)) {
      lines[closing] = marker + (lines[closing].endsWith('\n') ? '\n' : '');
    }
    index = closing;
  }
  return lines;
}

function fenceChange(line, open) {
  const plain = line.replace(/\r?\n$/, '');
  if (open) {
    const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(plain);
    return match && match[1][0] === open.marker[0] && match[1].length >= open.marker.length ? null : open;
  }
  const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(plain);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  // Abnormally large fence metadata is displayed as literal text below. It
  // cannot be repeated in bounded continuation cards without exceeding limits.
  if (byteLength(plain) > 1_024) return null;
  return { marker: match[1], opening: `${plain}\n` };
}

function sanitizePlainLine(line) {
  // Inline code is inert Markdown; keep its exact content, including examples
  // of image/at syntax. Everything else remains text, links and Markdown only.
  let output = '';
  for (let index = 0; index < line.length;) {
    if (line[index] === '`') {
      let end = index;
      while (line[end] === '`') end += 1;
      const marker = line.slice(index, end);
      let closing = line.indexOf(marker, end);
      while (closing !== -1 && (line[closing - 1] === '`' || line[closing + marker.length] === '`')) {
        closing = line.indexOf(marker, closing + marker.length);
      }
      if (closing !== -1) {
        output += line.slice(index, closing + marker.length);
        index = closing + marker.length;
        continue;
      }
      output += marker;
      index = end;
      continue;
    }
    const char = line[index];
    // Fullwidth punctuation remains visible and cannot become an at/person/
    // img/audio/link tag or an embedded image, even after entity decoding.
    const escapedTag = char === '&' && /^(?:&lt;|&#0*60;|&#x0*3c;)(?=\/?\s*(?:at|person|img|audio|video|link)\b)/i.exec(line.slice(index));
    if (escapedTag) {
      output += '＜';
      index += escapedTag[0].length;
      continue;
    }
    if (char === '<' && /^<\/?\s*[a-z!]/i.test(line.slice(index))) output += '＜';
    else if (char === '!' && line[index + 1] === '[') output += '！';
    else output += char;
    index += 1;
  }
  // Handle already-escaped resource tags as text too; do not rely on a
  // particular HTML-entity decoding order in the card renderer.
  return output;
}

function markdownLines(text) {
  let open = null;
  const records = [];
  for (const line of compactFenceLines(text)) {
    const before = open;
    const after = fenceChange(line, open);
    const structural = before !== after;
    let clean = before || structural ? line : sanitizePlainLine(line);
    if (!before && !structural && /^ {0,3}(?:`{3,}|~{3,})/.test(clean)) {
      // Preserve pathological delimiters visibly instead of accidentally
      // creating an unbounded fence which cannot be reopened in a later card.
      clean = clean.replace(/^([ ]{0,3})(`{3,}|~{3,})/, (_, spaces, marker) => spaces + marker.replaceAll('`', '｀').replaceAll('~', '～'));
    }
    records.push({ text: clean, before, after, structural, tableStart: false });
    open = after;
  }
  // Markdown tables are limited to four per markdown component. Mark their
  // header line so a new card starts before the fifth header, not its divider.
  for (let i = 1; i < records.length; i += 1) {
    if (records[i].before || records[i - 1].before || records[i].structural || records[i - 1].structural) continue;
    const divider = records[i].text.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    if (divider.length >= 1 && divider.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell)) && records[i - 1].text.includes('|')) records[i - 1].tableStart = true;
  }
  return records;
}

export function sanitizeMarkdown(text) {
  if (typeof text !== 'string') throw new Error('卡片正文必须是文本');
  return markdownLines(text).map((line) => line.text).join('');
}

function encodedBytes(text) {
  return byteLength(JSON.stringify(JSON.stringify(text))) - 6;
}

/** source joins losslessly; markdown adds only continuation fence wrappers. */
export function splitMarkdownParts(text, maxEncodedBytes = CARD_REQUEST_LIMIT - CARD_METADATA_RESERVE) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('卡片正文不能为空');
  if (!Number.isSafeInteger(maxEncodedBytes) || maxEncodedBytes < 1_200) throw new Error('卡片分段大小无效');
  const records = markdownLines(text);
  const parts = [];
  let source = '';
  let startingFence = null;
  let currentFence = null;
  let tables = 0;
  function render(value, endFence) {
    return (startingFence?.opening ?? '') + value + (endFence ? `${value.endsWith('\n') ? '' : '\n'}${endFence.marker}\n` : '');
  }
  function fits(value, endFence) { return encodedBytes(render(value, endFence)) <= maxEncodedBytes; }
  function flush() {
    if (!source) return;
    parts.push({ source, markdown: render(source, currentFence) });
    source = '';
    startingFence = currentFence;
    tables = 0;
  }
  for (const record of records) {
    if (record.tableStart && tables >= 4) flush();
    let remaining = record.text;
    while (remaining) {
      if (fits(source + remaining, record.after)) {
        source += remaining;
        currentFence = record.after;
        if (record.tableStart) tables += 1;
        break;
      }
      if (source) { flush(); continue; }
      if (record.structural) throw new Error('代码块标记过长，无法生成卡片');
      // An individual code/prose line can exceed the card limit. Split at a
      // Unicode grapheme boundary, closing/reopening the active code fence.
      let boundaries = [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(remaining)]
        .map(({ index, segment }) => index + segment.length);
      if (!fits(remaining.slice(0, boundaries[0]), currentFence)) {
        let offset = 0;
        boundaries = Array.from(remaining, (point) => (offset += point.length));
      }
      let low = 0;
      let high = boundaries.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(remaining.slice(0, boundaries[mid - 1]), currentFence)) low = mid;
        else high = mid - 1;
      }
      if (!low) throw new Error('卡片正文无法按大小限制分段');
      const end = boundaries[low - 1];
      source = remaining.slice(0, end);
      remaining = remaining.slice(end);
      flush();
    }
  }
  flush();
  return parts;
}

function makeCard(state, markdown, index, total, label) {
  const status = STATUS[state];
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill', summary: { content: `${label} · ${status.title}` } },
    header: { template: status.color, title: { tag: 'plain_text', content: `${label} · ${status.title}${total > 1 ? `（${index + 1}/${total}）` : ''}` } },
    body: { elements: [{ tag: 'markdown', element_id: 'answer', content: markdown }] },
  };
}

export function cardRequestBytes(card) {
  // The create envelope is larger than PATCH's content-only envelope. Reserve
  // the full maximum supported UUID length even though our UUIDs use 48.
  return byteLength(JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(card), uuid: '0'.repeat(50) }));
}

export function buildCards({ state, text, assistant = 'chatgpt' }, maxRequestBytes = CARD_REQUEST_LIMIT) {
  if (!Object.hasOwn(ASSISTANT_NAMES, assistant)) throw new Error('卡片助手无效');
  const label = ASSISTANT_NAMES[assistant];
  if (!Object.hasOwn(STATUS, state)) throw new Error('卡片状态无效');
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 2_700 || maxRequestBytes > CARD_REQUEST_LIMIT) throw new Error('卡片大小限制无效');
  const defaultText = STATUS[state].text?.replaceAll('ChatGPT', label);
  const body = ['queued', 'running', 'sending'].includes(state) ? defaultText : (text ?? defaultText);
  const parts = splitMarkdownParts(body, maxRequestBytes - CARD_METADATA_RESERVE);
  const cards = parts.map((part, index) => makeCard(state, part.markdown, index, parts.length, label));
  if (cards.some((card) => cardRequestBytes(card) > maxRequestBytes)) throw new Error('卡片大小超过限制');
  return cards;
}
