// 读动作 handler（自 query-api.ts 按域拆出，§6-4：照 mutation-api 的 handlers/write 样板）。
// 本文件由分派表 query-api.ts 消费；跨域共享的 helper 一律住 shared.ts。
import { asciiTreeLabel, cleanTreeLabel, contentFormat, contentIncludeSet, escapeLike, formatContentNode, libraryRelativeSourcePath, nodeTextChars, normalizeKeywordTerms } from './content.js';
import { clipText, normalizeLimit, normalizeNonNegativeInteger, normalizeQueryId, pageRows } from './shared.js';
import type { ContentNodeRow, CrossDocFormattedResult, CrossDocSearchRow, DocFilterRow, FormattedContentNode, KeywordHit, KeywordNodeRow, KeywordWhere, Payload, QueryContext, RowObject } from './shared.js';
import { buildAhoCorasickMatcher } from '../../../core/aho-corasick.js';
import { normalizeTimestampForCompare } from '../../shared.js';
import { runEntityRead } from '../../entities/read.js';
import type { IftreeStore } from '../../store/index.js';
import type { NodeRow, SourceDocumentRow } from '../../db/schema.js';

export interface ContentSearchResult {
  kind: 'content.search';
  mode?: string;
  docId: string;
  query: string;
  rows: FormattedContentNode[];
  error?: string;
  minScore?: number;
  weakFilteredOut?: number;
}

export function keywordWhereSql(payload: Payload = {}, terms: string[] = [], options: { termOperator?: string } = {}): KeywordWhere {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const docId = normalizeQueryId(payload.scopeDocId ?? payload.scope_doc_id ?? payload.docId ?? payload.doc_id, null);
  const allDocs = payload.allDocs === true || payload.all_docs === true || payload.scope === 'all';
  if (!allDocs) {
    if (!docId) throw new Error('content.searchKeyword requires docId unless allDocs is true');
    clauses.push('n.doc_id = ?');
    params.push(docId);
  }
  const scopeAddress = String(payload.scopeAddress ?? payload.scope_address ?? payload.address ?? '').trim();
  if (scopeAddress) {
    clauses.push('(n.address = ? OR n.address LIKE ? ESCAPE \'\\\')');
    params.push(scopeAddress, `${escapeLike(scopeAddress)}-%`);
  }
  const termClauses: string[] = [];
  const termParams: unknown[] = [];
  for (const term of terms) {
    const like = `%${escapeLike(term)}%`;
    termClauses.push(`(
      n.address LIKE ? ESCAPE '\\'
      OR n.node_title LIKE ? ESCAPE '\\'
      OR n.text LIKE ? ESCAPE '\\'
      OR n.node_note LIKE ? ESCAPE '\\'
    )`);
    termParams.push(like, like, like, like);
  }
  if (termClauses.length > 0) {
    const joiner = options.termOperator === 'or' ? '\n      OR ' : '\n      AND ';
    clauses.push(`(${termClauses.join(joiner)})`);
    params.push(...termParams);
  }
  return {
    sql: clauses.length ? clauses.join('\n      AND ') : '1 = 1',
    params
  };
}

export function normalizeKeywordMatchMode(payload: Payload = {}) {
  const mode = String(payload.matchMode ?? payload.match_mode ?? payload.operator ?? payload.op ?? '').trim().toLowerCase();
  if (mode === 'or') return 'or';
  // 节点级 AND（旧行为，要求所有词在同一节点共现，精确但长文档易漏）：显式 node/strict 才走。
  if (mode === 'node' || mode === 'nodeand' || mode === 'strict') return 'node';
  // 默认文档级 AND（高命中）：词可分散在同一文档的不同节点。
  return 'doc';
}

export function keywordHaystack(row: Partial<NodeRow> = {}) {
  return [
    row.address,
    row.node_title,
    row.text,
    row.node_note
  ].map((value) => String(value || '').toLowerCase()).join('\n');
}

export function countLiteralOccurrences(haystack = '', needle = '') {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index < haystack.length) {
    const next = haystack.indexOf(needle, index);
    if (next === -1) break;
    count += 1;
    index = next + needle.length;
  }
  return count;
}

export function keywordHitCount(row: Partial<NodeRow> = {}, terms: string[] = []) {
  return keywordHitCountInHaystack(keywordHaystack(row), terms);
}

// 命中计数的 haystack 复用版：scanKeywordHits 缓存的 haystack 直接传入，省一次四字段拼接+lower。
// 计数口径保持 countLiteralOccurrences 的非重叠语义（与 AC 的重叠出现报告无关），排序/分数不变。
function keywordHitCountInHaystack(haystack: string, terms: string[] = []) {
  return terms.reduce((sum, term) => sum + countLiteralOccurrences(haystack, String(term || '').toLowerCase()), 0);
}

export function keywordHitSummary(row: Partial<NodeRow> = {}, terms: string[] = []) {
  return keywordHitSummaryInHaystack(keywordHaystack(row), terms);
}

function keywordHitSummaryInHaystack(haystack: string, terms: string[] = []) {
  const termKeys = [...new Set(terms.map((term) => String(term || '').toLowerCase()).filter(Boolean))];
  let score = 0;
  let rowHits = 0;
  for (const key of termKeys) {
    const count = countLiteralOccurrences(haystack, key);
    score += count;
    if (count > 0) rowHits += 1;
  }
  return { score, rowHits, termCount: termKeys.length };
}

