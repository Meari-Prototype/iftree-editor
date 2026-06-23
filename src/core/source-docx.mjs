import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';

import { attr, xmlUnescape } from './source-text-utils.mjs';
import { createSpanAccumulator, addSentenceContainer } from './source-spans.mjs';

// DOCX 结构解析（只解析原生排版结构、不做语义解析）。结构信号全部来自 Word XML 里客观存在的、作者主动
// 施加的格式标记，按优先级：① 段落大纲级 <w:outlineLvl>；② Heading/标题 样式；③ 字号——以全文字号
// 众数为正文基线，比众数大的独立短段视为标题（越大级越高），等于众数是正文、小于众数是备注。
// 绝不从文字内容猜结构（不识别「第三章」「1.2.3」「（一）」这类 pattern——那是语义解析，交给 LLM / 直接导入兜底）。
// 表格整块转成原生 markdown 表格语法当一个正文节点；表格内容不参与字号众数与标题判定。
// 产出与 chm/epub 同构的带 address 层级 records，不再借道 markdown 中间层。

const TYPO_HEADING_MAX_LEN = 100; // 字号档标题的「短段」上限（按码点计的纯长度特征，不看文字内容）

export function readDocxSourceDocument(filePath, options = {}) {
  const zip = unzipSync(readFileSync(filePath));
  const decoder = new TextDecoder('utf-8');
  const documentEntry = zip['word/document.xml'];
  if (!documentEntry) throw new Error('DOCX 导入失败：未找到 word/document.xml');

  const styles = parseStyles(zip, decoder);
  const items = parseBody(decoder.decode(documentEntry), styles.baseSize);
  const hasContent = items.some((item) => ('markdown' in item ? Boolean(item.markdown) : Boolean(item.text)));
  if (!hasContent) throw new Error('DOCX 导入失败：未读取到正文');

  return docxItemsToSourceDocument(items, styles, filePath, options);
}

// —— 样式表：样式名（判 Heading 级）、样式大纲级、docDefaults 默认字号（无显式字号字符的兜底字号）——

function parseStyles(zip, decoder) {
  const names = new Map();
  const outlineLvls = new Map();
  const entry = zip['word/styles.xml'];
  if (!entry) return { names, outlineLvls, baseSize: null };

  const stylesXml = decoder.decode(entry);
  for (const match of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const styleId = attr(match[1], 'w:styleId') || attr(match[1], 'styleId');
    if (!styleId) continue;
    const body = match[2];
    const styleName = body.match(/<w:name\b([^>]*)\/?>/i);
    if (styleName) {
      const value = attr(styleName[1], 'w:val') || attr(styleName[1], 'val');
      if (value) names.set(styleId, value);
    }
    const outline = body.match(/<w:outlineLvl\b[^>]*w:val="(\d+)"/i);
    if (outline) outlineLvls.set(styleId, Number(outline[1]));
  }

  const baseMatch = stylesXml.match(/<w:docDefaults>[\s\S]*?<w:rPrDefault>[\s\S]*?<w:sz\b[^>]*w:val="(\d+)"/i);
  return { names, outlineLvls, baseSize: baseMatch ? Number(baseMatch[1]) : null };
}

// —— body 顺序扫描：顶层段落 <w:p> 与表格 <w:tbl> 交替；表格整块吃掉、其内段落不散出 ——

function parseBody(documentXml, baseSize) {
  const items = [];
  let blockIndex = 0; // document.xml 里 <w:p>/<w:tbl> 的全局序号（含会被跳过的块）——word 块锚点对齐 docx-preview 全量 DOM 的基准。
  for (const match of documentXml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b(?:\/>|[^>]*>[\s\S]*?<\/w:p>)/g)) {
    const block = match[0];
    if (block.startsWith('<w:tbl')) {
      const markdown = tableToMarkdown(block);
      if (markdown) items.push({ type: 'table', markdown, blockIndex });
    } else {
      items.push({ ...parseParagraph(block, baseSize), blockIndex });
    }
    blockIndex += 1;
  }
  return items;
}

