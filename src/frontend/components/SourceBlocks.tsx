
import { memo } from 'react';
import { renderTexMathToText } from '../../core/markdown.mjs';
import { plainNodeNote } from '../../core/node-notes.mjs';
import { formatSentenceIndexes } from '../../core/source-ranges.mjs';
import { debugPerfBegin, debugPerfEnd } from '../lib/debug-log.mjs';





export function isSourceSpanAllowed(allowedSpanIds, span) {
  if (!allowedSpanIds) return true;
  if (!span) return false;
  return allowedSpanIds.has(sourceSpanKey(span));
}

export const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'async', 'await', 'break', 'class', 'continue',
  'def', 'elif', 'else', 'except', 'finally', 'for', 'from', 'if', 'import', 'in', 'is',
  'lambda', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
]);

export function sourceRangeForSpans(spans) {
  if (!spans?.length) return null;
  return {
    start: Math.min(...spans.map(sourceSpanAbsoluteStart)),
    end: Math.max(...spans.map(sourceSpanAbsoluteEnd))
  };
}

// 多 span 选区不能压成单一包络区间（spans 之间夹着别的节点的正文），
// 这里保留逐 span 的区间列表，只合并真正相邻/重叠的部分。
export function sourceRangesForSpans(spans) {
  const ranges = (spans || [])
    .map((span) => ({ start: sourceSpanAbsoluteStart(span), end: sourceSpanAbsoluteEnd(span) }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function sourceSpanAbsoluteStart(span) {
  return Number(span?.absolute_start_offset ?? span?.start_offset ?? 0);
}

export function sourceSpanAbsoluteEnd(span) {
  return Number(span?.absolute_end_offset ?? span?.end_offset ?? 0);
}

export function base64ToUint8Array(base64) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function SourceMarkdownBlockImpl({
  block,
  rawMarkdown,
  sourceSpans,
  selectedNodeId,
  onSentenceHover,
  selectSpan,
  resolvedImages,
  allowedSpanIds = null,
  nodeById = new Map(),
  showTitles = true,
  showNotes = false
}) {
  const blockSpans = sourceSpansForRange(sourceSpans, block.start, block.end)
    .filter((span) => isSourceSpanAllowed(allowedSpanIds, span));
  if (allowedSpanIds && blockSpans.length === 0) return null;
  const firstSpan = blockSpans.find((span) => span.node_id);
  const selected = blockSpans.some((span) => span.node_id === selectedNodeId);
  const addressLabel = formatSourceAddressLabel(blockSpans, nodeById);
  const sentenceLabel = formatSourceSentenceLabel(blockSpans);

  const textRange = (start, end, keyPrefix) => (
    <SourceTextRange
      key={keyPrefix}
      rawMarkdown={rawMarkdown}
      start={start}
      end={end}
      sourceSpans={sourceSpans}
      selectedNodeId={selectedNodeId}
      onSentenceHover={onSentenceHover}
      selectSpan={selectSpan}
      allowedSpanIds={allowedSpanIds}
      nodeById={nodeById}
      showTitles={showTitles}
      showNotes={showNotes}
    />
  );

  let body;
  if (block.type === 'heading') {
    const Tag = (`h${Math.min(block.level, 6)}`) as any;
    body = <Tag>{textRange(block.contentStart, block.contentEnd, 'heading')}</Tag>;
  } else if (block.type === 'paragraph') {
    body = (
      <p>
        {block.lines.map((line, index) => (
          <span key={`${line.start}-${line.end}`}>
            {index > 0 ? ' ' : ''}
            {textRange(line.start, line.end, `p-${index}`)}
          </span>
        ))}
      </p>
    );
  } else if (block.type === 'math') {
    body = (
      <div className="math-block">
        {renderMappedInlineToken({
          token: {
            type: 'math-display',
            start: block.start,
            end: block.end,
            value: block.text || rawMarkdown.slice(block.contentStart, block.contentEnd)
          },
          sourceSpans,
          selectedNodeId,
          onSentenceHover,
          selectSpan,
          allowedSpanIds,
          nodeById,
          showTitles,
          showNotes,
          key: `math-${block.start}`
        })}
      </div>
    );
  } else if (block.type === 'blockquote') {
    body = (
      <blockquote>
        {block.lines.map((line, index) => (
          <p key={`${line.start}-${line.end}`}>
            {index > 0 ? ' ' : ''}
            {textRange(line.start, line.end, `q-${index}`)}
          </p>
        ))}
      </blockquote>
    );
  } else if (block.type === 'list') {
    body = (
      <ul>
        {block.items.map((item, index) => (
          <li key={`${item.start}-${item.end}`}>{textRange(item.start, item.end, `li-${index}`)}</li>
        ))}
      </ul>
    );
  } else if (block.type === 'table') {
    body = (
      <SourceTableBlock
        block={block}
        rawMarkdown={rawMarkdown}
        sourceSpans={sourceSpans}
        selectedNodeId={selectedNodeId}
        onSentenceHover={onSentenceHover}
        selectSpan={selectSpan}
        allowedSpanIds={allowedSpanIds}
        nodeById={nodeById}
        showTitles={showTitles}
        showNotes={showNotes}
      />
    );
  } else if (block.type === 'image') {
    body = (
      <figure>
        <img src={resolvedImages[block.src] || block.src} alt={block.alt} />
        {block.alt ? <figcaption>{block.alt}</figcaption> : null}
      </figure>
    );
  } else if (block.type === 'code') {
    body = <pre><code>{block.text}</code></pre>;
  } else {
    body = null;
  }

  return (
    <section className={`source-block ${selected ? 'selected' : ''}`}>
      <button
        type="button"
        className="source-gutter-cell source-gutter-address"
        title={addressLabel || '无节点映射'}
        onClick={() => selectSpan(firstSpan)}
        disabled={!firstSpan}
      >
        {addressLabel}
      </button>
      <button
        type="button"
        className="source-gutter-cell source-gutter-sentence"
        title={sentenceLabel || '无句子映射'}
        onClick={() => selectSpan(firstSpan)}
        disabled={!firstSpan}
      >
        {sentenceLabel}
      </button>
      <div className="source-block-body">
        {body}
      </div>
    </section>
  );
}

// React.memo + 浅比较：滚动只切换 visibleBlocks 范围，视口内已渲染的 block
// 不再因 viewport.scrollTop 等变化重跑 sourceSpansForRange 等 O(N) 计算。
// 上游必须保证 sourceSpans/rawMarkdown/nodeById/allowedSpanIds/resolvedImages/onSentenceHover/selectSpan
// 这些 prop 的引用稳定（useMemo / useCallback）。
export const SourceMarkdownBlock = memo(SourceMarkdownBlockImpl);

export function SourceTableBlock({
  block,
  rawMarkdown,
  sourceSpans,
  selectedNodeId,
  onSentenceHover,
  selectSpan,
  allowedSpanIds = null,
  nodeById = new Map(),
  showTitles = true,
  showNotes = false
}) {
  const hasHeader = block.rows[1]?.separator === true;
  const headerRows = hasHeader ? [block.rows[0]] : [];
  const bodyRows = (hasHeader ? block.rows.slice(2) : block.rows).filter((row) => !row.separator);
  const renderCell = (cell, key) => (
    <SourceTextRange
      key={key}
      rawMarkdown={rawMarkdown}
      start={cell.start}
      end={cell.end}
      sourceSpans={sourceSpans}
      selectedNodeId={selectedNodeId}
      onSentenceHover={onSentenceHover}
      selectSpan={selectSpan}
      allowedSpanIds={allowedSpanIds}
      nodeById={nodeById}
      showTitles={showTitles}
      showNotes={showNotes}
    />
  );

  return (
    <table>
      {headerRows.length > 0 && (
        <thead>
          {headerRows.map((row, rowIndex) => (
            <tr key={`h-${rowIndex}`}>
              {row.cells.map((cell, cellIndex) => <th key={cellIndex}>{renderCell(cell, `h-${rowIndex}-${cellIndex}`)}</th>)}
            </tr>
          ))}
        </thead>
      )}
      <tbody>
        {bodyRows.map((row, rowIndex) => (
          <tr key={`b-${rowIndex}`}>
            {row.cells.map((cell, cellIndex) => <td key={cellIndex}>{renderCell(cell, `b-${rowIndex}-${cellIndex}`)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SourceTextRange({
  rawMarkdown,
  start,
  end,
  sourceSpans,
  selectedNodeId,
  onSentenceHover,
  selectSpan,
  allowedSpanIds = null,
  nodeById = new Map(),
  showTitles = true,
  showNotes = false
}) {
  const tokens = splitSourceRangeByInlineMarkdown(rawMarkdown, start, end);
  return tokens.map((token, index) => (
    token.type === 'text'
      ? renderSourceTextSegments({
        rawMarkdown,
        start: token.start,
        end: token.end,
        sourceSpans,
        selectedNodeId,
        onSentenceHover,
        selectSpan,
        allowedSpanIds,
        nodeById,
        showTitles,
        showNotes,
        keyPrefix: `${token.start}-${index}`
      })
      : renderMappedInlineToken({
        token,
        sourceSpans,
        selectedNodeId,
        onSentenceHover,
        selectSpan,
        allowedSpanIds,
        nodeById,
        showTitles,
        showNotes,
        key: `${token.start}-${index}`
      })
  ));
}

export function renderSourceTextSegments({
  rawMarkdown,
  start,
  end,
  sourceSpans,
  selectedNodeId,
  onSentenceHover,
  selectSpan,
  allowedSpanIds = null,
  nodeById = new Map(),
  showTitles = true,
  showNotes = false,
  keyPrefix
}) {
  const segments = splitSourceRangeBySpans(sourceSpans, start, end);
  return segments.map((segment, index) => {
    if (!isSourceSpanAllowed(allowedSpanIds, segment.span)) return null;
    const text = rawMarkdown.slice(segment.start, segment.end);
    return renderMappedSourceSpan({
      key: `${keyPrefix}-${segment.start}-${index}`,
      span: segment.span,
      selectedNodeId,
      onSentenceHover,
      selectSpan,
      appendNodeExtras: Boolean(segment.span && Number(segment.end) >= Number(segment.span.end_offset)),
      nodeById,
      showTitles,
      showNotes,
      children: text
    });
  });
}

export function renderMappedInlineToken({
  token,
  sourceSpans,
  selectedNodeId,
  onSentenceHover,
  selectSpan,
  allowedSpanIds = null,
  nodeById = new Map(),
  showTitles = true,
  showNotes = false,
  key
}) {
  const spans = sourceSpansForRange(sourceSpans, token.start, token.end);
  const span = spans.find((item) => item.node_id && isSourceSpanAllowed(allowedSpanIds, item)) ||
    spans.find((item) => isSourceSpanAllowed(allowedSpanIds, item)) ||
    null;
  if (!isSourceSpanAllowed(allowedSpanIds, span)) return null;
  const spanExtras = {
    nodeById,
    showTitles,
    showNotes,
    appendNodeExtras: Boolean(span && Number(token.end) >= Number(span.end_offset))
  };
  if (token.type === 'math-display' || token.type === 'math') {
    return renderMappedSourceSpan({
      key,
      span,
      selectedNodeId,
      onSentenceHover,
      selectSpan,
      ...spanExtras,
      className: token.type === 'math-display' ? 'math-inline math-display-inline' : 'math-inline',
      children: renderTexMathToText(token.value)
    });
  }
  if (token.type === 'strong') {
    return renderMappedSourceSpan({
      key,
      span,
      selectedNodeId,
      onSentenceHover,
      selectSpan,
      ...spanExtras,
      children: <strong>{token.value}</strong>
    });
  }
  if (token.type === 'code') {
    return renderMappedSourceSpan({
      key,
      span,
      selectedNodeId,
      onSentenceHover,
      selectSpan,
      ...spanExtras,
      children: <code>{token.value}</code>
    });
  }
  if (token.type === 'link') {
    return renderMappedSourceSpan({
      key,
      span,
      selectedNodeId,
      onSentenceHover,
      selectSpan,
      ...spanExtras,
      children: <a href={token.href || '#'} onClick={(event) => event.preventDefault()}>{token.value}</a>
    });
  }
  return renderMappedSourceSpan({
    key,
    span,
    selectedNodeId,
    onSentenceHover,
    selectSpan,
    ...spanExtras,
    children: token.raw
  });
}

export function renderMappedSourceSpan({
  key,
  span,
  selectedNodeId,
  onSentenceHover,
  selectSpan,
  className = '',
  appendNodeExtras = false,
  nodeById = new Map(),
  showTitles = true,
  showNotes = false,
  children
}) {
  if (!span) {
    return <span key={key} className={className || undefined}>{children}</span>;
  }
  const selected = selectedNodeId && span.node_id === selectedNodeId;
  const classes = ['source-sentence', className, selected ? 'selected' : '']
    .filter(Boolean)
    .join(' ');
  const extras = appendNodeExtras
    ? renderSourceNodeExtras({ span, nodeById, showTitles, showNotes, key: `${key}-extras` })
    : null;
  return (
    <span
      key={key}
      className={classes}
      data-sentence-index={span.sentence_index}
      onMouseEnter={() => onSentenceHover?.(span.sentence_index)}
      onMouseLeave={() => onSentenceHover?.(null)}
      onClick={(event) => {
        event.stopPropagation();
        selectSpan(span);
      }}
    >
      {children}
      {extras}
    </span>
  );
}

export function renderSourceNodeExtras({ span, nodeById, showTitles, showNotes, key }) {
  const node = span?.node_id ? nodeById.get(String(span.node_id)) : null;
  if (!node) return null;
  const title = String(node.title || '').trim();
  const note = plainNodeNote(node.note || '');
  if ((!showTitles || !title) && (!showNotes || !note)) return null;
  return (
    <span key={key} className="source-node-extra">
      {showTitles && title ? (
        <span className="source-node-extra-title">{renderInlineMarkdownText(title, `${key}-title`)}</span>
      ) : null}
      {showNotes && note ? (
        <span className="source-node-extra-note">
          <span className="source-node-extra-label">摘要备注</span>
          {renderInlineMarkdownText(note, `${key}-note`)}
        </span>
      ) : null}
    </span>
  );
}

export function splitSourceRangeBySpans(sourceSpans, start, end) {
  const overlaps = sourceSpansForRange(sourceSpans, start, end);
  const segments = [];
  let cursor = start;
  for (const span of overlaps) {
    const spanStart = Math.max(start, span.start_offset);
    const spanEnd = Math.min(end, span.end_offset);
    if (spanStart > cursor) segments.push({ start: cursor, end: spanStart, span: null });
    if (spanEnd > spanStart) segments.push({ start: spanStart, end: spanEnd, span });
    cursor = Math.max(cursor, spanEnd);
  }
  if (cursor < end) segments.push({ start: cursor, end, span: null });
  return segments;
}

export function splitSourceRangeByInlineMarkdown(rawMarkdown, start, end) {
  const source = String(rawMarkdown || '').slice(start, end);
  const pattern = /(\$\$[\s\S]+?\$\$|\*\*[\s\S]+?\*\*|`[^`]+`|\$[^$]+\$|\[[^\]]+\]\([^)]+\))/g;
  const tokens = [];
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) {
      tokens.push({ type: 'text', start: start + cursor, end: start + match.index });
    }
    const raw = match[0];
    const tokenStart = start + match.index;
    const tokenEnd = tokenStart + raw.length;
    if (raw.startsWith('$$')) {
      tokens.push({ type: 'math-display', start: tokenStart, end: tokenEnd, value: raw.slice(2, -2), raw });
    } else if (raw.startsWith('$')) {
      tokens.push({ type: 'math', start: tokenStart, end: tokenEnd, value: raw.slice(1, -1), raw });
    } else if (raw.startsWith('**')) {
      tokens.push({ type: 'strong', start: tokenStart, end: tokenEnd, value: raw.slice(2, -2), raw });
    } else if (raw.startsWith('`')) {
      tokens.push({ type: 'code', start: tokenStart, end: tokenEnd, value: raw.slice(1, -1), raw });
    } else {
      const link = raw.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      tokens.push({ type: 'link', start: tokenStart, end: tokenEnd, value: link?.[1] || raw, href: link?.[2] || '', raw });
    }
    cursor = match.index + raw.length;
  }
  if (cursor < source.length) tokens.push({ type: 'text', start: start + cursor, end });
  return tokens;
}

// 按 start_offset 升序排序后的 spans 索引，用 WeakMap 缓存——
// 同一个 sourceSpans 数组引用只构建一次。配合 useMemo 稳定引用即可生效。
const SPAN_INDEX_CACHE = new WeakMap();

function buildSpanIndex(spans) {
  // debug 模式下测 span 索引构建耗时（每个 sourceSpans 引用 WeakMap 只构建一次）
  const perfToken = debugPerfBegin('buildSpanIndex');
  const sorted = spans.slice().sort((a, b) => {
    const startDiff = (a.start_offset || 0) - (b.start_offset || 0);
    if (startDiff !== 0) return startDiff;
    return (a.sentence_index || 0) - (b.sentence_index || 0);
  });
  let maxLen = 0;
  for (const span of sorted) {
    const len = (span.end_offset || 0) - (span.start_offset || 0);
    if (len > maxLen) maxLen = len;
  }
  debugPerfEnd('buildSpanIndex', perfToken, { spans: spans.length, maxLen });
  return { sorted, maxLen };
}

function getSpanIndex(spans) {
  if (!spans || spans.length === 0) return null;
  let index = SPAN_INDEX_CACHE.get(spans);
  if (!index) {
    index = buildSpanIndex(spans);
    SPAN_INDEX_CACHE.set(spans, index);
  }
  return index;
}

export function sourceSpansForRange(sourceSpans, start, end) {
  const index = getSpanIndex(sourceSpans);
  if (!index) return [];
  const { sorted, maxLen } = index;
  // 任一与 [start, end) 重叠的 span 必须满足：start_offset < end 且 end_offset > start。
  // 因为 start_offset 已升序，且 span 长度最多 maxLen，所以候选的 start_offset 一定 >= start - maxLen。
  const lowerStart = Math.max(0, start - maxLen);
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid].start_offset || 0) < lowerStart) lo = mid + 1;
    else hi = mid;
  }
  const result = [];
  for (let i = lo; i < sorted.length; i += 1) {
    const span = sorted[i];
    const spanStart = span.start_offset || 0;
    if (spanStart >= end) break;
    if ((span.end_offset || 0) > start) result.push(span);
  }
  return result;
}

export function formatSourceAddressLabel(spans, nodeById = new Map()) {
  const addresses = spans
    .map((span) => span.node_address || nodeById.get(String(span.node_id))?.address)
    .filter(Boolean);
  if (addresses.length === 0) return '';
  const first = addresses[0];
  const last = addresses[addresses.length - 1];
  return first === last ? first : `${first}…${last}`;
}

export function formatSourceSentenceLabel(spans) {
  if (!spans.length) return '';
  const label = formatSentenceIndexes(spans.map((span) => span.sentence_index));
  return label ? `S${label}` : '';
}

export function renderInlineMarkdownText(text, keyPrefix) {
  const pattern = /(\$\$[^$]+\$\$|\*\*[^*]+\*\*|`[^`]+`|\$[^$]+\$|\[[^\]]+\]\([^)]+\))/g;
  const parts = [];
  let cursor = 0;
  for (const match of String(text || '').matchAll(pattern)) {
    if (match.index > cursor) parts.push(String(text).slice(cursor, match.index));
    const raw = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (raw.startsWith('**')) parts.push(<strong key={key}>{raw.slice(2, -2)}</strong>);
    else if (raw.startsWith('`')) parts.push(<code key={key}>{raw.slice(1, -1)}</code>);
    else if (raw.startsWith('$$')) parts.push(<span key={key} className="math-inline math-display-inline">{renderTexMathToText(raw.slice(2, -2))}</span>);
    else if (raw.startsWith('$')) parts.push(<span key={key} className="math-inline">{renderTexMathToText(raw.slice(1, -1))}</span>);
    else {
      const link = raw.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      parts.push(
        <a key={key} href={link?.[2] || '#'} onClick={(event) => event.preventDefault()}>
          {link?.[1] || raw}
        </a>
      );
    }
    cursor = match.index + raw.length;
  }
  if (cursor < String(text || '').length) parts.push(String(text).slice(cursor));
  return parts;
}

export function parseSourceNodeText(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const first = lines[0]?.trim() || '';
  const labelOnly = first.match(/^(L\d+(?:-L\d+)?)$/);
  if (labelOnly) {
    const codeLines = lines.slice(1);
    return {
      lineLabel: labelOnly[1],
      codeLines: codeLines.length > 0 ? codeLines : ['']
    };
  }

  const inlineLabel = first.match(/^(L\d+(?:-L\d+)?)\s+(.+)$/);
  if (inlineLabel) {
    return {
      lineLabel: inlineLabel[1],
      codeLines: [inlineLabel[2], ...lines.slice(1)]
    };
  }

  return {
    lineLabel: null,
    codeLines: lines.length > 0 ? lines : ['']
  };
}

export function renderSyntaxLine(line, keyPrefix) {
  const value = String(line ?? '');
  if (!value) return <span className="tok-space">&nbsp;</span>;
  const chunks = [...value.matchAll(/(#.*$|[fFrRbBuU]*"(?:\\.|[^"\\])*"|[fFrRbBuU]*'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b|[()[\]{}:.,+\-*/%=<>!&|^~]+|\s+|.)/g)]
    .map((match) => match[0]);

  return chunks.map((raw, index) => {
    let className = 'tok-plain';
    if (raw.startsWith('#')) className = 'tok-comment';
    else if (/^[fFrRbBuU]*["']/.test(raw)) className = 'tok-string';
    else if (/^\d/.test(raw)) className = 'tok-number';
    else if (PYTHON_KEYWORDS.has(raw)) className = 'tok-keyword';
    else if (/^[()[\]{}:.,+\-*/%=<>!&|^~]+$/.test(raw)) className = 'tok-operator';
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) {
      const previousWord = previousIdentifier(chunks, index);
      const nextMeaningful = nextToken(chunks, index);
      if (previousWord === 'def' || nextMeaningful === '(') className = 'tok-function';
      else if (/^[A-Z]/.test(raw) || previousWord === 'class') className = 'tok-type';
    }
    return <span key={`${keyPrefix}-${index}`} className={className}>{raw}</span>;
  });
}

export function previousIdentifier(tokens, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (!token || /^\s+$/.test(token)) continue;
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token) ? token : null;
  }
  return null;
}

export function nextToken(tokens, index) {
  for (let i = index + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || /^\s+$/.test(token)) continue;
    return token;
  }
  return null;
}

export function sourceSpanKey(span) {
  return span?.id ?? `${span?.sentence_index}:${span?.start_offset}:${span?.end_offset}`;
}
