import { readFileSync } from 'node:fs';
import { normalizeStableId, isStableId } from './db/ids.mjs';
import { runImportJson } from './import-json.mjs';
import { normalizeNodeType, nodeTypeDisplayLabel } from '../core/node-model.mjs';
import { formatBranchLine } from './branch-status.mjs';

function cleanLine(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clip(value = '', limit = 80) {
  const text = cleanLine(value);
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

const READ_SUBTREE_TEXT_LIMIT = 10000;

function normalizeShellDocId(value, fallback = null) {
  return normalizeStableId(value, fallback);
}

// 去掉命中行/组头里的 doc: 前缀，取裸 doc 标识。
function bareDocRef(value = '') {
  const raw = cleanLine(value);
  return raw.startsWith('doc:') ? raw.slice(4).trim() : raw;
}

// 把用户/agent 传入的 doc 标识解析为真实 docId：合法 UUIDv7 直接用；否则按文档标题精确匹配——
// 唯一命中返回其 docId，重名报冲突并列出候选 UUID，无命中报未找到。
// 让 read/tree 等默认用标题下钻：库内标题唯一时 UUID 完全不必出现，只有重名才被逼出来。
export async function resolveDocRef(database, input, { allowMissing = false } = {}) {
  const bare = bareDocRef(input);
  if (!bare) {
    if (allowMissing) return null;
    throw new Error('需要 doc 标识（文档标题或 doc:UUID）');
  }
  if (isStableId(bare)) return bare;
  const listed = await database.run({ operation: 'read', payload: { action: 'doc.list' } }, 'read');
  const docs = Array.isArray(listed) ? listed : (listed?.rows || listed?.docs || []);
  const target = cleanLine(bare);
  const matches = docs.filter((doc) => cleanLine(doc.title ?? doc.doc_title ?? '') === target);
  if (matches.length === 1) return String(matches[0].id ?? matches[0].docId ?? matches[0].doc_id);
  if (matches.length === 0) {
    if (allowMissing) return null;
    throw new Error(`未找到文档「${bare}」（按标题精确匹配）。用 library_index / find 查看可用文档，或改用 doc:UUID。`);
  }
  const candidates = matches.map((doc) => `doc:${doc.id ?? doc.docId ?? doc.doc_id}`).join('  ');
  throw new Error(`文档标题「${bare}」重名（${matches.length} 个），无法用标题定位，请改用其中之一的 UUID：${candidates}`);
}

function parseValue(value) {
  const raw = String(value ?? '').trim();
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

function normalizeArgv(argv = []) {
  const source = Array.isArray(argv) ? argv.map((item) => String(item)) : [];
  return source[0] === 'db' ? source.slice(1) : source;
}

function parseFlags(argv = []) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name === 'scope') {
      const docId = argv[index + 1];
      const address = argv[index + 2];
      if (!docId || !address || docId.startsWith('--') || address.startsWith('--')) {
        throw new Error('db --scope requires <doc_id> <node_address>');
      }
      flags.scopeDocId = parseValue(docId);
      flags.scopeAddress = address;
      index += 2;
      continue;
    }
    if (name === 'depth' || name === 'limit' || name === 'timeout-ms' || name === 'char-limit') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`db --${name} requires a value`);
      flags[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = parseValue(value);
      index += 1;
      continue;
    }
    if (name === 'summary' || name === 'tag') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        flags[name] = true;
        continue;
      }
      flags[name] = value;
      index += 1;
      continue;
    }
    if (['branch', 'base', 'owner', 'history', 'source-branch', 'target-branch', 'target-base', 'entry-id', 'entry-index', 'mode', 'doc-id', 'session-id', 'set', 'insert', 'cwd', 'at', 'state', 'agent', 'workspace', 'kind', 'trust', 'since', 'until', 'match-mode', 'exclude-folder', 'sections', 'range', 'start', 'before', 'spans-limit', 'node-id', 'min-score'].includes(name)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`db --${name} requires a value`);
      flags[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = parseValue(value);
      index += 1;
      continue;
    }
    if (name === 'folder') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('db --folder requires a library relative path');
      flags.folder = value;
      index += 1;
      continue;
    }
    if (name === 'from' || name === 'to') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`db --${name} requires a value`);
      flags[name] = value;
      index += 1;
      continue;
    }
    if (['tags', 'all-docs', 'all', 'or', 'semantic', 'yes', 'detail', 'delete', 'uuid', 'dry-run', 'allow-gaps', 'vectors', 'force', 'labels', 'spans', 'json', 'node', 'at-address'].includes(name)) {
      flags[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true;
      continue;
    }
    if (name === 'fuzzy') throw new Error('db find --fuzzy is not supported; use db find --tags to expand related entities.');
    throw new Error(`Unknown db option: --${name}`);
  }
  return { flags, positional };
}

function parseLooseFlags(argv = [], valueFlagNames = []) {
  const flags = {};
  const positional = [];
  const valueFlags = new Set(valueFlagNames);
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--') {
      positional.push(...argv.slice(index + 1).map((item) => String(item)));
      break;
    }
    const name = token.startsWith('--') ? token.slice(2) : '';
    if (valueFlags.has(name)) {
      const value = argv[index + 1];
      if (!value || String(value).startsWith('--')) throw new Error(`db --${name} requires a value`);
      flags[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = parseValue(value);
      index += 1;
      continue;
    }
    positional.push(token);
  }
  return { flags, positional };
}

function currentDocIdFrom(context = {}) {
  return normalizeShellDocId(context.currentDocId ?? context.docId ?? process.env.IFTREE_CURRENT_DOC_ID, null);
}

function docScope(flags = {}, context = {}, options = {}) {
  if (flags.allDocs) return { allDocs: true };
  const scopedDocId = normalizeShellDocId(flags.scopeDocId, null);
  if (scopedDocId) return { docId: scopedDocId, scopeDocId: scopedDocId, scopeAddress: flags.scopeAddress || '' };
  const currentDocId = currentDocIdFrom(context);
  if (currentDocId) return { docId: currentDocId };
  if (options.allowMissing) return {};
  throw new Error('db command requires current document id, --scope, or --all-docs');
}

function nodeTitle(node = {}) {
  return clip(node.title || node.textPreview || node.text || '', 80);
}

// find 命中行的内容预览：标题后拼接正文、共截 30 字——无标题/短标题能带出一部分正文开头，
// 标题长则只显示标题。比单显 title（会话卷里 title 就是「用户/助手」角色名、会遮蔽正文）更利于挑候选。
function hitContentPreview(node = {}) {
  const title = cleanLine(node.title || '');
  const body = cleanLine(node.textPreview || node.text || '');
  const combined = title ? (body && body !== title ? `${title} ${body}` : title) : body;
  return clip(combined, 30);
}

function nodeTypeLabel(node = {}) {
  return nodeTypeDisplayLabel(node.type || node.nodeType || node.node_type || 'TEXT');
}

function nodeTrustLabel(node = {}) {
  const trust = node.tags?.trustLevel ?? node.trustLevel ?? node.trust_level ?? null;
  return `trust:${trust == null || trust === '' ? 'null' : cleanLine(trust)}`;
}

function docDisplayLabel(doc = {}, options = {}) {
  const docId = doc.docId ?? doc.doc_id ?? doc.id ?? options.docId ?? '';
  if (options.uuid) return docId ? `doc:${docId}` : '';
  return cleanLine(doc.title || doc.docTitle || doc.doc_title || doc.name || options.title || '') || (docId ? `doc:${docId}` : '');
}

function formatNodeLine(item = {}, options = {}) {
  const node = item.node || item;
  const docId = item.doc?.docId ?? item.doc?.id ?? node.docId ?? node.doc_id;
  const label = options.omitDocLabel ? '' : docDisplayLabel(item.doc || node.doc || {
    docId,
    title: options.docLabel ?? item.docTitle ?? item.doc_title ?? node.docTitle ?? node.doc_title
  }, { uuid: options.uuid, docId });
  const score = options.score ?? node.score ?? item.score ?? null;
  const parts = [label, node.address || '', nodeTypeLabel(node), hitContentPreview(node)];
  if (score != null) {
    // 字面命中(hit:命中词数，整数)与语义相似度(sim:0~1)两套量纲，加前缀消歧；无 scoreKind 时保持裸值兼容旧调用。
    if (options.scoreKind === 'sim') parts.push(`sim:${Number(score).toFixed(2)}`);
    else if (options.scoreKind === 'hit') parts.push(`hit:${Math.round(Number(score))}`);
    else parts.push(Number(score).toFixed(2));
  }
  // find --labels（opt-in）：命中行带节点信任标，便于一眼分受控/不受控。
  if (options.labels) parts.push(nodeTrustLabel(node));
  // 召回结果必须附带时间元数据（projectneed 15-12-6）：命中行尾缀更新时间。
  const updated = node.updatedAt || node.updated_at || null;
  if (updated) parts.push(`upd:${String(updated).replace(' ', 'T')}`);
  return parts.filter(Boolean).join(' ');
}

// find 命中按文档分组：文档标识（标题/docId）只在组头出一次，组内行省略 doc label，
// 消除每行重复 doc 标签的 token 开销，并让外部调用方从组头一次拿到下钻所需的 doc 标识。
// 单文档检索传 fallbackDocId/fallbackTitle 兜底（命中行不自带 doc 信息时用它）。
// 本次结果内出现同名文档（或显式 --uuid）时，组头带 doc:UUID 消歧。
function formatGroupedHits(rows = [], options = {}) {
  const groups = new Map();
  const order = [];
  for (const row of rows) {
    const node = row.node || row;
    const docId = String(row.doc?.docId ?? row.doc?.id ?? node.docId ?? node.doc_id ?? options.fallbackDocId ?? '');
    const title = cleanLine(row.doc?.title ?? row.doc?.doc_title ?? row.docTitle ?? node.doc?.title ?? node.docTitle ?? options.fallbackTitle ?? '');
    const key = docId || title;
    if (!groups.has(key)) {
      groups.set(key, { docId, title, kind: row.doc?.kind ?? null, lines: [] });
      order.push(key);
    }
    groups.get(key).lines.push(formatNodeLine(row, { ...options, omitDocLabel: true }));
  }
  const titleCounts = new Map();
  for (const key of order) {
    const { title } = groups.get(key);
    if (title) titleCounts.set(title, (titleCounts.get(title) || 0) + 1);
  }
  const lines = [];
  for (const key of order) {
    const group = groups.get(key);
    const ambiguous = Boolean(options.uuid) || (group.title && titleCounts.get(group.title) > 1);
    const head = group.title
      ? (ambiguous && group.docId ? `[doc:${group.docId} | ${group.title}]` : `[${group.title}]`)
      : (group.docId ? `[doc:${group.docId}]` : '[?]');
    const kindTag = options.labels && group.kind ? ` ·${searchKindLabel(group.kind)}` : '';
    lines.push(`${head}${kindTag}`);
    for (const line of group.lines) lines.push(line ? `  ${line}` : '  ');
  }
  return lines.join('\n');
}