function parseParagraph(paragraphXml, baseSize) {
  const pPr = paragraphXml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/i)?.[0] || '';
  const pStyle = pPr.match(/<w:pStyle\b([^>]*)\/?>/i)?.[1] || '';
  const styleId = attr(pStyle, 'w:val') || attr(pStyle, 'val') || '';
  const outlineLvl = pPr.match(/<w:outlineLvl\b[^>]*w:val="(\d+)"/i)?.[1];
  const paragraphDefaultSize = sizeOf(pPr.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/i)?.[0] || '');

  const textParts = [];
  const charsBySize = new Map(); // 有效字号 → 字符数（求全文众数 / 段落主字号用）
  for (const runMatch of paragraphXml.matchAll(/<w:r\b(?:\/>|[^>]*>[\s\S]*?<\/w:r>)/g)) {
    const runText = docxRunText(runMatch[0]);
    if (!runText) continue;
    textParts.push(runText);
    const size = sizeOf(runMatch[0].match(/<w:rPr\b[\s\S]*?<\/w:rPr>/i)?.[0] || '') ?? paragraphDefaultSize ?? baseSize;
    if (size != null) charsBySize.set(size, (charsBySize.get(size) || 0) + [...runText].length);
  }

  return {
    type: 'paragraph',
    text: textParts.join('').trim(),
    styleId,
    outlineLvl: outlineLvl != null ? Number(outlineLvl) : null,
    charsBySize,
    dominantSize: dominantKey(charsBySize)
  };
}

function sizeOf(rPrXml) {
  const size = rPrXml.match(/<w:sz\b[^>]*w:val="(\d+)"/i);
  return size ? Number(size[1]) : null;
}

function dominantKey(charsBySize) {
  let best = null;
  let bestCount = -1;
  for (const [size, count] of charsBySize) {
    if (count > bestCount) {
      bestCount = count;
      best = size;
    }
  }
  return best;
}

function docxRunText(runXml) {
  const parts = [];
  const tokenPattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g;
  for (const match of runXml.matchAll(tokenPattern)) {
    if (match[0].startsWith('<w:tab')) parts.push('\t');
    else if (match[0].startsWith('<w:br')) parts.push('\n');
    else parts.push(xmlUnescape(match[1]));
  }
  return parts.join('');
}

// —— 表格 → 原生 markdown 表格（首行当表头 + 分隔行）——

