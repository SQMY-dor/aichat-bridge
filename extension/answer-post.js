// Official schemas and limits (checked 2026-10-16):
// https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json
// https://open.feishu.cn/document/server-docs/im-v1/message/reply
// Native post code_block nodes retain literal code. Prose uses inert styled
// text and validated HTTP(S) links. The only md nodes are reconstructed,
// canonical tables: no mentions, embedded resources or HTML/entity decoding.
export const ANSWER_POST_REQUEST_LIMIT = 24_000; // official post request limit: 30 KB
const encoder = new TextEncoder();
const LANGUAGES = new Set(['PYTHON', 'C', 'CPP', 'GO', 'JAVA', 'KOTLIN', 'SWIFT', 'PHP', 'RUBY', 'RUST', 'JAVASCRIPT', 'TYPESCRIPT', 'BASH', 'SHELL', 'SQL', 'JSON', 'XML', 'YAML', 'HTML', 'THRIFT']);
const ALIASES = Object.freeze({ PY: 'PYTHON', PY3: 'PYTHON', PYTHON3: 'PYTHON', 'C++': 'CPP', CC: 'CPP', CXX: 'CPP', GOLANG: 'GO', KT: 'KOTLIN', RB: 'RUBY', RS: 'RUST', JS: 'JAVASCRIPT', MJS: 'JAVASCRIPT', CJS: 'JAVASCRIPT', TS: 'TYPESCRIPT', SH: 'SHELL', ZSH: 'SHELL', YML: 'YAML' });
const STYLES = new Set(['bold', 'italic', 'lineThrough', 'underline']);
const invalid = () => new Error('飞书富文本正文或格式无效');
const postOf = rows => ({ zh_cn: { title: '', content: rows } });
const styled = style => style.length ? { style: [...new Set(style)].sort() } : {};
const prose = (text, style = []) => ({ tag: 'text', text, un_escape: false, ...styled(style) });