// find --labels 的层级中文名（三层时态）。
function searchKindLabel(kind) {
  if (kind === 'event') return '事件卷';
  if (kind === 'memory') return '核心记忆';
  if (kind === 'knowledge') return '知识';
  return String(kind || '');
}

// 检索范围的人读描述（统计行用）：单篇 / 全库 / folder + 各过滤维度。
function searchScopeDescriptor(flags = {}, scope = {}) {
  const parts = [];
  if (scope.docId && !scope.allDocs) parts.push('单篇');
  else if (flags.folder) parts.push(`folder:${flags.folder}`);
  else parts.push('全库');
  if (flags.excludeFolder) parts.push(`排除folder:${flags.excludeFolder}`);
  if (flags.kind) parts.push(`kind:${flags.kind}`);
  if (flags.workspace) parts.push(`ws:${flags.workspace}`);
  if (flags.trust) parts.push(`trust:${flags.trust}`);
  if (flags.since || flags.until) parts.push(`time:${flags.since || ''}~${flags.until || ''}`);
  return parts.join(' ');
}

// find 返回统计行：让命中数/范围一目了然，尤其让"0 命中"能区分范围空 vs 范围内没命中。
function findStatsLine(result = {}, scopeDesc = '') {
  const returned = Number(result.returned ?? (result.rows?.length || 0)) || 0;
  const total = Number(result.total) || returned;
  const docs = new Set((result.rows || []).map((row) => String(row.doc?.docId ?? row.doc?.id ?? '')).filter(Boolean)).size;
  const scopeDocs = result.scopeDocs;
  const coverage = scopeDocs != null ? `，范围内可检索 ${scopeDocs} 篇` : '';
  if (returned === 0) {
    return `— 0 命中（范围：${scopeDesc}${coverage}）；可拆词 / 调 kind/folder / 用 library_index 看目录`;
  }
  const more = total > returned ? `，共 ${total}（已截 ${returned}）` : '';
  return `— 命中 ${returned} 节点 / ${docs} 文档${more}（范围：${scopeDesc}${coverage}）`;
}

function formatEntityLabel(entity = {}, options = {}) {
  const literal = cleanLine(entity.literal || entity.term || '');
  const label = docDisplayLabel(entity.doc || entity, {
    uuid: options.uuid,
    docId: entity.docId ?? entity.doc_id
  });
  return literal ? `${literal}${label ? `(${label})` : ''}` : '';
}

function formatEntityTags(rows = [], options = {}) {
  const synonym = [];
  const related = [];
  for (const row of rows) {
    const label = formatEntityLabel(row.entity || row, options);
    if (!label) continue;
    if (row.relation === 'synonym') synonym.push(label);
    else related.push(label);
  }
  return [
    synonym.length ? `同义: ${synonym.join('；')}` : '',
    related.length ? `相关: ${related.join('；')}` : ''
  ].filter(Boolean).join('\n');
}

function formatHistoryLine(row = {}) {
  const commit = row.id ?? row.commit_id ?? row.commitId ?? '';
  const savedAt = row.committed_at ?? row.committedAt ?? row.saved_at ?? row.savedAt ?? '';
  const author = row.author ?? row.owner ?? '';
  const summary = cleanLine(row.summary || '');
  const parts = [`commit:${commit}`];
  if (savedAt) parts.push(savedAt);
  if (author) parts.push(`@${author}`);
  if (summary) parts.push(summary);
  return parts.filter(Boolean).join(' ');
}

function historyRefSpec(flags = {}, positional = []) {
  const flaggedDocId = normalizeShellDocId(flags.docId ?? positional[0], null);
  if (flags.history) return { kind: 'id', value: flags.history, docId: flaggedDocId };
  if (flags.at) return { kind: 'committed_at', value: flags.at, docId: flaggedDocId };
  if (flags.tag && flags.tag !== true) return { kind: 'summary', value: flags.tag, docId: flaggedDocId };
  const ref = String(positional[0] || '').trim();
  const docId = normalizeShellDocId(flags.docId ?? positional[1], null);
  if (!ref) return { kind: '', value: '', docId };
  if (isStableId(ref)) return { kind: 'id', value: ref, docId };
  return { kind: 'committed_at_or_summary', value: ref, docId };
}

async function resolveHistoryRef(database, spec = {}, options = {}) {
  const value = String(spec.value ?? '').trim();
  if (!value) throw new Error('history ref requires history id, saved_at, or tag');

  const clauses = [];
  const params = {};
  if (spec.kind === 'id') {
    clauses.push('id = @value');
    params.value = value;
  } else if (spec.kind === 'committed_at') {
    clauses.push('committed_at = @value');
    params.value = value;
  } else if (spec.kind === 'summary') {
    clauses.push('summary = @value');
    params.value = value;
  } else if (spec.kind === 'committed_at_or_summary') {
    clauses.push('(committed_at = @value OR summary = @value)');
    params.value = value;
  } else {
    throw new Error(`db restore unsupported ref kind: ${spec.kind || '(empty)'}`);
  }
  if (spec.docId) {
    clauses.push('doc_id = @docId');
    params.docId = spec.docId;
  }
  const columns = options.includeDiff
    ? 'id, doc_id, committed_at, summary, diff, snapshot'
    : 'id, doc_id, committed_at, summary';
  const sql = `
    SELECT ${columns}
    FROM commits
    WHERE ${clauses.join(' AND ')}
    ORDER BY committed_at DESC, id DESC
  `;
  const result = await database.run({
    operation: 'read',
    payload: { action: 'debug.sql', sql, params, limit: 2 }
  }, 'read');
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  if (rows.length === 0) {
    const scope = spec.docId ? ` in doc ${spec.docId}` : '';
    throw new Error(`db restore history ref not found${scope}: ${value}`);
  }
  if (rows.length > 1) {
    throw new Error(`db restore history ref is ambiguous: ${value}; pass doc_id or history id`);
  }
  return rows[0];
}

// article 原文窗口文本化：窗口头一行 + 原文（含 [原文开始]/[原文结束] 边界标记）+ 可选 source spans 紧凑行。
// db article（CLI/测试）与 MCP article 工具共用这一个格式化器——一套实现。传 --json 给原始结构。
/** @param {Record<string, any>} [res] 运行时形状的原文窗口结果（来自查询，非静态类型） */
function formatArticleWindow(res = {}) {
  if (!res || typeof res !== 'object' || res.article === null || (res.text == null && !res.window)) {
    return '(无原文：该文档无 source 文档或窗口为空)';
  }
  const w = res.window || {};
  const head = `[原文窗口 offset ${w.startOffset ?? '?'}-${w.endOffset ?? '?'} / 全长 ${w.totalLength ?? '?'}`
    + `${w.hasBefore ? ' ↑上文更多' : ''}${w.hasAfter ? ' ↓下文更多' : ''}]`;
  const lines = [head, String(res.text ?? '')];
  const spans = Array.isArray(res.sourceSpans) ? res.sourceSpans : null;
  if (spans) {
    const total = Number.isFinite(Number(res.spansTotal)) ? Number(res.spansTotal) : spans.length;
    lines.push('', total > spans.length ? `[source spans ${spans.length} / 窗口共 ${total}]` : `[source spans ${spans.length}]`);
    for (const span of spans) {
      const start = span.absolute_start_offset ?? span.start_offset;
      const end = span.absolute_end_offset ?? span.end_offset;
      lines.push(`span:${span.id} s${span.sentence_index} ${start}-${end}`);
    }
  }
  return lines.join('\n');
}

function historyRefFromReadAt(ref, docId) {
  const value = String(ref || '').trim();
  if (isStableId(value)) return { kind: 'id', value, docId };
  return { kind: 'committed_at_or_summary', value, docId };
}

async function resolveCurrentNodeId(database, docId, address) {
  const res = await database.run({
    operation: 'read',
    payload: {
      action: 'debug.sql',
      sql: 'SELECT id FROM nodes WHERE doc_id = @docId AND address = @address',
      params: { docId, address: String(address) },
      limit: 1
    }
  }, 'read');
  const rows = Array.isArray(res?.rows) ? res.rows : [];
  return rows.length ? String(rows[0].id) : null;
}

// 历史快照里定位目标节点。默认按稳定身份穿透：当前 address → node_id → 快照里按 id 找，
// 节点历史上换过地址也认得（git log --follow 的「认人不认位置」），节点不在该版本则明确报错、
// 绝不静默命中同址的别的节点。--at-address 退回 git <commit>:<path> 语义按历史地址定位，
// 供查已删节点或纯「那个版本那个位置」的查询。
async function resolveHistoryTarget(database, docId, address, rows, history, flags = {}) {
  if (flags.atAddress) {
    const target = rows.find((row) => String(row.address || '') === String(address || '')) || null;
    if (!target) throw new Error(`db --at-address target not found: doc ${docId} ${address} @${history.id}`);
    return target;
  }
  const currentId = await resolveCurrentNodeId(database, docId, address);
  if (!currentId) {
    throw new Error(`db --at: 当前文档无地址 ${address}；查已删节点或某版本某位置请加 --at-address`);
  }
  const target = rows.find((row) => snapshotNodeId(row) === currentId) || null;
  if (!target) {
    throw new Error(`db --at: 节点 ${currentId}（当前 ${address}）在版本 ${history.id} 尚未存在`);
  }
  return target;
}

function formatAxiomLine(row = {}) {
  const label = cleanLine(row.label || row.address || row.id || '');
  const status = cleanLine(row.status || '');
  const content = clip(row.content || row.text || row.node_title || row.nodeTitle || '', 160);
  return [label, status ? `[${status}]` : '', content].filter(Boolean).join(' ');
}

function formatRefLine(row = {}, addrById = null) {
  // 引用存的是稳定节点 UUID（位置变了也不断）；显示时若给了 id→address 映射，则把当前地址放前面作导航、
  // UUID 收进括号作稳定锚——地址方便直接 read，UUID 保证编辑后仍能定位、悬空引用也能暴露。
  const refEnd = (type, id) => {
    const ref = `${type || '?'}:${id ?? '?'}`;
    if (type === 'node' && addrById && id !== undefined && id !== null && addrById.has(String(id))) {
      return `${addrById.get(String(id))} (${ref})`;
    }
    return ref;
  };
  const source = refEnd(row.source_type || row.sourceType, row.source_id ?? row.sourceId);
  const target = refEnd(row.target_type || row.targetType, row.target_id ?? row.targetId);
  const kind = cleanLine(row.ref_kind || row.refKind || row.kind || '');
  const note = clip(row.note || '', 120);
  return [`${source} -> ${target}`, kind ? `[${kind}]` : '', note].filter(Boolean).join(' ');
}

function valueOrNull(value) {
  return value === null || value === undefined || value === '' ? 'null' : String(value);
}

function formatSourceSpanLine(row = {}) {
  const id = row.id ?? row.spanId ?? row.span_id ?? '';
  const sentence = row.sentence_index ?? row.sentenceIndex ?? '';
  const start = row.absolute_start_offset ?? row.absoluteStartOffset ?? row.start_offset ?? row.startOffset ?? '';
  const end = row.absolute_end_offset ?? row.absoluteEndOffset ?? row.end_offset ?? row.endOffset ?? '';
  const parts = [];
  if (id !== '') parts.push(`span:${id}`);
  if (sentence !== '') parts.push(`sentence:${sentence}`);
  if (start !== '' || end !== '') parts.push(`offsets:${valueOrNull(start)}-${valueOrNull(end)}`);
  return parts.join(' ') || cleanLine(JSON.stringify(row));
}

