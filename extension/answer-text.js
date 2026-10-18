// A conservative application budget, NOT a documented QQ platform maximum.
// Slot count and the original message's five-minute deadline belong to store.
export const ANSWER_PART_BYTES = 4000;
const bytes = text => new TextEncoder().encode(text).byteLength;

function inertUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

function safeText(text) {
  // Markdown embeds would make QQ fetch arbitrary answer-supplied resources.
  // Keep their labels/links; generated images use the separate upload pipeline.
  return text.replace(/!\[/g, '[')
    .replace(/<([^>\n]+)>/g, (whole, target) => inertUrl(target) ? whole : `＜${target}＞`)
    .replace(/!?\[([^\]\n]*)\]\(([^\s\n)]*)(?:\s+"[^"\n]*")?\)/g, (whole, label, target) => {
      if (inertUrl(target)) return `[${label}](${target})`;
      const literal = target.replace(/[:<>]/g, char => ({ ':': '：', '<': '＜', '>': '＞' }[char]));
      return label + (literal ? ` (${literal})` : '');
    })
    .replace(/<(https?:\/\/[^>\s]+)>/g, (_whole, target) => inertUrl(target) ? `<${target}>` : target.replace(':', '：'));
}

function safeProse(text) {
  let output = ''; let offset = 0;
  for (const match of text.matchAll(/(`+)([^\n]*?)\1/g)) {
    output += safeText(text.slice(offset, match.index)) + match[0];
    offset = match.index + match[0].length;
  }
  return output + safeText(text.slice(offset));
}

function units(text) {
  return Array.from(new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text), item => item.segment);
}

/** Strings consumed as QQ markdown.content, with code bytes/indentation intact. */
export function buildAnswerPosts(text, maxBytes = ANSWER_PART_BYTES) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('回复内容不能为空');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 64) throw new Error('回复分段大小无效');
  const posts = []; let chunk = ''; let fence = null; let syntheticPrefix = '';
  const closing = () => fence ? `${chunk.endsWith('\n') ? '' : '\n'}${fence.marker}` : '';
  const flush = () => {
    if (!chunk || chunk === syntheticPrefix) return;
    posts.push(chunk + closing());
    syntheticPrefix = fence ? `${fence.opener}\n` : '';
    chunk = syntheticPrefix;
  };
  const append = value => {
    if (bytes(chunk + value + (fence ? `${value.endsWith('\n') ? '' : '\n'}${fence.marker}` : '')) <= maxBytes) { chunk += value; return; }
    if (fence) {
      flush();
      if (bytes(chunk + value + (value.endsWith('\n') ? '' : '\n') + fence.marker) > maxBytes) throw new Error('回复中的单行代码过长，无法在不改动代码的情况下分段');
      chunk += value; return;
    }
    for (const unit of units(value)) {
      if (bytes(chunk + unit + (fence ? `${unit.endsWith('\n') ? '' : '\n'}${fence.marker}` : '')) > maxBytes) flush();
      if (bytes(chunk + unit + (fence ? `${unit.endsWith('\n') ? '' : '\n'}${fence.marker}` : '')) > maxBytes) throw new Error('回复中的单个字符或代码标记过长，无法完整分段');
      chunk += unit;
    }
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const body = line.replace(/\r?\n$/, '');
    if (!fence) {
      const open = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(body);
      if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
        const next = { marker: open[1], opener: body };
        if (bytes(`${body}\n${next.marker}`) + 8 > maxBytes) throw new Error('回复中的代码标记过长，无法完整分段');
        if (chunk && bytes(chunk + line + '\n' + next.marker) > maxBytes) flush();
        fence = next; chunk += line.endsWith('\n') ? line : `${line}\n`;
      } else append(safeProse(line));
    } else {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(body);
      if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) {
        if (bytes(chunk + line) > maxBytes) flush();
        fence = null; syntheticPrefix = ''; chunk += line;
      } else append(line);
    }
  }
  if (chunk && chunk !== syntheticPrefix) posts.push(chunk + closing());
  if (!posts.length || posts.some(post => !post || bytes(post) > maxBytes)) throw new Error('回复无法在消息大小限制内完整分段');
  return posts;
}