function safeLink(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\x00-\x20\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function inline(text, style = [], depth = 0) {
  if (depth > 8) return [prose(text, style)];
  const nodes = [];
  function append(node) {
    const previous = nodes.at(-1);
    if (previous?.tag === node.tag && previous.href === node.href && JSON.stringify(previous.style) === JSON.stringify(node.style)) previous.text += node.text;
    else nodes.push(node);
  }
  const escaped = index => { let n = 0; while (index > 0 && text[--index] === '\\') n++; return n % 2; };
  function closing(marker, begin) {
    let end = text.indexOf(marker, begin);
    while (end !== -1) {
      if (!escaped(end) && !/\s/.test(text[end - 1] ?? '') && !(marker.includes('_') && /[\p{L}\p{N}]/u.test(text[end + marker.length] ?? ''))) return end;
      end = text.indexOf(marker, end + marker.length);
    }
    return -1;
  }
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\' && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(text[i + 1] ?? '')) { append(prose(text[i + 1], style)); i += 2; continue; }
    if (text[i] === '`') {
      let edge = i; while (text[edge] === '`') edge++;
      const marker = text.slice(i, edge); let end = text.indexOf(marker, edge);
      while (end !== -1 && (text[end - 1] === '`' || text[end + marker.length] === '`')) end = text.indexOf(marker, end + marker.length);
      if (end !== -1) { append(prose(text.slice(edge, end), style)); i = end + marker.length; continue; }
      append(prose(marker, style)); i = edge; continue;
    }
    if (text[i] === '[' || (text[i] === '!' && text[i + 1] === '[')) {
      const image = text[i] === '!'; const start = i + (image ? 2 : 1);
      const middle = text.indexOf('](', start);
      if (middle !== -1) {
        let balance = 1; let end = middle + 2;
        for (; end < text.length && balance; end++) if (!escaped(end)) { if (text[end] === '(') balance++; if (text[end] === ')') balance--; }
        if (!balance) {
          const raw = text.slice(middle + 2, end - 1).trim();
          const target = /^(?:<([^<>]+)>|(\S+?))(?:\s+["'][^\r\n]*["'])?$/.exec(raw);
          const destination = (target?.[1] ?? target?.[2])?.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
          const href = safeLink(destination);
          const label = inline(text.slice(start, middle), style, depth + 1);
          if (image) append(prose('图片：', style));
          for (const node of label) append(href ? { tag: 'a', text: node.text, href, ...styled(node.style ?? []) } : prose(node.text, node.style ?? []));
          if (!href) append(prose(` (${raw})`, style));
          i = end; continue;
        }
      }
    }
    let found = false;
    for (const [marker, extra] of [['***', ['bold', 'italic']], ['___', ['bold', 'italic']], ['**', ['bold']], ['__', ['bold']], ['~~', ['lineThrough']], ['*', ['italic']], ['_', ['italic']]]) {
      if (!text.startsWith(marker, i) || /\s/.test(text[i + marker.length] ?? '') || (marker.includes('_') && /[\p{L}\p{N}]/u.test(text[i - 1] ?? ''))) continue;
      const end = closing(marker, i + marker.length);
      if (end <= i + marker.length) continue;
      for (const node of inline(text.slice(i + marker.length, end), [...style, ...extra], depth + 1)) append(node);
      i = end + marker.length; found = true; break;
    }
    if (!found) { const point = String.fromCodePoint(text.codePointAt(i)); append(prose(point, style)); i += point.length; }
  }
  return nodes;
}

function proseNodes(text) {
  const nodes = [];
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const ending = /\r?\n$/.exec(line)?.[0] ?? '';
    let plain = ending ? line.slice(0, -ending.length) : line; let prefix = ''; let style = [];
    const quote = /^ {0,3}((?:>[ \t]?)+)/.exec(plain);
    if (quote) { prefix = '│ '.repeat((quote[1].match(/>/g) ?? []).length); plain = plain.slice(quote[0].length); }
    const heading = /^ {0,3}#{1,6}[ \t]+(.*)$/.exec(plain);
    if (heading) { plain = heading[1].replace(/[ \t]+#+[ \t]*$/, ''); style = ['bold']; }
    const list = /^(\s*)[-+*][ \t]+(?:\[([ xX])\][ \t]+)?/.exec(plain);
    if (list) { prefix += list[1] + (list[2] === undefined ? '• ' : list[2].toLowerCase() === 'x' ? '☑ ' : '☐ '); plain = plain.slice(list[0].length); }
    if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(plain)) plain = '────────';
    if (prefix) nodes.push(prose(prefix));
    nodes.push(...inline(plain, style));
    if (ending) nodes.push(prose(ending));
  }
  return nodes.reduce((result, node) => {
    const previous = result.at(-1);
    if (previous?.tag === node.tag && previous.href === node.href && JSON.stringify(previous.style) === JSON.stringify(node.style)) previous.text += node.text;
    else result.push(node);
    return result;
  }, []);
}

function tableCells(line) {
  const value = line.trim(); const cells = []; let cell = ''; let marker = ''; let pipes = 0;
  for (let i = 0; i < value.length;) {
    if (value[i] === '\\' && i + 1 < value.length) { cell += value.slice(i, i + 2); i += 2; continue; }
    if (value[i] === '`') {
      let end = i; while (value[end] === '`') end++;
      const run = value.slice(i, end);
      if (marker === run) marker = ''; else if (!marker && value.indexOf(run, end) !== -1) marker = run;
      cell += run; i = end; continue;
    }
    if (value[i] === '|' && !marker) { cells.push(cell.trim()); cell = ''; pipes++; }
    else cell += value[i];
    i++;
  }
  cells.push(cell.trim());
  if (!pipes) return null;
  if (value.startsWith('|')) cells.shift();
  if (value.endsWith('|') && cells.at(-1) === '') cells.pop();
  return cells.length ? cells : null;
}

function tableBreaks(value) {
  // DOM table extraction represents <br> as a marker. Inside literal inline
  // code it remains code text; elsewhere it becomes a compact cell separator.
  return value.replace(/(`+)([\s\S]*?)\1|<br\s*\/?>/gi, (match, marker) => marker ? match : ' / ');
}
function tableLiteral(value) {
  return value.replace(/[\r\n]+/g, ' / ').replaceAll('@', '＠').replaceAll('<', '＜').replaceAll('>', '＞').replaceAll('&', '＆')
    .replace(/[\\`*_{}[\]()#+.!|\-]/g, '\\$&');
}
function tableLink(value) {
  const safe = safeLink(value);
  if (!safe) return null;
  const url = new URL(safe);
  // Keep IPv6 host brackets intact; encode Markdown/table delimiters only in
  // the path/query/fragment, including pipes escaped by DOM table extraction.
  return url.origin + (url.pathname + url.search + url.hash).replace(/[()[\]|'"<>`\\]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
}
function tableCell(value) {
  const nodes = [];
  for (const node of inline(tableBreaks(value).trim())) {
    const href = node.tag === 'a' ? tableLink(node.href) : null;
    const previous = nodes.at(-1);
    // Tables intentionally omit inline styling. Merge again after removing
    // styles so canonical validation does not alter adjacent identical links.
    if (previous && previous.href === href) previous.text += node.text;
    else nodes.push({ text: node.text, href });
  }
  return nodes.map(node => {
    const label = tableLiteral(node.text);
    return node.href ? `[${label}](${node.href})` : label;
  }).join('').trim();
}
const tableLine = cells => '| ' + cells.join(' | ') + ' |';
const tableText = (headers, rows) => '\n\n' + [tableLine(headers), tableLine(headers.map(() => '---')), ...rows.map(tableLine)].join('\n') + '\n\n';
const tableNode = (headers, rows) => ({ tag: 'md', text: tableText(headers, rows) });

function validTable(text) {
  if (!text.startsWith('\n\n') || !text.endsWith('\n\n') || text.includes('\r')) return false;
  const lines = text.slice(2, -2).split('\n');
  if (lines.length < 2) return false;
  const headers = tableCells(lines[0]);
  if (!headers || lines[1] !== tableLine(headers.map(() => '---'))) return false;
  const rows = lines.slice(2).map(tableCells);
  if (rows.some(row => !row || row.length !== headers.length)) return false;
  // Re-parsing and re-sanitizing must produce exactly our generated subset.
  // Arbitrary md, raw tags, mentions, images, unsafe links and code fences fail.
  return [headers, ...rows].every(row => row.every(cell => tableCell(cell) === cell)) && tableText(headers, rows) === text;
}

function tableRecord(headers, cells) {
  const nodes = [];
  for (let index = 0; index < headers.length; index++) {
    if (index) nodes.push(prose('\n'));
    const label = headers[index] || `列${index + 1}`;
    nodes.push(...inline(tableBreaks(label), index === 0 ? ['bold'] : []), prose('：', index === 0 ? ['bold'] : []));
    nodes.push(...inline(tableBreaks(cells[index] ?? ''), index === 0 ? ['bold'] : []));
  }
  return nodes;
}

function tableBlocks(rawHeaders, rawRows, limit) {
  const width = Math.max(rawHeaders.length, ...rawRows.map(row => row.length));
  const labels = Array.from({ length: width }, (_, index) => rawHeaders[index] || `列${index + 1}`);
  const headers = labels.map(tableCell); const blocks = []; let chunk = [];
  const fits = rows => answerPostRequestBytes(postOf([[tableNode(headers, rows)]])) <= limit;
  const flush = () => { if (chunk.length) blocks.push([tableNode(headers, chunk)]); chunk = []; };
  if (!rawRows.length) return fits([]) ? [[tableNode(headers, [])]] : [tableRecord(labels, [])];
  for (const source of rawRows) {
    const values = Array.from({ length: width }, (_, index) => source[index] ?? '');
    const row = values.map(tableCell);
    if (!fits([row])) { flush(); blocks.push(tableRecord(labels, values)); continue; }
    if (!fits([...chunk, row])) flush();
    chunk.push(row);
  }
  flush(); return blocks;
}

function proseBlocks(text, limit) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []; const blocks = []; let ordinary = '';
  const flush = () => { if (ordinary) blocks.push(proseNodes(ordinary)); ordinary = ''; };
  for (let index = 0; index < lines.length; index++) {
    const headers = tableCells(lines[index]); const divider = index + 1 < lines.length ? tableCells(lines[index + 1]) : null;
    if (!headers || !divider || divider.length !== headers.length || !divider.every(cell => /^:?-{3,}:?$/.test(cell))) { ordinary += lines[index]; continue; }
    flush(); const rows = []; index += 2;
    for (; index < lines.length; index++) { const row = tableCells(lines[index]); if (!row) break; rows.push(row); }
    index--; blocks.push(...tableBlocks(headers, rows, limit));
  }
  flush(); return blocks;
}

export function answerPostRequestBytes(post) {
  // JSON escapes the content twice: once for the post and once for the body.
  return encoder.encode(JSON.stringify({ msg_type: 'post', content: JSON.stringify(post), uuid: '0'.repeat(50) })).length;
}

/** Validate and snapshot exactly the subset emitted by this renderer. */
export function serializeAnswerPost(post) {
  if (!post || typeof post !== 'object' || Array.isArray(post) || Object.keys(post).join() !== 'zh_cn') throw invalid();
  const body = post.zh_cn;
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.title !== '' || Object.keys(body).some(key => !['title', 'content'].includes(key)) || !Array.isArray(body.content) || !body.content.length) throw invalid();
  const rows = body.content.map(row => {
    if (!Array.isArray(row) || !row.length || (row.length > 1 && row.some(node => ['code_block', 'md'].includes(node?.tag)))) throw invalid();
    return row.map(node => {
      if (!node || typeof node !== 'object' || Array.isArray(node) || typeof node.text !== 'string' || !node.text.isWellFormed()) throw invalid();
      if (node.style !== undefined && (!Array.isArray(node.style) || node.style.length > 4 || node.style.some(value => !STYLES.has(value)))) throw invalid();
      if (node.tag === 'text') {
        if (node.un_escape !== false || Object.keys(node).some(key => !['tag', 'text', 'un_escape', 'style'].includes(key))) throw invalid();
        return prose(node.text, node.style ?? []);
      }
      if (node.tag === 'a') {
        const href = safeLink(node.href);
        if (!href || Object.keys(node).some(key => !['tag', 'text', 'href', 'style'].includes(key))) throw invalid();
        return { tag: 'a', text: node.text, href, ...styled(node.style ?? []) };
      }
      if (node.tag === 'md') {
        if (Object.keys(node).some(key => !['tag', 'text'].includes(key)) || !validTable(node.text)) throw invalid();
        return { tag: 'md', text: node.text };
      }
      if (node.tag !== 'code_block' || Object.keys(node).some(key => !['tag', 'text', 'language'].includes(key)) || (node.language !== undefined && !LANGUAGES.has(node.language))) throw invalid();
      return { tag: 'code_block', text: node.text, ...(node.language ? { language: node.language } : {}) };
    });
  });
  const snapshot = postOf(rows);
  if (answerPostRequestBytes(snapshot) > ANSWER_POST_REQUEST_LIMIT) throw new Error('飞书富文本正文超过分段大小限制');
  return JSON.stringify(snapshot);
}

function nodesOf(text, limit) {
  const nodes = [];
  let ordinary = ''; let code = ''; let opening = null;
  const flushProse = () => { if (ordinary) nodes.push(...proseBlocks(ordinary, limit)); ordinary = ''; };
  function flushCode() {
    const info = opening.info.trim();
    const first = info.split(/\s+/, 1)[0].toUpperCase();
    const language = ALIASES[first] ?? first;
    const supported = LANGUAGES.has(language);
    // Unknown labels are retained visibly without sending undocumented enum
    // values. Extra fence metadata is prose, never mixed into copyable code.
    if (info && (!supported || /\s/.test(info))) nodes.push([prose(`代码语言：${info}`)]);
    nodes.push([{ tag: 'code_block', text: code, ...(supported ? { language } : {}) }]);
    code = ''; opening = null;
  }
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const plain = line.replace(/\r?\n$/, '');
    if (opening) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(plain);
      if (closing && closing[1][0] === opening.marker[0] && closing[1].length >= opening.marker.length) flushCode();
      else code += line;
      continue;
    }
    const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(plain);
    if (match && !(match[1][0] === '`' && match[2].includes('`'))) {
      flushProse(); opening = { marker: match[1], info: match[2] };
    } else ordinary += line;
  }
  if (opening) flushCode();
  flushProse();
  return nodes;
}

/** Native post contents in source order; concatenate code node text losslessly. */
export function buildAnswerPosts(text, maxRequestBytes = ANSWER_POST_REQUEST_LIMIT) {
  if (typeof text !== 'string' || !text.trim() || text.length > 120_000) throw invalid();
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 512 || maxRequestBytes > ANSWER_POST_REQUEST_LIMIT) throw new Error('飞书富文本分段大小无效');
  const posts = []; let rows = [];
  const fits = node => answerPostRequestBytes(postOf([...rows.slice(0, -1), [...rows.at(-1), node]])) <= maxRequestBytes;
  const flush = () => { rows = rows.filter(row => row.length); if (rows.length) posts.push(postOf(rows)); rows = []; };
  for (const sourceRow of nodesOf(text.toWellFormed(), maxRequestBytes)) {
    rows.push([]);
    for (const node of sourceRow) {
      let remaining = node.text;
      while (true) {
        if (fits({ ...node, text: remaining })) { rows.at(-1).push({ ...node, text: remaining }); break; }
        if (rows.some(row => row.length)) { flush(); rows.push([]); continue; }
        if (node.tag === 'md') throw new Error('飞书表格未按完整行分段');
        let boundaries = [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(remaining)].map(({ index, segment }) => index + segment.length);
        if (!fits({ ...node, text: remaining.slice(0, boundaries[0]) })) {
          let offset = 0; boundaries = Array.from(remaining, point => (offset += point.length));
        }
        let low = 0; let high = boundaries.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (fits({ ...node, text: remaining.slice(0, boundaries[mid - 1]) })) low = mid;
          else high = mid - 1;
        }
        if (!low) throw new Error('飞书富文本正文无法按大小限制分段');
        let end = boundaries[low - 1];
        // Prefer whole code/prose lines. Very long individual lines still split
        // at grapheme boundaries without adding/removing a single code character.
        const newline = remaining.lastIndexOf('\n', end - 1) + 1;
        if (newline) end = newline;
        rows.at(-1).push({ ...node, text: remaining.slice(0, end) });
        remaining = remaining.slice(end); flush(); rows.push([]);
      }
    }
  }
  flush();
  return posts;
}