function formatDiffEntry(entry = {}) {
  const node = entry.node_id ?? entry.nodeId ?? entry.id ?? '';
  const field = entry.field || entry.kind || entry.action || '';
  const oldValue = clip(entry.old ?? entry.before ?? '', 80);
  const newValue = clip(entry.new ?? entry.after ?? '', 80);
  if (oldValue || newValue) return [`node:${node}`, field, `${oldValue} -> ${newValue}`].filter(Boolean).join(' ');
  return cleanLine(JSON.stringify(entry));
}

function selectedBranch(context = {}) {
  return context.shellState?.selectedBranch || {};
}

function updateSelectedBranch(context = {}, next = {}) {
  if (!context.shellState) context.shellState = {};
  context.shellState.selectedBranch = {
    branchId: next.branchId ?? null,
    baseDocId: next.baseDocId ?? null,
    owner: next.owner ?? null
  };
  return context.shellState.selectedBranch;
}

function branchTarget(flags = {}, context = {}, fallbackBaseDocId = null) {
  const selected = selectedBranch(context);
  const baseDocId = normalizeShellDocId(fallbackBaseDocId, null);
  return {
    branchId: flags.branch ?? selected.branchId ?? null,
    baseDocId: flags.base ?? baseDocId ?? selected.baseDocId ?? null,
    owner: flags.owner ? String(flags.owner) : (selected.owner || null)
  };
}

function branchTargetLabel(target = {}) {
  return [
    target.branchId ? `branch:${target.branchId}` : '',
    target.baseDocId ? `doc:${target.baseDocId}` : '',
    target.owner ? `owner:${target.owner}` : ''
  ].filter(Boolean).join(' ');
}

function contextFunction(context = {}, name) {
  const fn = context[name];
  if (typeof fn !== 'function') throw new Error(`db ${name} context is not available`);
  return fn;
}

function parseJsonObjectArgument(value = '', fallback = {}) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('db edit json_payload must be a JSON object');
  }
  return parsed;
}

function normalizeEditSetField(value = '') {
  const field = String(value || '').trim();
  if (field === 'text') return 'text';
  if (field === 'title' || field === 'node_title' || field === 'nodeTitle') return 'node_title';
  if (field === 'note' || field === 'node_note' || field === 'nodeNote') return 'node_note';
  if (field === 'type' || field === 'node_type' || field === 'nodeType') return 'node_type';
  if (field === 'trust_level' || field === 'trustLevel') return 'trust_level';
  throw new Error(`db edit --set unsupported field: ${field || '(empty)'}`);
}

function requireEditNodeArgs(positional = [], action = 'edit') {
  const docId = normalizeShellDocId(positional[0], null);
  const address = String(positional[1] || '').trim();
  if (!docId || !address) throw new Error(`db edit ${action} requires <doc_id> <address>`);
  return { docId, address };
}

async function readEditTargetNode(database, docId, address) {
  const result = await database.run({
    operation: 'read',
    payload: { action: 'content.getNode', docId, address, detail: 'summary' }
  }, 'read');
  const node = result?.node || null;
  if (!node?.id) throw new Error(`db edit target not found: doc ${docId} ${address}`);
  return node;
}

function editBranchWriteTarget(flags = {}, context = {}, docId = null) {
  const target = branchTarget(flags, context);
  if (target.baseDocId && docId && String(target.baseDocId) !== String(docId)) {
    throw new Error('db edit target doc_id must match selected --base doc_id');
  }
  return {
    owner: target.owner || 'llm',
    baseDocId: target.baseDocId || docId
  };
}

async function runFriendlyEdit(database, flags = {}, positional = [], context = {}) {
  if (flags.set) {
    const { docId, address } = requireEditNodeArgs(positional, '--set');
    const field = normalizeEditSetField(flags.set);
    const rawValue = positional.slice(2).join(' ');
    if (rawValue === '') throw new Error('db edit --set requires value');
    const value = field === 'node_type' ? normalizeNodeType(rawValue) : rawValue;
    const node = await readEditTargetNode(database, docId, address);
    const target = editBranchWriteTarget(flags, context, docId);
    const payload = {
      action: 'node.update',
      nodeId: node.id,
      patch: { [field]: value },
      editBranchOwner: target.owner,
      editBranchBaseDocId: target.baseDocId
    };
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_edit', text: JSON.stringify(result, null, 2) };
  }

  if (flags.delete) {
    const { docId, address } = requireEditNodeArgs(positional, '--delete');
    const node = await readEditTargetNode(database, docId, address);
    const target = editBranchWriteTarget(flags, context, docId);
    const payload = {
      action: 'node.delete',
      nodeId: node.id,
      editBranchOwner: target.owner,
      editBranchBaseDocId: target.baseDocId
    };
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_edit', text: JSON.stringify(result, null, 2) };
  }

  if (flags.insert) {
    const mode = String(flags.insert || '').trim();
    if (mode !== 'child' && mode !== 'sibling') throw new Error('db edit --insert requires child or sibling');
    const { docId, address } = requireEditNodeArgs(positional, '--insert');
    const text = positional.slice(2).join(' ');
    if (text === '') throw new Error('db edit --insert requires text');
    const node = await readEditTargetNode(database, docId, address);
    if (mode === 'sibling' && !node.parentId) throw new Error('db edit --insert sibling cannot target the document root');
    const target = editBranchWriteTarget(flags, context, docId);
    const payload = {
      action: 'node.insert',
      parentId: mode === 'child' ? node.id : node.parentId,
      text,
      editBranchOwner: target.owner,
      editBranchBaseDocId: target.baseDocId
    };
    if (mode === 'sibling') payload.afterNodeId = node.id;
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_edit', text: JSON.stringify(result, null, 2) };
  }

  return null;
}