export function parseListFilter(value: unknown): Set<string> | null {
  if (value === null || value === undefined) return null;
  const list = (Array.isArray(value) ? value : String(value).split(','))
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return list.length > 0 ? new Set(list) : null;
}

// 文件夹范围归一化：统一 / 分隔、去首尾斜杠；空 → null。
export function normalizeFolderFilter(value: unknown) {
  const text = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return text || null;
}

export function parseFolderFilterList(value: unknown) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const out: string[] = [];
  for (const item of list) {
    const folder = normalizeFolderFilter(item);
    if (folder) out.push(folder);
  }
  return out;
}

// 文档源文件相对路径 rel 是否落在文件夹 folder 子树内（含 folder 本身）。
export function isUnderFolder(rel: unknown, folder: unknown) {
  if (!rel || !folder) return false;
  const path = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  return path === folder || path.startsWith(`${folder}/`);
}

export function memoryWorkspaceFromAnchor(anchor: unknown = '') {
  const matched = String(anchor || '').match(/[\\/]\.claude[\\/]projects[\\/]([^\\/#]+)/);
  return matched ? matched[1] : '';
}

// 文档级过滤：综合「元数据过滤（工作区/agent/类型）」与「文件夹范围（folder/excludeFolder）」，
// 返回预算允许的 docId 集合；两者都无 → null（不限制）；都有 → 取交集。
export function resolveKeywordDocFilter(store: IftreeStore, payload: Payload = {}, ctx: QueryContext = {}): Set<string> | null {
  const metaSet = resolveMetaDocFilter(store, payload);
  const folderSet = resolveFolderDocFilter(store, payload, ctx);
  if (!metaSet) return folderSet;
  if (!folderSet) return metaSet;
  const allowed = new Set<string>();
  for (const id of metaSet) if (folderSet.has(id)) allowed.add(id);
  return allowed;
}

// 文档类型分类 SQL（event/memory/knowledge 的单一真相，避免在多处检索 SQL 间口径漂移）：
// 文档 meta 带记忆卷标记→event；否则文档下存在受控节点→memory；再否则→knowledge。
// 三分语义定义归记忆域（src/backend/memory/）。docAlias=外层 docs 别名；内层受控节点子查询
// 用独立别名 mk_node、与任何外层别名不冲突。
export function docKindCaseSql(docAlias = 'd') {
  return `CASE
        WHEN json_extract(${docAlias}.meta,'$.memoryVolume') IS NOT NULL THEN 'event'
        WHEN EXISTS (SELECT 1 FROM nodes mk_node WHERE mk_node.doc_id = ${docAlias}.id AND mk_node.trust_level = '受控') THEN 'memory'
        ELSE 'knowledge'
      END`;
}

// 元数据过滤（工作区 / agent / 文档类型）：无此类过滤时返回 null（不限制）。
// 类型 kind：event=事件卷、memory=含受控节点的核心记忆、knowledge=其余知识文档。
export function resolveMetaDocFilter(store: IftreeStore, payload: Payload = {}) {
  const workspace = parseListFilter(payload.workspace ?? payload.workspaces);
  const agent = parseListFilter(payload.agent ?? payload.agents);
  const kind = parseListFilter(payload.kind ?? payload.kinds ?? payload.docKind);
  if (!workspace && !agent && !kind) return null;
  const rows = store.db!.prepare(`
    SELECT d.id AS id,
      json_extract(d.meta,'$.memoryVolume.agent') AS agent,
      json_extract(d.meta,'$.memoryVolume.hostAnchor') AS host_anchor,
      ${docKindCaseSql('d')} AS kind
    FROM docs d
  `).all<DocFilterRow>();
  const allowed = new Set<string>();
  for (const row of rows) {
    if (workspace && !workspace.has(memoryWorkspaceFromAnchor(row.host_anchor))) continue;
    if (agent && !agent.has(String(row.agent || ''))) continue;
    if (kind && !kind.has(String(row.kind || ''))) continue;
    allowed.add(String(row.id));
  }
  return allowed;
}

// 文件夹范围过滤（folder=只在某 library 文件夹子树内；excludeFolder=排除某些子树）：
// 「在某文件夹下开 allDocs」即检索该文件夹这篇大型虚拟文档。无 folder/excludeFolder 时返回 null。
// 文档归属按其源文件的 library 相对路径前缀判定（ctx.libraryRelativePath 把绝对 sourcePath 还原成相对路径）。
// 无源文件的虚拟/流式文档相对路径为空：folder 限定时被排除、纯 excludeFolder 时保留。
export function resolveFolderDocFilter(store: IftreeStore, payload: Payload = {}, ctx: QueryContext = {}) {
  const folder = normalizeFolderFilter(payload.folder ?? payload.inFolder ?? payload.in_folder);
  const excludeFolders = parseFolderFilterList(payload.excludeFolder ?? payload.excludeFolders ?? payload.exclude_folder);
  if (!folder && excludeFolders.length === 0) return null;
  const relativePathFor = typeof ctx.libraryRelativePath === 'function' ? ctx.libraryRelativePath : null;
  const rows = store.db!.prepare(`
    SELECT d.id AS id, sd.original_path AS original_path
    FROM docs d
    LEFT JOIN source_documents sd ON sd.doc_id = d.id
  `).all<DocFilterRow>();
  const allowed = new Set<string>();
  for (const row of rows) {
    const rel = (row.original_path && relativePathFor) ? relativePathFor(row.original_path) : '';
    if (folder && !isUnderFolder(rel, folder)) continue;
    if (excludeFolders.some((ex) => isUnderFolder(rel, ex))) continue;
    allowed.add(String(row.id));
  }
  return allowed;
}

// 相对路径是否落在 . 开头的隐藏文件夹下（任一路径段以 . 开头，如 .memory）。
export function docIsUnderHiddenPath(rel: unknown) {
  if (!rel) return false;
  return String(rel).replace(/\\/g, '/').replace(/^\/+/, '').split('/').some((seg) => seg.startsWith('.'));
}

// 跨文档检索默认排除 . 开头隐藏路径文档（projectneed 15-7-3，如事件卷锚所在的 .memory）。
// includeHidden=true 或显式 kind=event 时不排除（"显式传参才看得到"）。返回要排除的 docId 集合；无可排除时 null。
export function resolveHiddenDocExclusion(store: IftreeStore, payload: Payload = {}, ctx: QueryContext = {}) {
  if (payload.includeHidden === true || payload.include_hidden === true) return null;
  const kind = parseListFilter(payload.kind ?? payload.kinds ?? payload.docKind);
  if (kind && kind.has('event')) return null;
  const relativePathFor = typeof ctx.libraryRelativePath === 'function' ? ctx.libraryRelativePath : null;
  if (!relativePathFor) return null;
  const rows = store.db!.prepare(`
    SELECT d.id AS id, sd.original_path AS original_path
    FROM docs d
    LEFT JOIN source_documents sd ON sd.doc_id = d.id
  `).all<DocFilterRow>();
  const hidden = new Set<string>();
  for (const row of rows) {
    const rel = row.original_path ? relativePathFor(row.original_path) : '';
    if (docIsUnderHiddenPath(rel)) hidden.add(String(row.id));
  }
  return hidden.size ? hidden : null;
}

export function keywordRowInScope(row: KeywordNodeRow, payload: Payload = {}, docFilter: Set<string> | null = null) {
  const allDocs = payload.allDocs === true || payload.all_docs === true || payload.scope === 'all';
  const docId = normalizeQueryId(payload.scopeDocId ?? payload.scope_doc_id ?? payload.docId ?? payload.doc_id, null);
  if (!allDocs && docId && String(row.doc_id) !== String(docId)) return false;
  const scopeAddress = String(payload.scopeAddress ?? payload.scope_address ?? payload.address ?? '').trim();
  if (scopeAddress) {
    const address = String(row.address || '');
    if (address !== scopeAddress && !address.startsWith(`${scopeAddress}-`)) return false;
  }
  if (docFilter && !docFilter.has(String(row.doc_id))) return false;
  const trust = parseListFilter(payload.trust ?? payload.trustLevel ?? payload.trust_level);
  if (trust && !trust.has(String(row.trust_level || ''))) return false;
  const since = String(payload.since ?? payload.after ?? '').trim();
  const until = String(payload.until ?? payload.before ?? '').trim();
  // updated_at 两格式混存（CURRENT_TIMESTAMP 空格式 / JS 写入 ISO 式），归一后比较才等价于时间序。
  const updated = row.updated_at ? normalizeTimestampForCompare(row.updated_at) : '';
  if (since && updated && updated < normalizeTimestampForCompare(since)) return false;
  if (until && updated && updated > normalizeTimestampForCompare(until)) return false;
  return true;
}

export function keywordRowsByIds(store: IftreeStore, ids: unknown[] = []): KeywordNodeRow[] {
  const orderedIds = [...new Set(ids.map((id) => normalizeQueryId(id)).filter((id): id is string => Boolean(id)))];
  if (orderedIds.length === 0) return [];
  const placeholders = orderedIds.map(() => '?').join(', ');
  const rows = store.db!.prepare(`
    WITH matched AS (
      SELECT n.*,
        d.title AS doc_title,
        ${docKindCaseSql('d')} AS doc_kind
      FROM nodes n
      JOIN docs d ON d.id = n.doc_id
      WHERE n.id IN (${placeholders})
    ),
    child_counts(parent_id, child_count) AS (
      SELECT parent_id, COUNT(*)
      FROM nodes
      WHERE parent_id IN (SELECT id FROM matched)
      GROUP BY parent_id
    )
    SELECT matched.*,
      COALESCE(child_counts.child_count, 0) AS child_count
    FROM matched
    LEFT JOIN child_counts ON child_counts.parent_id = matched.id
  `).all<KeywordNodeRow>(...orderedIds);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return orderedIds.map((id) => byId.get(id)).filter((row): row is KeywordNodeRow => Boolean(row));
}

// 召回结果必须附带时间元数据（projectneed 15-12-6）：检索命中一律带 createdAt/updatedAt，
// agent 采信前先看时间；树索引等导航输出不在此列。
export function includeWithTimestamps(include: Set<string> = new Set()) {
  const next = new Set(include);
  next.add('timestamps');
  return next;
}

export function formatKeywordResultRows(rows: KeywordNodeRow[] = [], terms: string[] = [], payload: Payload = {}, include: Set<string> = new Set()) {
  // includeLabels（find --labels，opt-in）：命中行附 doc 层级(event/memory/knowledge)与节点 trust，
  // 供调用方一眼分层/分信任；不开则不带这些字段，保持输出精简。
  const labels = payload?.includeLabels === true;
  return rows.map((row) => {
    const hit = keywordHitSummary(row, terms);
    const node = formatContentNode({ ...row, score: hit.score }, {
      detail: 'summary',
      include: includeWithTimestamps(include),
      previewChars: payload.previewChars ?? payload.preview_chars
    });
    node.rowHits = hit.rowHits;
    node.termCount = hit.termCount;
    if (labels) node.trustLevel = row.trust_level || null;
    return {
      doc: {
        docId: row.doc_id,
        title: row.doc_title || '',
        ...(labels ? { kind: row.doc_kind || null } : {})
      },
      node
    };
  });
}

// keyword 召回的候选行（轻量字段，供 Aho-Corasick 扫描与 scope 过滤）。
// scope（docId / scopeAddress）在 SQL 层缩小；docFilter / trust / 时间窗在 keywordRowInScope 兜底。
// allDocs 且无 docId 时取全库——keyword 字面召回接受全库扫，AC 扫描是线性的。
// 流式迭代（14-3-3 只规定「扫描」、不规定物化形态）：逐行进 JS，内存 O(命中数) 而非 O(范围全表)，
// 大库下从「全量 .all() 必然 OOM」变成「慢但跑得完」。扫描行集与每行输入不变，召回逐字节等价。
export function keywordScanRows(store: IftreeStore, payload: Payload = {}): IterableIterator<KeywordNodeRow> {
  const { sql, params } = keywordWhereSql(payload, [], {});
  return store.db!.prepare(`
    SELECT n.id, n.doc_id, n.address, n.node_title, n.text, n.node_note, n.trust_level, n.updated_at, n.depth
    FROM nodes n
    JOIN docs d ON d.id = n.doc_id
    WHERE ${sql}
  `).iterate<KeywordNodeRow>(...params);
}

// 用 Aho-Corasick 一次扫遍候选行，标出每行命中的词键集合。
// 全量、不漏、不截断——这是 keyword「字面连续命中」的精确召回（projectneed 14-3-3）。
// haystack 随命中行缓存：排序（compareKeywordHits）与 minScore 过滤复用同一份，
// 不再每次重建——纯记忆化，同输入同输出。
export function scanKeywordHits(rows: Iterable<KeywordNodeRow> = [], termKeys: string[] = []) {
  const hitRows: KeywordHit[] = [];
  // 单词快路径：AC 对单模式串的命中判定 ≡ indexOf 命中（AC 算法正确性定理）；
  // indexOf 走 V8 优化子串查找，比自绘 AC 的 JS 逐字符循环快一个数量级。多词仍一遍 AC。
  if (termKeys.length === 1) {
    const needle = termKeys[0]!;
    for (const row of rows) {
      const haystack = keywordHaystack(row);
      if (needle && haystack.includes(needle)) hitRows.push({ row, hits: new Set([needle]), haystack });
    }
    return hitRows;
  }
  const matcher = buildAhoCorasickMatcher(termKeys.map((key) => ({ key })));
  for (const row of rows) {
    const haystack = keywordHaystack(row);
    const hits = new Set<string>();
    matcher.scan(haystack, (pattern) => hits.add(pattern.key));
    if (hits.size > 0) hitRows.push({ row, hits, haystack });
  }
  return hitRows;
}

// BM25 相关性分（node_id -> score），仅用于给已召回的命中排序、不参与召回。
// FTS 不可用时返回 null（排序退化为命中量兜底）。rankLimit 决定参与 BM25 打分的候选规模，
// 可由调用方显式调大；够不到的长尾由命中量兜底，不影响召回完整性。
export async function keywordBm25Scores(ctx: QueryContext = {}, terms: string[] = [], docId: string | null = null, rankLimit = 1000) {
  if (typeof ctx.keywordSearch !== 'function') return null;
  if (typeof ctx.ensureKeywordIndexReady === 'function') {
    try {
      await ctx.ensureKeywordIndexReady({ docId, allDocs: docId == null });
    } catch { /* 排序信号缺失只让排序退化，召回已由 AC 兜全 */ }
  }
  const candidates = await ctx.keywordSearch({ terms, docId, limit: rankLimit });
  const scores = new Map<string, number>();
  for (const candidate of candidates) {
    const id = String(candidate.node_id || '');
    if (id && !scores.has(id)) scores.set(id, Number(candidate.score) || 0);
  }
  return scores;
}

// 命中节点排序：BM25 分降序 → 命中词数降序 → 字面命中次数降序 → 地址升序。
// BM25 缺分（FTS 未覆盖的长尾或索引缺失）按命中量兜底，保证次序稳定确定。
export function compareKeywordHits(left: KeywordHit, right: KeywordHit, scores: Map<string, number> | null, terms: string[]) {
  if (scores) {
    const leftScore = scores.has(String(left.row.id)) ? scores.get(String(left.row.id))! : -Infinity;
    const rightScore = scores.has(String(right.row.id)) ? scores.get(String(right.row.id))! : -Infinity;
    if (leftScore !== rightScore) return rightScore - leftScore;
  }
  if (left.hits.size !== right.hits.size) return right.hits.size - left.hits.size;
  const leftHits = keywordHitCountInHaystack(left.haystack ?? keywordHaystack(left.row), terms);
  const rightHits = keywordHitCountInHaystack(right.haystack ?? keywordHaystack(right.row), terms);
  if (leftHits !== rightHits) return rightHits - leftHits;
  return String(left.row.address || '').localeCompare(String(right.row.address || ''));
}

export async function queryContentKeyword(store: IftreeStore, payload: Payload = {}, ctx: QueryContext = {}) {
  const terms = normalizeKeywordTerms(payload);
  if (terms.length === 0) return { kind: 'content.searchKeyword', terms, rows: [] };
  const termKeys = [...new Set(terms.map((term) => term.toLowerCase()).filter(Boolean))];
  // 展示条数：max 放宽到 1000，调用方可显式调大（旧实现卡死在 100）。
  const limit = normalizeLimit(payload.limit, 100, 1000);
  const offset = normalizeNonNegativeInteger(payload.offset ?? payload.start ?? payload.startOffset ?? payload.start_offset, 0);
  // BM25 排序参与的候选规模：可显式调大；只影响长尾排序精度、不影响召回完整性。
  const rankLimit = normalizeLimit(payload.rankLimit ?? payload.candidateLimit ?? payload.candidate_limit, 1000, 100000);
  const include = contentIncludeSet(payload);
  const matchMode = normalizeKeywordMatchMode(payload);
  const docFilter = resolveKeywordDocFilter(store, payload, ctx);
  const docId = payload.allDocs === true || payload.all_docs === true || payload.scope === 'all'
    ? null
    : normalizeQueryId(payload.scopeDocId ?? payload.scope_doc_id ?? payload.docId ?? payload.doc_id, null);
  // 跨文档（allDocs）默认排除 . 开头隐藏路径文档（15-7-3）；单篇显式定位（含定位到隐藏文档）不受限。
  const hiddenExcluded = docId ? null : resolveHiddenDocExclusion(store, payload, ctx);
  const rowHidden = (row: KeywordNodeRow) => hiddenExcluded != null && hiddenExcluded.has(String(row.doc_id));
  // 流式过滤生成器：与原先的 .filter().filter() 谓词完全相同、顺序相同，只改物化形态。
  function* iterateInScopeRows(): Generator<KeywordNodeRow> {
    for (const row of keywordScanRows(store, payload)) {
      if (!keywordRowInScope(row, payload, docFilter)) continue;
      if (rowHidden(row)) continue;
      yield row;
    }
  }
  // 统计用：当前范围可检索的文档数（doc 级过滤 + 隐藏排除后的允许集 / 单篇=1 / 全库总数）。
  // 让 find 返回统计行能把"0 命中"区分成"范围本身就空"还是"范围内没命中"。
  const scopeDocs = docFilter
    ? [...docFilter].filter((id) => !(hiddenExcluded && hiddenExcluded.has(String(id)))).length
    : (docId
        ? 1
        : Math.max(0, (Number(store.db!.prepare('SELECT COUNT(*) AS c FROM docs').get()?.c) || 0) - (hiddenExcluded ? hiddenExcluded.size : 0)));

  // 召回：Aho-Corasick 全量扫范围节点的字面命中（不漏、不截断）；scope/过滤在 JS 兜底。
  // 全程流式：范围行逐行进 JS 过滤、只收集命中行，不物化范围全表。
  const hitRows = scanKeywordHits(iterateInScopeRows(), termKeys);
  // 排序信号：BM25（仅排序，不影响召回完整性）。
  const scores = await keywordBm25Scores(ctx, terms, docId, rankLimit);

  if (matchMode === 'or') {
    // 按词分组：每组是命中该词的全部节点，组内按相关性排序、各自分页。
    const groups: RowObject[] = [];
    const seen = new Set<string>();
    const flat: RowObject[] = [];
    for (const term of terms) {
      const key = term.toLowerCase();
      const groupHits = hitRows
        .filter((entry) => entry.hits.has(key))
        .sort((left, right) => compareKeywordHits(left, right, scores, terms));
      const page = pageRows(groupHits, offset, limit, 1000);
      const fullRows = keywordRowsByIds(store, page.rows.map((entry) => entry.row.id));
      const formatted = formatKeywordResultRows(fullRows, [term], payload, include);
      groups.push({
        term,
        returned: formatted.length,
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        hasMore: page.hasMore,
        truncated: page.truncated,
        rows: formatted
      });
      for (const item of formatted) {
        const id = String(item.node?.id || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        flat.push(item);
      }
    }
    return {
      kind: 'content.searchKeyword',
      terms,
      matchMode,
      scopeDocs,
      returned: flat.length,
      total: groups.reduce((sum, group) => sum + (Number(group.total) || 0), 0),
      offset,
      limit,
      hasMore: groups.some((group) => group.hasMore),
      truncated: groups.some((group) => group.truncated),
      groups,
      rows: flat
    };
  }

  let ranked;
  if (matchMode === 'doc') {
    // 文档级 AND：保留命中「全部词」的文档（词可分散在不同节点），返回这些文档里命中任一词的节点。
    const perDocKeys = new Map<string, Set<string>>();
    for (const entry of hitRows) {
      const rowDocId = String(entry.row.doc_id);
      if (!perDocKeys.has(rowDocId)) perDocKeys.set(rowDocId, new Set<string>());
      const keySet = perDocKeys.get(rowDocId)!;
      for (const key of entry.hits) keySet.add(key);
    }
    ranked = hitRows.filter((entry) => (perDocKeys.get(String(entry.row.doc_id))?.size || 0) === termKeys.length);
  } else {
    // 节点级 AND：节点正文同时含全部词。
    ranked = hitRows.filter((entry) => entry.hits.size === termKeys.length);
  }
  // minScore（命中次数下限，自 db-shell find --min-score 下沉）：分页前过滤，
  // returned/total 自然是过滤后的真实统计；口径与展示行的 node.score（keywordHitSummary）一致。
  const minScore = payload.minScore != null ? Number(payload.minScore) : null;
  if (minScore != null) {
    ranked = ranked.filter((entry) => keywordHitSummaryInHaystack(entry.haystack ?? keywordHaystack(entry.row), terms).score >= minScore);
  }
  ranked.sort((left, right) => compareKeywordHits(left, right, scores, terms));
  const page = pageRows(ranked, offset, limit, 1000);
  const fullRows = keywordRowsByIds(store, page.rows.map((entry) => entry.row.id));
  const formatted = formatKeywordResultRows(fullRows, terms, payload, include);
  return {
    kind: 'content.searchKeyword',
    terms,
    matchMode,
    scopeDocs,
    returned: formatted.length,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    hasMore: page.hasMore,
    truncated: page.truncated,
    rows: formatted
  };
}

export async function queryContentSearch(
  store: IftreeStore,
  payload: Payload = {},
  ctx: QueryContext = {}
): Promise<ContentSearchResult | Awaited<ReturnType<typeof queryContentSearchAll>>> {
  const docId = normalizeQueryId(payload.docId ?? payload.doc_id, null);
  if (!docId || payload.allDocs === true || payload.all_docs === true || payload.scope === 'all') {
    return queryContentSearchAll(store, payload, ctx);
  }
  const query = String(payload.query ?? payload.q ?? '').trim();
  if (!query) return { kind: 'content.search', docId, query, rows: [] };
  const limit = normalizeLimit(payload.limit, 20, 100);
  const mode = String(payload.searchMode ?? payload.search_mode ?? payload.mode ?? 'keyword').trim();
  const include = contentIncludeSet(payload);
  if (mode === 'vector') {
    if (typeof ctx.vectorSearch !== 'function') {
      return { kind: 'content.search', mode, docId, query, rows: [], error: '向量检索入口未接入' };
    }
    const results = await ctx.vectorSearch({ docId, query, limit });
    let formatted = results.map((result) => {
      const row = result.node as ContentNodeRow | undefined;
      return row ? formatContentNode({ ...row, score: Number(result.score) || 0 }, { detail: 'summary', include: includeWithTimestamps(include) }) : null;
    }).filter((row): row is FormattedContentNode => Boolean(row));
    // scopeAddress（地址前缀范围）与 minScore（相似度下限）：召回后过滤，自 db-shell find --semantic 下沉。
    // weakFilteredOut 告诉调用方「召回了但被判弱相关」的数量，供 0 命中时提示调低 minScore。
    const scopeAddress = String(payload.scopeAddress ?? payload.scope_address ?? '').trim();
    if (scopeAddress) {
      formatted = formatted.filter((row) => row.address === scopeAddress || String(row.address || '').startsWith(`${scopeAddress}-`));
    }
    const minScore = payload.minScore != null ? Number(payload.minScore) : null;
    let weakFilteredOut = 0;
    if (minScore != null) {
      const before = formatted.length;
      formatted = formatted.filter((row) => Number(row.score ?? 0) >= minScore);
      weakFilteredOut = before - formatted.length;
    }
    return {
      kind: 'content.search',
      mode,
      docId,
      query,
      rows: formatted,
      ...(minScore != null ? { minScore, weakFilteredOut } : {})
    };
  }
  const rows = store.searchNodes({ docId, query, limit }) as unknown as ContentNodeRow[];
  return {
    kind: 'content.search',
    mode: 'keyword',
    docId,
    query,
    rows: rows.map((row) => formatContentNode(row, { detail: 'summary', include: includeWithTimestamps(include) }))
  };
}

export function crossDocSearchRows(store: IftreeStore, payload: Payload = {}) {
  const query = String(payload.query ?? payload.q ?? '').trim();
  if (!query) return { query, rows: [], truncated: false };
  const limit = normalizeLimit(payload.limit, 20, 100);
  const escaped = query.replace(/[\\%_]/g, (match) => `\\${match}`);
  const like = `%${escaped}%`;
  const rows = store.db!.prepare(`
    WITH matched AS (
      SELECT n.*,
        d.title AS doc_title,
        d.folder_id AS doc_folder_id,
        d.updated_at AS doc_updated_at,
        sd.source_type,
        sd.original_path,
        (
          SELECT COUNT(*)
          FROM nodes child
          WHERE child.doc_id = n.doc_id AND child.parent_id = n.id
        ) AS child_count
      FROM nodes n
      JOIN docs d ON d.id = n.doc_id
      LEFT JOIN source_documents sd ON sd.doc_id = d.id
      WHERE (
        n.address LIKE ? ESCAPE '\\'
        OR n.node_title LIKE ? ESCAPE '\\'
        OR n.text LIKE ? ESCAPE '\\'
        OR n.node_note LIKE ? ESCAPE '\\'
      )
      ORDER by
        CASE
          WHEN n.address = ? THEN 0
          WHEN n.node_title LIKE ? ESCAPE '\\' THEN 1
          WHEN n.text LIKE ? ESCAPE '\\' THEN 2
          ELSE 3
        END,
        d.title,
        n.depth,
        n.address,
        n.id
      LIMIT ?
    )
    SELECT *
    FROM matched
    ORDER BY
      doc_title,
      doc_id,
      depth,
      address,
      id
  `).all<CrossDocSearchRow>(
    like,
    like,
    like,
    like,
    query,
    like,
    like,
    limit + 1
  );
  return {
    query,
    rows: rows.slice(0, limit),
    truncated: rows.length > limit
  };
}

export function formatCrossDocSearchRow(row: CrossDocSearchRow, payload: Payload = {}, ctx: QueryContext = {}): CrossDocFormattedResult {
  const previewChars = Number(payload.previewChars ?? payload.preview_chars) || 240;
  const text = row.text || '';
  const node: RowObject = {
    docId: row.doc_id,
    address: row.address,
    depth: row.depth,
    type: row.node_type,
    title: row.node_title || '',
    childCount: Number(row.child_count) || 0,
    textPreview: clipText(text, previewChars),
    meta: {
      textChars: nodeTextChars(row)
    }
  };
  // 召回结果必须附带时间元数据（projectneed 15-12-6）。
  node.createdAt = row.created_at || null;
  node.updatedAt = row.updated_at || null;
  const include = contentIncludeSet(payload);
  if (include.has('note') && row.node_note) node.notePreview = clipText(row.node_note, previewChars);
  if (include.has('tags')) {
    node.tags = {
      trustLevel: row.trust_level || null
    };
  }
  if (row.score !== undefined) node.score = row.score;
  return {
    doc: {
      docId: row.doc_id,
      title: row.doc_title || '',
      ...(payload.includeSource === true || payload.include_source === true || contentIncludeSet(payload).has('source')
        ? { source: { type: row.source_type || '', path: libraryRelativeSourcePath(row as Partial<SourceDocumentRow>, ctx) } }
        : {})
    },
    node
  };
}

export function crossDocSearchToAsciiTree(results: CrossDocFormattedResult[] = [], options: Payload = {}) {
  const byDoc = new Map<string, { doc: RowObject; rows: CrossDocFormattedResult[] }>();
  for (const result of results) {
    const docId = String(result.doc?.docId || '');
    if (!byDoc.has(docId)) {
      byDoc.set(docId, {
        doc: result.doc,
        rows: []
      });
    }
    byDoc.get(docId)!.rows.push(result);
  }
  const lines: string[] = [];
  for (const group of byDoc.values()) {
    const source = group.doc.source as RowObject | undefined;
    const sourcePath = source?.path ? ` path=${cleanTreeLabel(source.path, 120)}` : '';
    lines.push(`doc#${group.doc.docId} ${cleanTreeLabel(group.doc.title || `Doc ${group.doc.docId}`, 90)}${sourcePath}`);
    for (let index = 0; index < group.rows.length; index += 1) {
      const result = group.rows[index];
      const isLast = index === group.rows.length - 1;
      if (result) lines.push(`${isLast ? '`-- ' : '|-- '}${asciiTreeLabel(result.node as Partial<FormattedContentNode>, options)}`);
    }
  }
  return lines.join('\n');
}

export async function queryContentSearchAll(store: IftreeStore, payload: Payload = {}, ctx: QueryContext = {}) {
  const query = String(payload.query ?? payload.q ?? '').trim();
  const mode = String(payload.searchMode ?? payload.search_mode ?? payload.mode ?? 'keyword').trim();
  if (!query) {
    return contentFormat(payload) === 'ascii_tree'
      ? { kind: 'content.searchAll', format: 'ascii_tree', query, text: '' }
      : { kind: 'content.searchAll', mode: 'keyword', query, rows: [] };
  }
  // searchAll 是跨文档检索：默认排除 . 开头隐藏路径文档（15-7-3），字面/语义同口径。
  const hiddenExcluded = resolveHiddenDocExclusion(store, payload, ctx);
  if (mode === 'vector') {
    if (typeof ctx.vectorSearch !== 'function') {
      return { kind: 'content.searchAll', mode, query, rows: [], error: '向量检索入口未接入' };
    }
    const limit = normalizeLimit(payload.limit, 20, 100);
    const results = await ctx.vectorSearch({ query, limit });
    let formatted = results.map((result) => {
      const row = result.node as ContentNodeRow | undefined;
      if (!row || (hiddenExcluded && hiddenExcluded.has(String(row.doc_id)))) return null;
      return formatCrossDocSearchRow({ ...row, score: Number(result.score) || 0 }, {
        ...payload,
        includeSource: true
      }, ctx);
    }).filter((row): row is CrossDocFormattedResult => Boolean(row));
    // minScore（相似度下限）：召回后过滤，自 db-shell find --semantic 下沉；口径与 content.search 一致。
    const minScore = payload.minScore != null ? Number(payload.minScore) : null;
    let weakFilteredOut = 0;
    if (minScore != null) {
      const before = formatted.length;
      formatted = formatted.filter((row) => Number((row.node as RowObject | undefined)?.score ?? 0) >= minScore);
      weakFilteredOut = before - formatted.length;
    }
    const minScoreMeta = minScore != null ? { minScore, weakFilteredOut } : {};
    if (contentFormat(payload) === 'ascii_tree') {
      return {
        kind: 'content.searchAll',
        format: 'ascii_tree',
        mode,
        query,
        returned: formatted.length,
        ...minScoreMeta,
        text: crossDocSearchToAsciiTree(formatted, {
          previewChars: payload.previewChars ?? payload.preview_chars
        })
      };
    }
    return {
      kind: 'content.searchAll',
      mode,
      query,
      returned: formatted.length,
      ...minScoreMeta,
      rows: formatted
    };
  }
  const { rows, truncated } = crossDocSearchRows(store, payload);
  const visibleRows = hiddenExcluded ? rows.filter((row) => !hiddenExcluded.has(String(row.doc_id))) : rows;
  const results = visibleRows.map((row) => formatCrossDocSearchRow(row, {
    ...payload,
    includeSource: true
  }, ctx));
  if (contentFormat(payload) === 'ascii_tree') {
    return {
      kind: 'content.searchAll',
      format: 'ascii_tree',
      mode: 'keyword',
      query,
      returned: results.length,
      truncated,
      text: crossDocSearchToAsciiTree(results, {
        previewChars: payload.previewChars ?? payload.preview_chars
      })
    };
  }
  return {
    kind: 'content.searchAll',
    mode: 'keyword',
    query,
    returned: results.length,
    truncated,
    rows: results
  };
}

// 实体同义扩展检索（自 db-shell find --entity --expand 编排下沉，13 章）：每个输入词独立扩展
// 同义组（OR 召回），词组之间保持 AND 框架——节点须每个原始词组至少命中一词；去重后按 limit 截断。
// 范围/过滤参数（docId/allDocs/workspace/kind/trust/时间窗/folder/includeLabels…）原样透传给
// entity.listRelated 与 content.searchKeyword，两段都是 L4 内组合、不出层。
export async function queryContentSearchEntityExpand(store: IftreeStore, payload: Payload = {}, ctx: QueryContext = {}) {
  const terms = normalizeKeywordTerms(payload);
  if (terms.length === 0) throw new Error('content.searchEntityExpand requires at least one term');
  const related = runEntityRead(store, { ...payload, terms, limit: 1000 }, 'entity.listRelated', ctx) as {
    rows?: Array<{ relation?: unknown; seed?: RowObject; entity?: RowObject }>;
  };
  const synonymsByTerm = new Map<string, Set<string>>();
  for (const row of related.rows || []) {
    if (row.relation !== 'synonym') continue;
    const seedLiteral = String(row.seed?.literal || '').trim().toLowerCase();
    if (!seedLiteral) continue;
    const group = synonymsByTerm.get(seedLiteral) || new Set<string>();
    group.add(String(row.entity?.literal || '').trim());
    synonymsByTerm.set(seedLiteral, group);
  }
  const expandedTermGroups = terms.map((term) => {
    const synonyms = synonymsByTerm.get(term.trim().toLowerCase());
    return synonyms ? [term, ...synonyms] : [term];
  });
  const limit = normalizeLimit(payload.limit, 100, 1000);
  // OR 召回放大：AND 框架过滤会筛掉大量单组命中，召回预算按最终 limit ×5 放大。
  const allTerms = [...new Set(expandedTermGroups.flat())];
  const search = await queryContentKeyword(store, {
    ...payload,
    terms: allTerms,
    matchMode: 'or',
    limit: Math.min(limit * 5, 1000)
  }, ctx) as RowObject & {
    groups?: Array<RowObject & { term?: unknown; rows?: RowObject[] }>;
    rows?: RowObject[];
  };
  const rowNodeId = (row: RowObject) => {
    const node = (row.node as RowObject | undefined) || row;
    return String(node.node_id ?? node.id ?? '');
  };
  // AND 框架过滤：节点必须每个原始词组至少命中一个词。
  const nodeTermHits = new Map<string, Set<string>>();
  for (const group of search.groups || []) {
    const hitTerm = String(group.term || '').trim().toLowerCase();
    for (const row of group.rows || []) {
      const nodeId = rowNodeId(row);
      if (!nodeId) continue;
      let termSet = nodeTermHits.get(nodeId);
      if (!termSet) { termSet = new Set(); nodeTermHits.set(nodeId, termSet); }
      termSet.add(hitTerm);
    }
  }
  const matchingNodeIds = new Set<string>();
  for (const [nodeId, hitTerms] of nodeTermHits) {
    const allGroupsCovered = expandedTermGroups.every((group) =>
      group.some((term) => hitTerms.has(term.toLowerCase()))
    );
    if (allGroupsCovered) matchingNodeIds.add(nodeId);
  }
  // 去重（OR 召回可能有重复节点）后按 limit 截断。
  const seenNodes = new Set<string>();
  const filtered: RowObject[] = [];
  for (const row of search.rows || []) {
    const nodeId = rowNodeId(row);
    if (!nodeId || !matchingNodeIds.has(nodeId) || seenNodes.has(nodeId)) continue;
    seenNodes.add(nodeId);
    filtered.push(row);
  }
  const limited = filtered.slice(0, limit);
  return {
    kind: 'content.searchEntityExpand',
    terms,
    // 每个原始词的展开组（无同义时 expanded 只含词本身）；供调用方渲染「同义扩展」提示行。
    expansions: terms.map((term, index) => ({ term, expanded: expandedTermGroups[index] })),
    returned: limited.length,
    total: filtered.length,
    rows: limited
  };
}