function tableToMarkdown(tableXml) {
  const rows = [];
  for (const rowMatch of tableXml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
    const cells = [];
    for (const cellMatch of rowMatch[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)) {
      cells.push(tableCellText(cellMatch[0]));
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return '';

  const columnCount = Math.max(...rows.map((row) => row.length));
  const pad = (row) => {
    const filled = [...row];
    while (filled.length < columnCount) filled.push('');
    return filled;
  };
  const lines = [`| ${pad(rows[0]).join(' | ')} |`, `| ${Array(columnCount).fill('---').join(' | ')} |`];
  for (const row of rows.slice(1)) lines.push(`| ${pad(row).join(' | ')} |`);
  return lines.join('\n');
}

function tableCellText(cellXml) {
  const parts = [];
  for (const paragraphMatch of cellXml.matchAll(/<w:p\b(?:\/>|[^>]*>[\s\S]*?<\/w:p>)/g)) {
    for (const runMatch of paragraphMatch[0].matchAll(/<w:r\b(?:\/>|[^>]*>[\s\S]*?<\/w:r>)/g)) {
      parts.push(docxRunText(runMatch[0]));
    }
    parts.push(' ');
  }
  // 单元格内不能有换行/裸竖线，否则破坏 markdown 表格；折叠空白、转义竖线。
  return parts.join('').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

// —— 标题判定：outlineLvl > Heading 样式 > 字号（> 众数 + 独立短段）；全程不看文字内容 ——

function classifyParagraph(paragraph, styles, bodySize) {
  if (isDocxTocParagraph(paragraph.styleId) || !paragraph.text) return { kind: 'skip' };

  const outline = paragraph.outlineLvl ?? styles.outlineLvls.get(paragraph.styleId);
  if (outline != null && Number.isFinite(outline)) return { kind: 'heading', level: outline + 1 };

  const styleLevel = docxHeadingLevel(paragraph.styleId, styles.names);
  if (styleLevel > 0) return { kind: 'heading', level: styleLevel };

  if (bodySize != null
    && paragraph.dominantSize != null
    && paragraph.dominantSize > bodySize
    && [...paragraph.text].length < TYPO_HEADING_MAX_LEN) {
    return { kind: 'sized' };
  }
  return { kind: 'body' };
}

function docxHeadingLevel(styleId, styleNames) {
  const candidates = [styleId, styleNames.get(styleId)].filter(Boolean);
  for (const candidate of candidates) {
    const normalized = String(candidate || '').replace(/\s+/g, '').toLowerCase();
    const numbered = normalized.match(/(?:heading|标题)([1-6])$/i);
    if (numbered) return Number(numbered[1]);
    if (/^[1-6]$/.test(normalized)) return Number(normalized);
    if (normalized === 'title' || normalized === '标题') return 1;
  }
  return 0;
}

// TOC1/TOC2 是 Word 目录段落样式 id —— 格式原生信号，不是语义猜测。
function isDocxTocParagraph(styleId) {
  return String(styleId || '').toLowerCase().startsWith('toc');
}

// —— body 字号众数：仅统计正文段落（表格不计），按字符加权 ——

function computeBodySize(items) {
  const weights = new Map();
  for (const item of items) {
    if (item.type !== 'paragraph') continue;
    for (const [size, count] of item.charsBySize) weights.set(size, (weights.get(size) || 0) + count);
  }
  return dominantKey(weights);
}

// —— 段落/表格 → 层级 records（结构与 chm/epub 同构；本模块自带装配原语，与其它格式解析互不影响）——

function docxItemsToSourceDocument(items, styles, sourcePath, options = {}) {
  const granularity = options.granularity === 'sentence' ? 'sentence' : 'paragraph';
  const bodySize = computeBodySize(items);
  const classified = items.map((item) => (item.type === 'table'
    ? { item, info: { kind: 'table' } }
    : { item, info: classifyParagraph(item, styles, bodySize) }));

  // 字号档标题没有自带级数：按字号给级——字号越大级越高（众数之上的最大字号 = 第 1 级）。
  const sizedSizes = [...new Set(classified
    .filter((entry) => entry.info.kind === 'sized')
    .map((entry) => entry.item.dominantSize))].sort((a, b) => b - a);
  const sizedLevelOf = (size) => sizedSizes.indexOf(size) + 1;

  const records = [];
  const acc = createSpanAccumulator(); // 载体重建 + 句位 spans（取代本地 rawParts/rawOffset/appendRawText）
  const counters = new Map();
  const stack = [];

  function nextAddress(parentAddress) {
    const key = parentAddress || '';
    const next = (counters.get(key) || 0) + 1;
    counters.set(key, next);
    return key ? `${key}-${next}` : String(next);
  }

  function addRecord(parentAddress, text, role, recordOptions = {}) {
    const indexes = Array.isArray(recordOptions.indexes) ? recordOptions.indexes : acc.appendSegment(text);
    if (!indexes?.length) return null;
    const index = indexes[0];
    const address = nextAddress(parentAddress);
    const record = {
      address,
      text: String(text || '').trim(),
      nodeType: 'TEXT',
      sourcePosition: recordOptions.sourcePosition ?? index,
      index,
      role,
      vector: null
    };
    if (indexes.length > 1) record.indexes = indexes;
    if (recordOptions.skipVector) record.skipVector = true;
    records.push(record);
    return record;
  }

  function addBody(text, parentAddress) {
    if (granularity === 'sentence') {
      addSentenceContainer({ acc, addRecord, parentAddress, text, rolePrefix: 'docx' });
    } else {
      addRecord(parentAddress, text, 'docx-paragraph');
    }
  }

  const docBlocks = []; // 每个 XML 块 → 它在重建文本的偏移范围 + 全局序号（word 块锚点；字符 i 靠它定位回原文）
  for (const { item, info } of classified) {
    if (info.kind === 'skip') continue;
    const parentAddress = stack.at(-1)?.address || '';
    const spansBefore = acc.spans.length;
    if (info.kind === 'table') {
      addRecord(parentAddress, item.markdown, 'docx-table');
    } else if (info.kind === 'body') {
      addBody(item.text, parentAddress);
    } else {
      const level = info.kind === 'sized' ? sizedLevelOf(item.dominantSize) : info.level;
      while (stack.length > 0 && stack.at(-1).level >= level) stack.pop();
      const heading = addRecord(stack.at(-1)?.address || '', item.text, 'docx-heading');
      if (heading) stack.push({ level, address: heading.address });
    }
    // 这块产出的 spans 区间 = 它在重建文本的偏移范围；item.blockIndex 是 document.xml 全局块序号。
    const newSpans = acc.spans.slice(spansBefore);
    if (newSpans.length > 0) {
      docBlocks.push({
        block_index: item.blockIndex,
        start_offset: newSpans[0].start_offset,
        end_offset: newSpans[newSpans.length - 1].end_offset
      });
    }
  }

  const { rawText, spans } = acc.finalize();
  return {
    sourcePath,
    sourceType: 'docx',
    structureSource: 'docx',
    intermediateFormat: null,
    rawText,
    rawMarkdown: rawText,
    spans,
    docBlocks,
    records,
    tocItemCount: records.filter((record) => record.role === 'docx-heading').length
  };
}