function treeFromFlatNodes(nodes = []) {
  const byId = new Map();
  const roots = [];
  for (const node of nodes) byId.set(String(node.id), { ...node, children: [] });
  for (const node of byId.values()) {
    const parent = byId.get(String(node.parentId || ''));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function formatIndexNode(node = {}, depth = 0, options = {}) {
  const title = nodeTitle(node);
  const chars = Number(node.meta?.subtreeTextChars ?? node.meta?.textChars) || 0;
  const semantic = semanticLabel(node.meta?.semantic);
  const idSuffix = options.uuid && node.id ? ` #${node.id}` : '';
  const line = `${'  '.repeat(depth)}${node.address || ''} ${nodeTypeLabel(node)}${title ? ` ${title}` : ''} (${chars})${semantic ? ` ${semantic}` : ''}${idSuffix}`.trimEnd();
  const children = Array.isArray(node.children) ? node.children : [];
  return [line, ...children.flatMap((child) => formatIndexNode(child, depth + 1, options))];
}

function semanticLabel(semantic = null) {
  if (!semantic?.status) return '';
  const vectors = Number(semantic.vectorCount) > 0 ? ` vectors=${Number(semantic.vectorCount)}` : '';
  return `[semantic:${semantic.status}${vectors}]`;
}

// 跨库语义检索覆盖提示（projectneed 14-2）：allDocs 向量检索扫的是整个向量索引，只覆盖已向量化的节点，
// 未建向量的文档/节点根本不进结果——必须显式告知，否则"搜了空"会被误读成"库里没有"。
// （单篇语义不在此提示：requireDocVectorIndex 闸门会在向量不完整时先行报错，更具体，无需此处兜底。）
function semanticCoverageNotice({ allDocs = false } = {}) {
  if (!allDocs) return '';
  return '注意：语义检索只覆盖已建向量的节点；未向量化的节点/文档不会出现在结果里。用 library_index 看各文档 [semantic:] 状态，db vectors <doc> 补建。';
}

async function readDocDisplayLabel(database, docId, options = {}) {
  if (options.docLabel !== undefined) return options.docLabel;
  try {
    const doc = await database.run({
      operation: 'read',
      payload: { action: 'doc.get', docId, includeNodes: false, includeEditBranch: false }
    }, 'read');
    return docDisplayLabel(doc?.doc || {}, { uuid: options.uuid, docId });
  } catch {
    return docDisplayLabel({}, { uuid: options.uuid, docId });
  }
}

function limitReadText(text = '', options = {}) {
  const value = String(text || '');
  const limit = Number(options.limit) || 0;
  if (limit > 0 && value.length > limit) {
    return [
      `该子树正文 ${value.length} 字，超过 ${limit} 字。`,
      `请先用 tree 查看 doc ${options.docId || ''} ${options.address || ''} 的下级地址，再分批 read 更小子树。`
    ].join('\n');
  }
  return value;
}

// read scope=siblings：同父前/中/后三条的纯正文，带轻量导航标 〈role 地址〉、不带节点头。
async function readNeighborNodes(database, docId, address, options = {}) {
  const indexResult = await database.run({
    operation: 'read',
    payload: { action: 'content.getIndex', docId, depth: 10000, detail: 'summary', limit: 0 }
  }, 'read');
  const nodes = Array.isArray(indexResult.nodes) ? indexResult.nodes : [];
  const target = nodes.find((node) => String(node.address || '') === String(address || '')) || null;
  if (!target?.id) throw new Error(`db read siblings target not found: doc ${docId} ${address}`);
  const siblings = nodes
    .filter((node) => String(node.parentId ?? '') === String(target.parentId ?? ''))
    .sort((left, right) => {
      const order = Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
      return order || String(left.address || '').localeCompare(String(right.address || ''));
    });
  const index = siblings.findIndex((node) => String(node.id) === String(target.id));
  const selected = [
    index > 0 ? siblings[index - 1] : null,
    target,
    index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null
  ];
  const labels = ['previous', 'target', 'next'];
  const sections = [];
  for (let i = 0; i < selected.length; i += 1) {
    const node = selected[i];
    if (!node) {
      // 首/末子节点无前驱/后继：显式标「无」，避免静默少一条被当成漏读。
      sections.push(`〈${labels[i]} 无〉`);
      continue;
    }
    const result = await database.run({
      operation: 'read',
      payload: { action: 'content.getSubtree', docId, address: node.address, format: 'text', textLimit: options.limit || READ_SUBTREE_TEXT_LIMIT, limit: 0 }
    }, 'read');
    sections.push(`〈${labels[i]} ${node.address || ''}〉`.trimEnd());
    if (typeof result.text === 'string' && result.text) sections.push(result.text);
  }
  return sections.join('\n');
}

function dbReadTargetNotFoundError(docId, address) {
  return new Error(`db read target not found: doc ${docId} ${address}`);
}

async function requireDbReadTargetNode(database, docId, address) {
  const result = await database.run({
    operation: 'read',
    payload: { action: 'content.getNode', docId, address, detail: 'summary' }
  }, 'read');
  const node = result?.node || null;
  if (!node?.id) throw dbReadTargetNotFoundError(docId, address);
  return node;
}

async function readSourceBlame(database, docId, address, options = {}) {
  const nodeResult = await database.run({
    operation: 'read',
    payload: { action: 'content.getNode', docId, address, detail: 'summary', include: ['source', 'timestamps', 'tags'] }
  }, 'read');
  const node = nodeResult?.node || null;
  if (!node?.id) throw new Error(`db read --blame target not found: doc ${docId} ${address}`);

  const doc = await database.run({
    operation: 'read',
    payload: { action: 'doc.get', docId, includeNodes: false, includeEditBranch: false }
  }, 'read');
  const sourceDocument = doc?.sourceDocument || null;
  const docLabel = docDisplayLabel(doc?.doc || {}, { uuid: options.uuid, docId });
  const lines = [
    `[${docLabel} ${node.address || address} ${nodeTypeLabel(node)} ${nodeTrustLabel(node)} ${nodeTitle(node)}]`.trim(),
    `node_id: ${node.id}`,
    `source_position: ${valueOrNull(node.source?.position)}`,
    `node_created_at: ${valueOrNull(node.createdAt)}`,
    `node_updated_at: ${valueOrNull(node.updatedAt)}`
  ];

  if (!sourceDocument) {
    lines.push('source: none');
    return lines.join('\n');
  }

  lines.push(`source: ${valueOrNull(sourceDocument.source_type || sourceDocument.sourceType)} ${valueOrNull(sourceDocument.original_path || sourceDocument.originalPath)}`);
  if (sourceDocument.created_at || sourceDocument.createdAt) {
    lines.push(`source_created_at: ${valueOrNull(sourceDocument.created_at || sourceDocument.createdAt)}`);
  }

  const article = await database.run({
    operation: 'read',
    payload: {
      action: 'content.getArticle',
      docId,
      nodeId: node.id,
      include: ['spans'],
      // blame 要的是本节点自己的 spans：取全窗口 spans 再按 node_id 过滤，
      // 不能受 article 默认 span 上限(30)截断——否则靠窗口后段的节点其 spans 会被丢掉。
      spansLimit: 20000,
      ...(options.limit ? { limit: options.limit } : {})
    }
  }, 'read');
  const directSpans = (Array.isArray(article?.sourceSpans) ? article.sourceSpans : [])
    .filter((span) => String(span.node_id ?? span.nodeId ?? '') === String(node.id));
  const hasAnchor = directSpans.length > 0 || node.source?.position !== null && node.source?.position !== undefined;
  if (hasAnchor && article?.window) {
    lines.push(`window: ${article.window.startOffset}-${article.window.endOffset}/${article.window.totalLength} before:${Boolean(article.window.hasBefore)} after:${Boolean(article.window.hasAfter)}`);
  } else {
    lines.push('window: none');
  }
  lines.push('[source_spans]');
  lines.push(...(directSpans.length ? directSpans.map(formatSourceSpanLine) : ['none']));
  return lines.join('\n');
}

// inspect（D1）：节点/文档档案——身份段(总在) + 选取的 meta/source/links/axioms/note 段，输出一种一致结构。
// 吸收旧 read --meta/--blame/--links/--axioms；read 因此回归纯正文，身份/元信息一律来这里。
async function dbInspect(database, docId, address, options = {}) {
  const sections = Array.isArray(options.sections) && options.sections.length ? options.sections : ['meta', 'note'];
  const nodeResult = await database.run({
    operation: 'read',
    payload: { action: 'content.getNode', docId, address, detail: 'summary', include: ['source', 'timestamps', 'tags', 'note'] }
  }, 'read');
  const node = nodeResult?.node || null;
  if (!node?.id) throw dbReadTargetNotFoundError(docId, address);
  const docLabel = await readDocDisplayLabel(database, docId, { uuid: options.uuid });
  const lines = [`[${[docLabel, node.address || address, nodeTypeLabel(node), nodeTrustLabel(node), nodeTitle(node)].filter(Boolean).join(' ')}]`];
  let docCache = null;
  const loadDoc = async () => {
    if (!docCache) {
      docCache = await database.run({ operation: 'read', payload: { action: 'doc.get', docId, includeNodes: false, includeEditBranch: false } }, 'read');
    }
    return docCache;
  };
  if (sections.includes('meta')) {
    const metaRow = (await database.run({
      operation: 'read',
      payload: { action: 'debug.sql', sql: 'SELECT sort_order, content_hash FROM nodes WHERE doc_id = ? AND id = ?', params: [docId, node.id], limit: 1 }
    }, 'read'))?.rows?.[0] || {};
    lines.push(`[meta] updated:${valueOrNull(node.updatedAt)} created:${valueOrNull(node.createdAt)} sort:${valueOrNull(metaRow.sort_order)} chars:${valueOrNull(node.meta?.textChars)} hash:${valueOrNull(metaRow.content_hash)}`);
  }
  if (sections.includes('note')) {
    const note = node.note ?? node.node_note ?? '';
    if (String(note).trim()) lines.push(`[note] ${cleanLine(note)}`);
  }
  if (sections.includes('source')) {
    // 复用 blame 的 source/window/spans 渲染，去掉它自带的身份行（本函数已有统一身份段）。
    const blame = await readSourceBlame(database, docId, address, { uuid: options.uuid, limit: options.limit });
    lines.push(String(blame).split('\n').slice(1).join('\n'));
  }
  if (sections.includes('links')) {
    const doc = await loadDoc();
    const refs = (doc?.refs || []).filter((row) => (
      (row.source_type === 'node' && String(row.source_id) === String(node.id))
      || (row.target_type === 'node' && String(row.target_id) === String(node.id))
    ));
    const idx = await database.run({ operation: 'read', payload: { action: 'content.getIndex', docId, depth: 10000, detail: 'summary', limit: 0 } }, 'read');
    const addrById = new Map((idx?.nodes || []).map((entry) => [String(entry.id), entry.address]));
    lines.push(['[links]', ...(refs.length ? refs.map((row) => formatRefLine(row, addrById)) : ['(无)'])].join('\n'));
  }
  if (sections.includes('axioms')) {
    const doc = await loadDoc();
    const axioms = doc?.axioms || [];
    lines.push(['[axioms]', ...(axioms.length ? axioms.map(formatAxiomLine) : ['(无)'])].join('\n'));
  }
  return lines.join('\n');
}

function parseHistorySnapshot(row = {}) {
  let snapshot = null;
  try {
    snapshot = JSON.parse(row.snapshot || 'null');
  } catch {
    snapshot = null;
  }
  if (!Array.isArray(snapshot?.nodes)) {
    // 兼容旧 save_history 行：快照内嵌在 diff payload 里。
    try {
      const payload = JSON.parse(row.diff || '{}');
      snapshot = payload.snapshot || (payload.kind === 'snapshot' ? payload : null);
    } catch { /* ignore */ }
  }
  if (!Array.isArray(snapshot?.nodes)) throw new Error(`history snapshot is not readable: ${row.id ?? ''}`);
  return snapshot;
}

function snapshotNodeId(row = {}) {
  return String(row.id ?? row.nodeId ?? row.node_id ?? '');
}

function snapshotParentId(row = {}) {
  const parent = row.parent_id ?? row.parentId ?? null;
  return parent === null || parent === undefined ? '' : String(parent);
}

function snapshotChildrenByParent(rows = []) {
  const byParent = new Map();
  for (const row of rows) {
    const key = snapshotParentId(row);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(row);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((left, right) => {
      const order = Number(left.sort_order ?? left.sortOrder ?? 0) - Number(right.sort_order ?? right.sortOrder ?? 0);
      return order || String(left.address || '').localeCompare(String(right.address || ''));
    });
  }
  return byParent;
}

function snapshotTextChars(row = {}) {
  return String(row.text || '').length;
}

function snapshotSubtreeTextChars(row, byParent) {
  return snapshotTextChars(row) + (byParent.get(snapshotNodeId(row)) || [])
    .reduce((sum, child) => sum + snapshotSubtreeTextChars(child, byParent), 0);
}

function snapshotReadNode(row, byParent) {
  const children = byParent.get(snapshotNodeId(row)) || [];
  return {
    id: row.id,
    docId: row.doc_id ?? row.docId,
    parentId: row.parent_id ?? row.parentId ?? null,
    address: row.address || '',
    depth: row.depth ?? null,
    sortOrder: row.sort_order ?? row.sortOrder ?? null,
    type: row.node_type ?? row.nodeType ?? 'TEXT',
    title: row.node_title ?? row.nodeTitle ?? '',
    text: row.text || '',
    note: row.node_note ?? row.nodeNote ?? '',
    childCount: children.length,
    tags: {
      trustLevel: row.trust_level ?? row.trustLevel ?? null
    },
    meta: {
      textChars: snapshotTextChars(row),
      subtreeTextChars: snapshotSubtreeTextChars(row, byParent)
    },
    children: children.map((child) => snapshotReadNode(child, byParent))
  };
}

function snapshotSubtreeRows(root, byParent) {
  const rows = [root];
  for (const child of byParent.get(snapshotNodeId(root)) || []) rows.push(...snapshotSubtreeRows(child, byParent));
  return rows;
}

function snapshotBodyText(root, byParent, options = {}) {
  const text = snapshotSubtreeRows(root, byParent)
    .filter((row) => (byParent.get(snapshotNodeId(row)) || []).length === 0)
    .map((row) => String(row.text || ''))
    .filter((text) => text.trim())
    .join('\n');
  return limitReadText(text, {
    ...options,
    docId: options.docId || root.doc_id || root.docId,
    address: options.address || root.address
  });
}

function snapshotAddressDepth(address = '') {
  const value = String(address || '').trim();
  return value ? value.split('-').length : 0;
}

// 把快照树剪到 maxLevels 层（level 1 = 当前节点）；tree --at 默认只展 2 层，与在线 tree 一致。
function pruneTreeDepth(node, maxLevels, level = 1) {
  if (level >= maxLevels) return { ...node, children: [] };
  return { ...node, children: (node.children || []).map((child) => pruneTreeDepth(child, maxLevels, level + 1)) };
}

// tree --at（D3）：从 commit 快照重建结构树，复用在线 tree 的 formatIndexNode 渲染。
async function treeHistorySnapshot(database, docId, address, flags = {}) {
  const history = await resolveHistoryRef(database, historyRefFromReadAt(flags.at, docId), { includeDiff: true });
  const snapshot = parseHistorySnapshot(history);
  if (String(snapshot.doc?.id ?? docId) !== String(docId)) {
    throw new Error(`db tree --at history ${history.id} belongs to another doc`);
  }
  const rows = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const byParent = snapshotChildrenByParent(rows);
  let rootRows;
  if (address) {
    const target = await resolveHistoryTarget(database, docId, address, rows, history, flags);
    rootRows = [target];
  } else {
    rootRows = byParent.get('') || [];
  }
  const maxLevels = Number(flags.depth) > 0 ? Number(flags.depth) : 2;
  const subtreeRows = rootRows.flatMap((row) => snapshotSubtreeRows(row, byParent));
  const rootDepth = address ? snapshotAddressDepth(address) : 1;
  const docDepth = subtreeRows.reduce((max, row) => Math.max(max, snapshotAddressDepth(row.address)), rootDepth) - rootDepth + 1;
  const roots = rootRows.map((row) => pruneTreeDepth(snapshotReadNode(row, byParent), maxLevels));
  const lines = roots.flatMap((root) => formatIndexNode(root, 0, { uuid: Boolean(flags.uuid) }));
  if (docDepth > maxLevels) {
    lines.push(`— 已展开 ${maxLevels} / 共 ${docDepth} 层（历史快照 @${flags.at}）；加大 depth 或指定 address 下钻`);
  }
  return lines.join('\n');
}

// find --at（D3）：在 commit 快照的节点正文上做字面 node-AND 检索；语义/跨文档不支持（向量只建在 HEAD）。
async function findHistorySnapshot(database, terms, flags = {}, context = {}) {
  const scope = docScope(flags, context);
  if (!scope.docId || scope.allDocs) {
    throw new Error('find --at 需限定单篇（给 docId 或 --scope）；历史快照不支持跨文档检索');
  }
  const history = await resolveHistoryRef(database, historyRefFromReadAt(flags.at, scope.docId), { includeDiff: true });
  const snapshot = parseHistorySnapshot(history);
  const rows = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const scopeAddress = flags.scopeAddress ? String(flags.scopeAddress) : '';
  const matched = rows.filter((row) => {
    if (scopeAddress && !(String(row.address || '') === scopeAddress || String(row.address || '').startsWith(`${scopeAddress}-`))) return false;
    const text = String(row.text || '');
    return terms.every((term) => text.includes(term));
  });
  const docLabel = await readDocDisplayLabel(database, scope.docId, { uuid: flags.uuid });
  const hitRows = matched.map((row) => ({
    node: {
      id: row.id,
      address: row.address || '',
      node_type: row.node_type ?? row.nodeType ?? 'TEXT',
      node_title: row.node_title ?? row.nodeTitle ?? '',
      text: row.text || '',
      updatedAt: row.updated_at ?? row.updatedAt ?? null
    },
    doc: { docId: scope.docId, title: snapshot.doc?.title }
  }));
  const limited = Number(flags.limit) > 0 ? hitRows.slice(0, Number(flags.limit)) : hitRows;
  const body = formatGroupedHits(limited, {
    uuid: flags.uuid,
    scoreKind: 'hit',
    fallbackDocId: scope.docId,
    fallbackTitle: flags.uuid ? '' : docLabel
  });
  const more = limited.length < hitRows.length ? `，共 ${hitRows.length}（已截 ${limited.length}）` : '';
  const stats = limited.length === 0
    ? `— 0 命中（历史快照 @${flags.at}，字面 node-AND）；可拆词重试`
    : `— 历史命中 ${limited.length} 节点${more}（历史快照 @${flags.at}，字面 node-AND；语义/跨文档不支持）`;
  return [body, stats].filter(Boolean).join('\n\n').replace(/^\n+/, '') || stats;
}

// read --at（历史快照）：与在线 read 一致，只回正文、按 range 取范围（不带节点头）。
// 历史元信息/出处/引用是另一回事（snapshot 也不存 source spans），不在 read 里兼。
async function readHistorySnapshot(database, docId, address, flags = {}) {
  const range = ['node', 'subtree', 'siblings'].includes(String(flags.range)) ? String(flags.range) : 'subtree';
  const history = await resolveHistoryRef(database, historyRefFromReadAt(flags.at, docId), { includeDiff: true });
  const snapshot = parseHistorySnapshot(history);
  if (String(snapshot.doc?.id ?? docId) !== String(docId)) {
    throw new Error(`db read --at history ${history.id} belongs to another doc`);
  }
  const rows = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const target = await resolveHistoryTarget(database, docId, address, rows, history, flags);
  const byParent = snapshotChildrenByParent(rows);
  if (range === 'siblings') {
    const siblings = byParent.get(snapshotParentId(target)) || [];
    const index = siblings.findIndex((row) => snapshotNodeId(row) === snapshotNodeId(target));
    return [
      index > 0 ? ['previous', siblings[index - 1]] : ['previous', null],
      ['target', target],
      index >= 0 && index < siblings.length - 1 ? ['next', siblings[index + 1]] : ['next', null]
    ].map(([label, row]) => (row
      ? [`〈${label} ${row.address || ''}〉`.trimEnd(), String(row.text || '')].filter(Boolean).join('\n')
      : `〈${label} 无〉`)).join('\n');
  }
  if (range === 'node') {
    return String(target.text || '');
  }
  return snapshotBodyText(target, byParent, { docId, address, limit: flags.limit || READ_SUBTREE_TEXT_LIMIT });
}

export function dbShellHelp() {
  return [
    'Usage:',
    '  db find <term>... [--semantic] [--scope <doc_id> <address>] [--all-docs] [--tags] [--at <ref>] [--limit N] [--uuid]',
    '  db index [--folder <library_relative_path>] [--summary] [--uuid]',
    '  db tree <doc_id> [address] [--from <address>] [--depth N] [--at <ref>] [--uuid]',
    '  db read <doc_id> <address> [--range node|subtree|siblings] [--at <ref>] [--limit N] [--uuid]  (只回正文；元信息/出处/引用/事实用 inspect、原文窗口用 article)',
    '  db inspect <doc_id> <address> [--sections meta,source,links,axioms,note] [--limit N] [--uuid]  (节点/文档档案：身份+元信息/出处/引用/事实)',
    '  db article <doc_id> [address] [--node-id <uuid>] [--start <offset>] [--before N] [--limit N] [--spans] [--spans-limit N] [--json]  (导入原件原文窗口，按字符偏移)',
    '  db log <doc_id> [--limit N]',
    '  db diff <doc_id> <history_id> | <doc_id> <from_history_id> <to_history_id>',
    '  db sql <SELECT_or_WITH_sql> [--limit N]',
    '  db ask_agent <prompt> [--doc-id <doc_id>] [--session-id <id>]',
    '  db edit <database_write_action> [json_payload] [--owner <owner>] [--base <doc_id>]',
    '  db edit <doc_id> <address> --set <field> <value> [--owner <owner>] [--base <doc_id>]',
    '    --set fields: text/node_title/node_note/node_type/trust_level；node_type: 文本/如果/那么/否则/循环/遍历/跳出/继续/错误/人工-阻塞/人工-汇总',
    '  db edit <doc_id> <address> --insert child|sibling <text> [--owner <owner>] [--base <doc_id>]',
    '  db edit <doc_id> <address> --delete [--owner <owner>] [--base <doc_id>]',
    '  db push <json_payload>  (流式写入 4-16；payload: {docId?,title?,parentId?,nodes:[...],idempotencyKey?,vectors?})',
    '  db set-mode <doc_id> <readonly|incremental|full>  (4-16-8 编辑模式)',
    '  db bulk begin|end  (海量流式导入加速会话：begin 设异步写+延迟索引，end 恢复+重建索引)',
    '  db export <doc_id>',
    '  db restore <history_id|saved_at|tag> [doc_id]',
    '  db import <library_relative_path> [--mode simple|complete|direct|smart|vector]',
    '  db import-json <json_file> <source_file> [--dry-run] [--allow-gaps] [--vectors]  (智能导入 4-3-3：校验节点树 JSON 并入库；JSON 与 db push 同契约)',
    '  db vectors <doc_id>',
    '  db forget <doc_id>',
    '  db relink <doc_id> <source_path>  (重绑 doc 的源文件路径；锚改名/迁移后用，只改绑定不动正文)',
    '  db memory list [--state active|sealed|distillable|distilled] [--agent <name>] [--session-id <id>] [--limit N]',
    '  db memory deliver <json_payload|json_file>  (事件卷投递 18-8-4；payload: {agent,sessionId,hostAnchor?,title?,startedAt?,endedAt?,nodes:[...]}，节点一律 trust_level=不受控)',
    '  db memory seal-due  (物理封卷到期卷：末次活动+24h，15-10-1)',
    '  db memory mark-distilled <doc_id> [--force]  (提炼状态标记 15-11-5；force=用户明确指示跳过冷却期)',
    '  db changes [doc_id] [--detail] [--branch <id> | --base <doc_id>] [--owner <owner>]',
    '  db discard --branch <id> | --base <doc_id> [--owner <owner>] [--yes]',
    '  db undo --branch <id> | --base <doc_id> [--owner <owner>]',
    '  db redo --branch <id> | --base <doc_id> [--owner <owner>]',
    '  db branch list [doc_id] [--owner <owner>]',
    '  db branch begin <doc_id> [--owner <owner>]',
    '  db branch diff [doc_id] | --branch <id> | --base <doc_id> [--owner <owner>]',
    '  db branch merge [doc_id] | --branch <id> | --base <doc_id> [--owner <owner>] --all [--yes]',
    '  db branch drop [doc_id] | --branch <id> | --base <doc_id> [--owner <owner>] [--yes]',
    '  db switch --branch <id> | --base <doc_id> [--owner <owner>]',
    '  db commit --branch <id> | --base <doc_id> [--owner <owner>] [--summary text] [--tag text]',
    '  db merge --branch <id> | --base <doc_id> [--owner <owner>] [--yes]',
    '  db rebase --branch <id> | --base <doc_id> [--owner <owner>]',
    '  db cherry-pick --history <id> | --source-branch <id> [--target-branch <id> | --target-base <doc_id>] [--entry-index N]',
    '  db shell [--cwd workspace|library|path] [--timeout-ms N] [--] <command>',
    '  db web search <query> [--limit N]',
    '  db web open <url> [--char-limit N]',
    '  db keyword/query ... (compat aliases for db find)'
  ].join('\n');
}

export async function runDbShellArgv(database, argv = [], context = {}) {
  if (!database?.run) throw new Error('db command requires database service');
  const args = normalizeArgv(argv);
  const command = args[0] || '';
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { kind: 'db_help', text: dbShellHelp() };
  }

  if (command === 'find') {
    const { flags, positional } = parseFlags(args.slice(1));
    if (flags.scopeDocId) flags.scopeDocId = await resolveDocRef(database, flags.scopeDocId);
    // --folder/--exclude-folder 是「文件夹虚拟文档」范围：folder 本身即跨文档（在该子树内开 allDocs），
    // 无需再单独给 --all-docs；排除则是从当前虚拟文档里挖掉子树。
    if ((flags.folder || flags.excludeFolder) && !flags.scopeDocId) flags.allDocs = true;
    if (flags.semantic && (flags.folder || flags.excludeFolder)) {
      throw new Error('db find 的 --folder/--exclude-folder 暂只支持字面检索，不支持 --semantic（与 workspace/kind 过滤一致，语义路径的范围过滤待接入）。');
    }
    // find 限定单篇时 docId 经 currentDocId 通道传入（mcp-server 无 scopeAddress 时走第三参），
    // 此前只解析了 --scope、漏接了这条通道——标题被当成裸 id 直接撞 docScope 守卫。与 --scope 对齐：
    // 仅当原值不是合法 UUID/整数时才过 resolveDocRef（标题唯一直接定位、重名抛候选 UUID，15-5-1-2）。
    if (!flags.allDocs && !flags.scopeDocId) {
      const rawCurrentDocId = context.currentDocId ?? context.docId;
      if (rawCurrentDocId != null && String(rawCurrentDocId).trim() !== '' && normalizeShellDocId(rawCurrentDocId, null) == null) {
        context = { ...context, currentDocId: await resolveDocRef(database, rawCurrentDocId) };
      }
    }
    if (flags.semantic && flags.tags) throw new Error('db find cannot combine --semantic and --tags');
    if (flags.or) throw new Error('db find --or is not supported; run db find once per term for OR.');
    if (flags.at) {
      if (flags.semantic) throw new Error('find --at 仅支持字面检索（语义向量只建在 HEAD，历史快照无向量）');
      if (flags.tags) throw new Error('find --at 不支持 --tags（实体库随 HEAD，不查历史快照）');
      if (positional.length === 0) throw new Error('find --at requires at least one term');
      return { kind: 'db_find', text: await findHistorySnapshot(database, positional, flags, context) };
    }
    if (flags.semantic) {
      const query = positional.join(' ').trim();
      if (!query) throw new Error('db find --semantic requires natural language text');
      const scope = docScope(flags, context);
      const payload = scope.allDocs
        ? { action: 'content.searchAll', query, searchMode: 'vector', allDocs: true, limit: flags.limit }
        : { action: 'content.search', query, searchMode: 'vector', docId: scope.docId, limit: flags.limit };
      const result = await database.run({ operation: 'read', payload }, 'read');
      if (result.error) throw new Error(result.error);
      let rows = result.rows || [];
      if (!scope.allDocs && flags.scopeAddress) {
        rows = rows.filter((node) => node.address === flags.scopeAddress || String(node.address || '').startsWith(`${flags.scopeAddress}-`));
      }
      // 语义相似度下限：默认 0.51（过滤 sim < 0.51 的弱相关）；--min-score 覆盖（高级搜索可调）。
      // score 取法与 formatNodeLine 对齐：命中行可能包成 {node,doc}（score 在 node.score）或顶层 score。
      const minSim = flags.minScore != null ? Number(flags.minScore) : 0.51;
      rows = rows.filter((row) => Number((row.node || row).score ?? row.score ?? 0) >= minSim);
      const docLabel = scope.allDocs ? '' : await readDocDisplayLabel(database, scope.docId, { uuid: flags.uuid });
      const body = formatGroupedHits(rows, {
        uuid: flags.uuid,
        scoreKind: 'sim',
        fallbackDocId: scope.docId || '',
        fallbackTitle: (scope.allDocs || flags.uuid) ? '' : docLabel
      });
      const notice = semanticCoverageNotice({ allDocs: scope.allDocs });
      // 语义检索此前不发统计行（字面检索发），命中后直接结束、看不出是 top-K 截断还是全部。
      // 补一条与字面检索对齐的尾行，并标明是按相似度排序取 top-K。
      const scopeDesc = searchScopeDescriptor(flags, scope);
      const docCount = scope.allDocs
        ? new Set(rows.map((row) => String(row.doc?.docId ?? row.doc?.id ?? row.docId ?? row.doc_id ?? '')).filter(Boolean)).size
        : (rows.length ? 1 : 0);
      const stats = rows.length === 0
        ? `— 0 命中（范围：${scopeDesc}）；可换近义词重试 / 调大 limit / 用 library_index 看目录`
        : `— 语义命中 ${rows.length} 节点 / ${docCount} 文档（范围：${scopeDesc}）；按相似度排序取 top ${rows.length}`;
      return {
        kind: 'db_find',
        text: [body, stats, notice].filter(Boolean).join('\n\n').replace(/^\n+/, '')
      };
    }
    if (positional.length === 0) throw new Error('db find requires at least one term');
    if (flags.tags) {
      const result = await database.run({
        operation: 'read',
        payload: {
          action: 'entity.listRelated',
          terms: positional,
          ...docScope(flags, context),
          limit: flags.limit
        }
      }, 'read');
      return {
        kind: 'db_find_tags',
        text: formatEntityTags(result.rows || [], { uuid: flags.uuid })
      };
    }
    const scope = docScope(flags, context);
    const result = await database.run({
      operation: 'read',
      payload: {
        action: 'content.searchKeyword',
        terms: positional,
        matchMode: flags.matchMode || 'and',
        ...scope,
        limit: flags.limit,
        workspace: flags.workspace,
        agent: flags.agent,
        kind: flags.kind,
        trust: flags.trust,
        since: flags.since,
        until: flags.until,
        folder: flags.folder,
        excludeFolder: flags.excludeFolder,
        includeLabels: flags.labels
      }
    }, 'read');
    const docLabel = scope.allDocs ? '' : await readDocDisplayLabel(database, scope.docId, { uuid: flags.uuid });
    // 字面命中次数下限（高级搜索）：传 --min-score 时按 hit 过滤；默认不限。
    // score 取法与 formatNodeLine 对齐：命中行包成 {node,doc} 时 score 在 node.score。
    if (flags.minScore != null) {
      const minHit = Number(flags.minScore);
      result.rows = (result.rows || []).filter((row) => Number((row.node || row).score ?? row.score ?? 0) >= minHit);
      // 客户端按命中次数过滤后同步统计来源：findStatsLine 优先读 result.returned/total，
      // 不同步会让统计行报过滤前的数量（body 2 条却显示"命中 10"）。过滤后这批即全部，
      // returned/total 同设为过滤后长度，避免误用"已截"（那是 limit 截断的语义）。
      result.returned = result.rows.length;
      result.total = result.rows.length;
    }
    const body = formatGroupedHits(result.rows || [], {
      uuid: flags.uuid,
      scoreKind: 'hit',
      fallbackDocId: scope.docId || '',
      fallbackTitle: (scope.allDocs || flags.uuid) ? '' : docLabel,
      labels: flags.labels
    });
    const stats = findStatsLine(result, searchScopeDescriptor(flags, scope));
    return {
      kind: 'db_find',
      text: [body, stats].filter(Boolean).join('\n\n').replace(/^\n+/, '')
    };
  }

  if (command === 'keyword') {
    return runDbShellArgv(database, ['find', ...args.slice(1)], context);
  }

  if (command === 'query') {
    return runDbShellArgv(database, ['find', '--semantic', ...args.slice(1)], context);
  }

  if (command === 'index') {
    const { flags, positional } = parseFlags(args.slice(1));
    if (positional.length > 0) throw new Error('db index does not accept doc id; use db tree <doc_id> for document structure');
    const payload = { action: 'library.index', format: 'ascii_tree' };
    if (flags.folder) payload.path = flags.folder;
    if (flags.summary) payload.includeSummary = true;
    if (flags.uuid) payload.uuid = true;
    const result = await database.run({ operation: 'read', payload }, 'read');
    return {
      kind: 'db_index',
      text: result.text || ''
    };
  }

  if (command === 'tree') {
    const { flags, positional } = parseFlags(args.slice(1));
    if (!positional[0]) throw new Error('db tree requires doc_id');
    const docId = await resolveDocRef(database, positional[0]);
    const positionalAddress = String(positional[1] || '').trim();
    if (positionalAddress && flags.from && positionalAddress !== String(flags.from).trim()) {
      throw new Error('db tree address and --from must match when both are provided');
    }
    const address = String(flags.from || positionalAddress || '').trim();
    if (flags.at) {
      return { kind: 'db_tree', text: await treeHistorySnapshot(database, docId, address, flags) };
    }
    const payload = address
      ? { action: 'content.getSubtree', docId, address, levels: flags.depth, detail: 'summary', limit: 0 }
      : { action: 'content.getIndex', docId, depth: flags.depth, detail: 'summary', limit: 0 };
    if (flags.uuid) payload.uuid = true;
    const result = await database.run({ operation: 'read', payload }, 'read');
    const roots = result.tree ? [result.tree] : treeFromFlatNodes(result.nodes || []);
    const lines = roots.flatMap((root) => formatIndexNode(root, 0, { uuid: Boolean(flags.uuid) }));
    // 默认 index（不带 address）只展开有限层；文档更深时提示当前/最大层与下钻方式，避免误以为文档只有这么浅。
    if (!address && result.docDepth && result.indexDepth && result.docDepth > result.indexDepth) {
      lines.push(`— 已展开 ${result.indexDepth} / 共 ${result.docDepth} 层；加大 depth 或指定 address 下钻看更深`);
    }
    return { kind: 'db_tree', text: lines.join('\n') };
  }

  if (command === 'read') {
    const { flags, positional } = parseFlags(args.slice(1));
    const address = String(positional[1] || '').trim();
    if (!positional[0] || !address) throw new Error('db read requires <doc_id> <address>');
    const docId = await resolveDocRef(database, positional[0]);
    if (flags.at) {
      return {
        kind: 'db_read_at',
        text: await readHistorySnapshot(database, docId, address, flags)
      };
    }
    let targetNode = null;
    const readTargetNode = async () => {
      if (!targetNode) targetNode = await requireDbReadTargetNode(database, docId, address);
      return targetNode;
    };
    // read 只回正文，range 决定范围（node 只本节点 / subtree 整棵子树(默认) / siblings 同父前中后三条）、不带节点头。
    // 元信息/出处/引用/事实用 inspect、原文窗口用 article——read 不再兼这些镜头（一套实现、无兼容别名）。
    const range = ['node', 'subtree', 'siblings'].includes(String(flags.range)) ? String(flags.range) : 'subtree';
    const textLimit = flags.limit || READ_SUBTREE_TEXT_LIMIT;
    if (range === 'siblings') {
      await readTargetNode();
      return {
        kind: 'db_read_neighbors',
        text: await readNeighborNodes(database, docId, address, { limit: textLimit })
      };
    }
    if (range === 'node') {
      const node = await readTargetNode();
      const nodeResult = await database.run({ operation: 'read', payload: { action: 'content.getNode', docId, address, detail: 'full' } }, 'read');
      return { kind: 'db_read', text: String(nodeResult?.node?.text ?? node.text ?? '') };
    }
    await readTargetNode();
    const result = await database.run({ operation: 'read', payload: { action: 'content.getSubtree', docId, address, format: 'text', textLimit, limit: 0 } }, 'read');
    return { kind: 'db_read', text: typeof result.text === 'string' ? result.text : '' };
  }

  if (command === 'inspect') {
    const { flags, positional } = parseFlags(args.slice(1));
    const address = String(positional[1] || '').trim();
    if (!positional[0] || !address) throw new Error('db inspect requires <doc_id> <address>');
    const docId = await resolveDocRef(database, positional[0]);
    const sections = [];
    const rawSections = typeof flags.sections === 'string' ? flags.sections : '';
    for (const name of rawSections.split(',').map((part) => part.trim()).filter(Boolean)) {
      if (['meta', 'source', 'links', 'axioms', 'note'].includes(name)) sections.push(name);
    }
    return { kind: 'db_inspect', text: await dbInspect(database, docId, address, { sections, limit: flags.limit, uuid: flags.uuid }) };
  }

  if (command === 'article') {
    const { flags, positional } = parseFlags(args.slice(1));
    if (!positional[0]) throw new Error('db article requires <doc_id>');
    const docId = await resolveDocRef(database, positional[0]);
    const payload = { action: 'content.getArticle', docId };
    const address = String(positional[1] || '').trim();
    if (address) {
      const node = await requireDbReadTargetNode(database, docId, address);
      payload.nodeId = node.id;
    }
    if (flags.nodeId !== undefined) payload.nodeId = flags.nodeId;
    if (flags.start !== undefined) payload.startOffset = Number(flags.start);
    if (flags.before !== undefined) payload.before = Number(flags.before);
    if (flags.limit !== undefined) payload.limit = Number(flags.limit);
    if (flags.spansLimit !== undefined) payload.spansLimit = Number(flags.spansLimit);
    if (flags.spans) payload.include = ['spans'];
    const result = await database.run({ operation: 'read', payload }, 'read');
    return { kind: 'db_article', text: flags.json ? JSON.stringify(result, null, 2) : formatArticleWindow(result) };
  }

  if (command === 'log') {
    const { flags, positional } = parseFlags(args.slice(1));
    if (!positional[0]) throw new Error('db log requires doc_id');
    const docId = await resolveDocRef(database, positional[0]);
    const address = positional[1] ? String(positional[1]) : null;
    if (address) {
      // 节点级 log（git log <path>）：某地址的节点（--node）或整棵子树（默认）在哪些 commit 被改。
      const scope = flags.node ? 'node' : 'subtree';
      const result = await database.run({
        operation: 'read',
        payload: { action: 'history.nodeLog', docId, address, scope }
      }, 'read');
      const rows = Array.isArray(result?.history) ? result.history : [];
      const limited = flags.limit ? rows.slice(0, Number(flags.limit)) : rows;
      const head = `# ${address} ${scope === 'node' ? '本节点' : '整棵子树'}：共 ${rows.length} 次改动`;
      return { kind: 'db_log', text: [head, limited.map(formatHistoryLine).join('\n')].filter(Boolean).join('\n') };
    }
    const result = await database.run({
      operation: 'read',
      payload: { action: 'doc.get', docId, includeNodes: false, includeEditBranch: false }
    }, 'read');
    const rows = Array.isArray(result?.history) ? result.history : [];
    const limitedRows = flags.limit ? rows.slice(0, Number(flags.limit)) : rows;
    return {
      kind: 'db_log',
      text: limitedRows.map(formatHistoryLine).join('\n')
    };
  }

  if (command === 'diff') {
    const { flags, positional } = parseFlags(args.slice(1));
    if (!positional[0]) throw new Error('db diff requires doc_id');
    const docId = await resolveDocRef(database, positional[0]);
    const fromHistoryId = flags.from || positional[1] || '';
    const toHistoryId = flags.to || positional[2] || positional[1] || '';
    if (!toHistoryId) throw new Error('db diff requires history id');
    const payload = { action: 'history.diff', docId, toHistoryId };
    if (fromHistoryId && fromHistoryId !== toHistoryId) payload.fromHistoryId = fromHistoryId;
    const result = await database.run({ operation: 'read', payload }, 'read');
    return {
      kind: 'db_diff',
      text: (result.entries || []).map(formatDiffEntry).join('\n')
    };
  }

  if (command === 'sql') {
    const { flags, positional } = parseFlags(args.slice(1));
    const sql = positional.join(' ').trim();
    if (!sql) throw new Error('db sql requires a SELECT/WITH query');
    const payload = { action: 'debug.sql', sql };
    if (flags.limit) payload.limit = flags.limit;
    const result = await database.run({ operation: 'read', payload }, 'read');
    return { kind: 'db_sql', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'ask_agent') {
    const { flags, positional } = parseFlags(args.slice(1));
    const prompt = positional.join(' ').trim();
    if (!prompt) throw new Error('db ask_agent requires prompt text');
    const payload = { prompt };
    // docId 解析交给 askAgent 漏斗（runAgent 统一过 resolveDocRef、支持标题）：这里只取原值，
    // 不预先 normalize 掉标题。优先显式 --doc-id，否则用当前文档（已是规范化 id）。
    const rawDocId = (flags.docId != null && String(flags.docId).trim() !== '') ? flags.docId : currentDocIdFrom(context);
    if (rawDocId != null && String(rawDocId).trim() !== '') payload.docId = rawDocId;
    if (flags.sessionId) payload.sessionId = flags.sessionId;
    const result = await contextFunction(context, 'askAgent')(payload);
    const answer = result?.answer || result?.error || '';
    const session = result?.sessionId != null ? `\n\n[sessionId: ${result.sessionId}]` : '';
    return { kind: 'db_ask_agent', text: `${answer}${session}` };
  }

  if (command === 'edit') {
    const { flags, positional } = parseFlags(args.slice(1));
    const friendly = await runFriendlyEdit(database, flags, positional, context);
    if (friendly) return friendly;
    const action = String(positional[0] || '').trim();
    if (!action) throw new Error('db edit requires database_write action');
    const payload = parseJsonObjectArgument(positional.slice(1).join(' '), {});
    const target = branchTarget(flags, context);
    const writePayload = {
      ...payload,
      action,
      editBranchOwner: target.owner || 'llm'
    };
    if (target.baseDocId) writePayload.editBranchBaseDocId = target.baseDocId;
    const result = await database.run({ operation: 'write', payload: writePayload }, 'write');
    return { kind: 'db_edit', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'push') {
    // 流式写入（projectneed 4-16）：独立于 edit branch，不加 editBranchOwner。
    const { positional } = parseFlags(args.slice(1));
    const payload = parseJsonObjectArgument(positional.join(' '), {});
    const result = await database.run({ operation: 'write', payload: { ...payload, action: 'stream.push' } }, 'write');
    return { kind: 'db_push', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'import-json') {
    // 智能导入校验 + 入库（projectneed 4-3-3）：JSON 与 db push 同一契约。
    const { flags, positional } = parseFlags(args.slice(1));
    const jsonPath = String(positional[0] || '').trim();
    const sourcePath = String(positional[1] || '').trim();
    if (!jsonPath || !sourcePath) throw new Error('db import-json requires <json_file> <source_file>');
    const result = await runImportJson({
      database,
      jsonPath,
      sourcePath,
      dryRun: flags.dryRun === true,
      allowGaps: flags.allowGaps === true,
      vectors: flags.vectors === true
    });
    return { kind: 'db_import_json', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'set-mode') {
    const { positional } = parseFlags(args.slice(1));
    const docId = normalizeShellDocId(positional[0], null);
    const mode = String(positional[1] || '').trim();
    if (!docId || !mode) throw new Error('db set-mode requires <doc_id> <readonly|incremental|full>');
    const result = await database.run({ operation: 'write', payload: { action: 'doc.setEditMode', docId, mode, includeDoc: false } }, 'write');
    return { kind: 'db_set_mode', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'bulk') {
    const sub = String(args[1] || '').trim();
    if (sub !== 'begin' && sub !== 'end') throw new Error('db bulk begin|end');
    const action = sub === 'begin' ? 'stream.bulkBegin' : 'stream.bulkEnd';
    const result = await database.run({ operation: 'write', payload: { action } }, 'write');
    return { kind: 'db_bulk', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'export') {
    const { positional } = parseFlags(args.slice(1));
    const docId = normalizeShellDocId(positional[0], null);
    if (!docId) throw new Error('db export requires doc_id');
    const result = await database.run({
      operation: 'read',
      payload: { action: 'doc.exportMarkdown', docId }
    }, 'read');
    return {
      kind: 'db_export',
      text: result?.text || ''
    };
  }

  if (command === 'restore') {
    const { flags, positional } = parseFlags(args.slice(1));
    const history = await resolveHistoryRef(database, historyRefSpec(flags, positional));
    const payload = { action: 'history.restore', commitId: history.id, docId: history.doc_id };
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_restore', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'import') {
    const { flags, positional } = parseFlags(args.slice(1));
    const relativePath = String(positional[0] || '').trim();
    if (!relativePath) throw new Error('db import requires library_relative_path');
    const payload = { relativePath };
    if (flags.mode) payload.mode = String(flags.mode);
    const result = await contextFunction(context, 'importLibraryDocument')(payload);
    return { kind: 'db_import', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'vectors') {
    const { positional } = parseFlags(args.slice(1));
    const docId = normalizeShellDocId(positional[0], null);
    if (!docId) throw new Error('db vectors requires doc_id');
    const result = await contextFunction(context, 'ensureDocVectors')({ docId });
    return { kind: 'db_vectors', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'forget') {
    const { positional } = parseFlags(args.slice(1));
    const docId = normalizeShellDocId(positional[0], null);
    if (!docId) throw new Error('db forget requires doc_id');
    if (typeof context.deleteImportedDocument === 'function') {
      const result = await context.deleteImportedDocument({ docId });
      return { kind: 'db_forget', text: JSON.stringify(result, null, 2) };
    }
    const result = await database.run({
      operation: 'write',
      payload: { action: 'doc.delete', docId }
    }, 'write');
    return { kind: 'db_forget', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'relink') {
    const { positional } = parseFlags(args.slice(1));
    const docId = normalizeShellDocId(positional[0], null);
    const sourcePath = String(positional[1] || '').trim();
    if (!docId || !sourcePath) throw new Error('db relink requires <doc_id> <source_path>');
    const result = await database.run({
      operation: 'write',
      payload: { action: 'doc.relink', docId, sourcePath }
    }, 'write');
    return { kind: 'db_relink', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'memory') {
    // 完整记忆动词（projectneed 15-10 / 15-11-5 / 18-8-4）：MCP/agent 与人共用同一套 db 契约。
    const sub = String(args[1] || 'list').trim();
    if (sub === 'list') {
      const { flags } = parseFlags(args.slice(2));
      const result = await database.run({
        operation: 'read',
        payload: {
          action: 'memory.listVolumes',
          state: flags.state ? String(flags.state) : null,
          agent: flags.agent ? String(flags.agent) : null,
          sessionId: flags.sessionId ?? null,
          limit: flags.limit
        }
      }, 'read');
      return { kind: 'db_memory_list', text: JSON.stringify(result, null, 2) };
    }
    if (sub === 'deliver') {
      const { positional } = parseFlags(args.slice(2));
      const raw = positional.join(' ').trim();
      if (!raw) throw new Error('db memory deliver requires <json_payload|json_file>');
      const payload = raw.startsWith('{')
        ? parseJsonObjectArgument(raw, {})
        : parseJsonObjectArgument(readFileSync(raw, 'utf8'), {});
      const result = await database.run({ operation: 'write', payload: { ...payload, action: 'memory.deliverVolume' } }, 'write');
      return { kind: 'db_memory_deliver', text: JSON.stringify(result, null, 2) };
    }
    if (sub === 'seal-due') {
      const result = await database.run({ operation: 'write', payload: { action: 'memory.sealDue' } }, 'write');
      return { kind: 'db_memory_seal', text: JSON.stringify(result, null, 2) };
    }
    if (sub === 'mark-distilled') {
      const { flags, positional } = parseFlags(args.slice(2));
      const docId = normalizeShellDocId(positional[0], null);
      if (!docId) throw new Error('db memory mark-distilled requires <doc_id>');
      const result = await database.run({
        operation: 'write',
        payload: { action: 'memory.markDistilled', docId, force: flags.force === true }
      }, 'write');
      return { kind: 'db_memory_distilled', text: JSON.stringify(result, null, 2) };
    }
    throw new Error('db memory list|deliver|seal-due|mark-distilled');
  }

  if (command === 'branch') {
    const { flags, positional } = parseFlags(args.slice(1));
    const subcommand = String(positional[0] || 'list').trim();
    if (subcommand === 'list') {
      const docId = normalizeShellDocId(positional[1], null);
      const payload = { action: 'editBranch.listPending' };
      if (flags.owner) payload.owner = String(flags.owner);
      const result = await database.run({ operation: 'read', payload }, 'read');
      const branches = (result.branches || []).filter((branch) => (
        docId ? String(branch.base_doc_id) === String(docId) : true
      ));
      return { kind: 'db_branch_list', text: branches.map(formatBranchLine).join('\n') };
    }
    if (subcommand === 'begin') {
      const docId = normalizeShellDocId(positional[1], null);
      if (!docId) throw new Error('db branch begin requires doc_id');
      const payload = { action: 'editBranch.begin', docId, includeDoc: false };
      if (flags.owner) payload.owner = String(flags.owner);
      const result = await database.run({ operation: 'write', payload }, 'write');
      return { kind: 'db_branch_begin', text: JSON.stringify(result, null, 2) };
    }
    if (subcommand === 'diff') {
      const target = branchTarget(flags, context, positional[1]);
      const payload = { action: 'editBranch.diffView', changedOnly: true };
      if (target.branchId) payload.branchId = target.branchId;
      if (target.baseDocId) payload.baseDocId = target.baseDocId;
      if (target.owner) payload.owner = String(target.owner);
      const result = await database.run({ operation: 'read', payload }, 'read');
      return { kind: 'db_branch_diff', text: JSON.stringify(result, null, 2) };
    }
    if (subcommand === 'merge') {
      if (!flags.all) return { kind: 'db_branch_merge', text: 'db branch merge requires --all; --entry is not implemented' };
      const target = branchTarget(flags, context, positional[1]);
      if (!target.branchId && !target.baseDocId) throw new Error('db branch merge requires --branch or --base');
      if (!flags.yes) {
        return {
          kind: 'db_branch_merge',
          text: `would merge ${branchTargetLabel(target)}; rerun with --yes to apply`
        };
      }
      const payload = { action: 'editBranch.save', includeDoc: false };
      if (target.branchId) payload.branchId = target.branchId;
      if (target.baseDocId) payload.baseDocId = target.baseDocId;
      if (target.owner) payload.owner = String(target.owner);
      const result = await database.run({ operation: 'write', payload }, 'write');
      return { kind: 'db_branch_merge', text: JSON.stringify(result, null, 2) };
    }
    if (subcommand === 'drop') {
      const target = branchTarget(flags, context, positional[1]);
      if (!target.branchId && !target.baseDocId) throw new Error('db branch drop requires --branch or --base');
      if (!flags.yes) {
        return {
          kind: 'db_branch_drop',
          text: `would drop ${branchTargetLabel(target)}; rerun with --yes to apply`
        };
      }
      const payload = { action: 'editBranch.discard', includeDoc: false };
      if (target.branchId) payload.branchId = target.branchId;
      if (target.baseDocId) payload.baseDocId = target.baseDocId;
      if (target.owner) payload.owner = String(target.owner);
      const result = await database.run({ operation: 'write', payload }, 'write');
      return { kind: 'db_branch_drop', text: JSON.stringify(result, null, 2) };
    }
    throw new Error(`Unknown db branch command: ${subcommand}`);
  }

  if (command === 'changes') {
    const { flags, positional } = parseFlags(args.slice(1));
    if (flags.detail) {
      const target = branchTarget(flags, context, positional[0]);
      const payload = { action: 'editBranch.diffView', changedOnly: true };
      if (target.branchId) payload.branchId = target.branchId;
      if (target.baseDocId) payload.baseDocId = target.baseDocId;
      if (target.owner) payload.owner = String(target.owner);
      if (!payload.branchId && !payload.baseDocId) throw new Error('db changes --detail requires --branch or --base');
      const result = await database.run({ operation: 'read', payload }, 'read');
      return { kind: 'db_changes', text: JSON.stringify(result, null, 2) };
    }
    const docId = normalizeShellDocId(positional[0], null);
    const payload = { action: 'editBranch.listPending' };
    if (flags.owner) payload.owner = String(flags.owner);
    const result = await database.run({ operation: 'read', payload }, 'read');
    const branches = (result.branches || []).filter((branch) => (
      docId ? String(branch.base_doc_id) === String(docId) : true
    ));
    return { kind: 'db_changes', text: branches.map(formatBranchLine).join('\n') };
  }

  if (command === 'discard') {
    const { flags } = parseFlags(args.slice(1));
    const target = branchTarget(flags, context);
    if (!target.branchId && !target.baseDocId) throw new Error('db discard requires --branch or --base');
    if (!flags.yes) {
      return {
        kind: 'db_discard',
        text: `would discard ${branchTargetLabel(target)}; rerun with --yes to apply`
      };
    }
    const payload = { action: 'editBranch.discard', includeDoc: false };
    if (target.branchId) payload.branchId = target.branchId;
    if (target.baseDocId) payload.baseDocId = target.baseDocId;
    if (target.owner) payload.owner = String(target.owner);
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_discard', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'undo' || command === 'redo') {
    const { flags } = parseFlags(args.slice(1));
    const target = branchTarget(flags, context);
    const payload = {
      action: command === 'undo' ? 'editBranch.undo' : 'editBranch.redo',
      includeDoc: false
    };
    if (target.branchId) payload.branchId = target.branchId;
    if (target.baseDocId) payload.baseDocId = target.baseDocId;
    if (target.owner) payload.owner = String(target.owner);
    if (!payload.branchId && !payload.baseDocId) throw new Error(`db ${command} requires --branch or --base`);
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: command === 'undo' ? 'db_undo' : 'db_redo', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'switch') {
    const { flags } = parseFlags(args.slice(1));
    if (!flags.branch && !flags.base) {
      const current = selectedBranch(context);
      return { kind: 'db_switch', text: current.branchId || current.baseDocId ? JSON.stringify(current, null, 2) : '(未选择分支)' };
    }
    const next = updateSelectedBranch(context, {
      branchId: flags.branch ?? null,
      baseDocId: flags.base ?? null,
      owner: flags.owner ? String(flags.owner) : null
    });
    return { kind: 'db_switch', text: JSON.stringify(next, null, 2) };
  }

  if (command === 'commit' || command === 'merge') {
    const { flags } = parseFlags(args.slice(1));
    const target = branchTarget(flags, context);
    if (command === 'merge' && !target.branchId && !target.baseDocId) throw new Error('db merge requires --branch or --base');
    if (command === 'merge' && !flags.yes) {
      return {
        kind: 'db_merge',
        text: `would merge ${branchTargetLabel(target)}; rerun with --yes to apply`
      };
    }
    const payload = { action: 'editBranch.save', includeDoc: false };
    if (target.branchId) payload.branchId = target.branchId;
    if (target.baseDocId) payload.baseDocId = target.baseDocId;
    if (target.owner) payload.owner = String(target.owner);
    if (flags.summary && flags.summary !== true) payload.summary = String(flags.summary);
    else if (flags.tag && flags.tag !== true) payload.summary = String(flags.tag);
    if (!payload.branchId && !payload.baseDocId) throw new Error(`db ${command} requires --branch or --base`);
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: command === 'commit' ? 'db_commit' : 'db_merge', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'rebase') {
    const { flags } = parseFlags(args.slice(1));
    const target = branchTarget(flags, context);
    const payload = { action: 'editBranch.rebase', includeDoc: false };
    if (target.branchId) payload.branchId = target.branchId;
    if (target.baseDocId) payload.baseDocId = target.baseDocId;
    if (target.owner) payload.owner = String(target.owner);
    if (!payload.branchId && !payload.baseDocId) throw new Error('db rebase requires --branch or --base');
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_rebase', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'cherry-pick') {
    const { flags } = parseFlags(args.slice(1));
    const target = branchTarget({ branch: flags.targetBranch, base: flags.targetBase, owner: flags.owner }, context);
    const payload = { action: 'editBranch.cherryPick', includeDoc: false };
    if (flags.history) payload.sourceHistoryId = flags.history;
    if (flags.sourceBranch) payload.sourceBranchId = flags.sourceBranch;
    if (target.branchId) payload.targetBranchId = target.branchId;
    if (target.baseDocId) payload.targetBaseDocId = target.baseDocId;
    if (target.owner) payload.targetOwner = String(target.owner);
    if (flags.entryId) payload.entryId = String(flags.entryId);
    if (flags.entryIndex !== undefined) payload.entryIndex = flags.entryIndex;
    if (!payload.sourceHistoryId && !payload.sourceBranchId) throw new Error('db cherry-pick requires --history or --source-branch');
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_cherry_pick', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'shell') {
    const { flags, positional } = parseLooseFlags(args.slice(1), ['cwd', 'timeout-ms']);
    const shellCommand = positional.join(' ').trim();
    if (!shellCommand) throw new Error('db shell requires command');
    const result = await contextFunction(context, 'agentTool')({
      name: 'bash',
      mode: 'full',
      docId: currentDocIdFrom(context) || undefined,
      args: {
        command: shellCommand,
        ...(flags.cwd ? { cwd: String(flags.cwd) } : {}),
        ...(flags.timeoutMs ? { timeoutMs: flags.timeoutMs } : {})
      }
    });
    return { kind: 'db_shell', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'web') {
    const { flags, positional } = parseLooseFlags(args.slice(1), ['limit', 'char-limit']);
    const first = String(positional[0] || '').trim();
    const mode = first === 'search' || first === 'open'
      ? first
      : (/^https?:\/\//i.test(first) ? 'open' : 'search');
    const rest = positional.slice(first === 'search' || first === 'open' ? 1 : 0);
    if (mode !== 'search' && mode !== 'open') throw new Error('db web requires search or open');
    const value = rest.join(' ').trim();
    if (!value) throw new Error(`db web ${mode} requires ${mode === 'open' ? 'url' : 'query'}`);
    const toolArgs = mode === 'open'
      ? { mode, url: value }
      : { mode, query: value };
    if (flags.limit) toolArgs.limit = flags.limit;
    if (flags.charLimit) toolArgs.charLimit = flags.charLimit;
    const result = await contextFunction(context, 'agentTool')({
      name: 'web_search',
      mode: 'full',
      docId: currentDocIdFrom(context) || undefined,
      args: toolArgs
    });
    return { kind: 'db_web', text: JSON.stringify(result, null, 2) };
  }

  throw new Error(`Unknown db command: ${command}`);
}
