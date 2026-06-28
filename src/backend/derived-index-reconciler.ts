import type Database from 'better-sqlite3';
import { keywordIndexRowsForAllDocs } from './keyword-index.js';
import { KeywordStore, type KeywordSearchInput } from '../vector/keyword-store.js';
import { VectorStore, type VectorUpsertPayload } from '../vector/vector-store.js';
import { normalizeStableId } from './db/ids.js';
import { normalizeSemanticStatus } from './semantic-status.js';
import { computeSubtreeHashes, type MerkleNode, type SubtreeHashEntry } from '../core/merkle.js';
import type { NodeRow } from './db/rows.js';

type Resolvable<T> = T | ((...args: never[]) => T);

export interface ReconcilerStore {
  db: Database;
}

export interface VectorConfig {
  dimensions?: number;
  batchSize?: number;
  workerCount?: number;
  maxInputTokens?: number;
}

export interface ReconcilerOptions {
  lanceDbPath?: Resolvable<string>;
  getStore?: Resolvable<ReconcilerStore>;
  getVectorConfig?: Resolvable<VectorConfig>;
  isVectorModuleEnabled?: () => boolean;
  vectorDisabledMessage?: string;
  countTokens?: (text: string) => number | Promise<number>;
  embedTexts?: (texts: string[]) => Promise<number[][]>;
}

export type ProgressEvent =
  | { stage: 'scan'; docId: unknown; nodeCount: number; vectorCountBefore: number; staleCount: number; changedCount: number }
  | { stage: 'batch_done'; docId: unknown; scanned: number; missingInserted: number; changedDeleted: number; workers: number; embedChunk: number; upserted: number }
  | { stage: 'done'; docId: unknown; scanned: number; vectorCountAfter: number; missingInserted: number; changedDeleted: number; staleDeleted: number };

export interface EnsureDocVectorsOptions {
  onProgress?: (event: ProgressEvent) => void | Promise<void>;
}

interface PendingItem {
  id: string;
  text: string;
  contentHash?: string;
  subtreeHash?: string;
}

interface SkippedItem {
  id: string;
  tokens: number;
  maxTokens: number;
}

interface PartitionResult<T> {
  embeddable: T[];
  skipped: SkippedItem[];
}

interface NodeRowForReconcile extends MerkleNode {
  id: string;
  doc_id?: string;
  parent_id: string | null;
  sort_order: number;
  text: string;
  node_title: string;
  node_note: string;
  node_type: string;
  trust_level: string | null;
}

interface NodeKeywordRow {
  id: string;
  doc_id: string;
  address: string;
  node_title: string;
  text: string;
  node_note: string;
  updated_at: string;
  [extra: string]: unknown;
}

interface NodeScanRow {
  id: string;
  text: string;
  node_title: string;
  node_note: string;
}

interface DocVectorStatusEntry {
  enabled: boolean;
  available?: boolean;
  vectorCount: number;
  nodeCount?: number;
  reason?: string;
}

interface MaintenanceOptions {
  cleanupOlderThan?: Date | null;
}

interface MaintainAfterWriteOptions {
  deleted?: boolean;
  allDocs?: boolean;
  embed?: boolean;
  touchedNodeIds?: unknown[] | null;
  deletedNodeIds?: unknown[] | null;
}

export interface ReconcileOptions {
  fillNow?: boolean;
  dryRun?: boolean;
}

export interface ReconcileResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  docId?: unknown;
  fillNow?: boolean;
  pendingCount?: number;
  orphanCount?: number;
  filled?: number;
  deleted?: number;
  ready?: boolean;
  skippedNodes?: SkippedItem[];
  skippedCount?: number;
}

interface IntegrityScanCallbacks {
  onMissing?: ((item: { id: string; text: string }) => void | Promise<void>) | null;
  onChanged?: ((item: { id: string; text: string }) => void | Promise<void>) | null;
  onBatchEnd?: ((info: { scanned: number }) => void | Promise<void>) | null;
}

interface IntegrityResult {
  nodeCount: number;
  vectorCountBefore: number;
  existingCurrent: number;
  missingCount: number;
  changedCount: number;
  staleIds: string[];
}

function resolveValue<T>(value: Resolvable<T> | undefined, fallback: T | null = null): T | null {
  if (typeof value === 'function') return (value as () => T)();
  if (value === undefined || value === null) return fallback;
  return value;
}

function positiveIds(values: unknown[] = []): string[] {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => normalizeStableId(value))
    .filter((value): value is string => Boolean(value)))];
}

// 嵌入对象（第 2 步）：标题 + 正文 + 备注（content_hash 本就含这三者，重嵌不再白费一次）。
// 只对已嵌节点（正文非空）enrich 输入、不扩大节点集——降影响面、对齐 plan 主旨。
function embedInputOf(row: { node_title?: unknown; text?: unknown; node_note?: unknown }): string {
  return [row.node_title, row.text, row.node_note]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join('\n');
}

export interface DerivedIndexReconciler {
  ensureKeywordIndexRows(rows?: unknown[]): Promise<void>;
  rebuildKeywordIndexForDoc(docId: unknown): Promise<void>;
  rebuildKeywordIndexForNodes(docId: unknown, touchedIds?: unknown[], deletedIds?: unknown[]): Promise<void>;
  rebuildKeywordIndexForAllDocs(): Promise<void>;
  optimizeKeywordIndex(options?: MaintenanceOptions): Promise<unknown>;
  optimizeVectorIndex(options?: MaintenanceOptions): Promise<unknown>;
  runMaintenance(options?: MaintenanceOptions): Promise<{ ok: boolean; keyword?: unknown; vector?: unknown }>;
  deleteKeywordDoc(docId: unknown): Promise<void>;
  keywordSearch(input?: KeywordSearchInput): Promise<unknown>;
  resetVectorStoreTable(dimensions?: number): Promise<void>;
  requireDocVectorIndex(docId: unknown): Promise<true>;
  docVectorStatus(docIds?: unknown[]): Promise<Record<string, DocVectorStatusEntry>>;
  ensureDocVectors(docId: unknown, options?: EnsureDocVectorsOptions): Promise<Record<string, unknown>>;
  refreshDocSemanticMeta(docId: unknown): Promise<void>;
  backfillDocSemanticMeta(options?: { onlyMissing?: boolean }): Promise<{ ok: true; filled: number }>;
  deleteDocVectors(docId: unknown): Promise<void>;
  pruneStaleDocVectors(docId: unknown): Promise<Record<string, unknown>>;
  reconcile(docId: unknown, options?: ReconcileOptions): Promise<ReconcileResult>;
  maintainDerivedAfterWrite(docId: unknown, options?: MaintainAfterWriteOptions): Promise<Record<string, unknown>>;
  vectorSearch(payload?: { docId?: unknown; query?: string; limit?: number }): Promise<unknown>;
  readContext(): {
    docVectorStatus: DerivedIndexReconciler['docVectorStatus'];
    ensureKeywordIndexRows: DerivedIndexReconciler['ensureKeywordIndexRows'];
    ensureKeywordIndexReady: (payload?: Record<string, unknown>) => Promise<void>;
    keywordSearch: DerivedIndexReconciler['keywordSearch'];
    vectorSearch: DerivedIndexReconciler['vectorSearch'];
  };
  writeContext(): {
    ensureDocVectors: DerivedIndexReconciler['ensureDocVectors'];
    refreshDocSemanticMeta: DerivedIndexReconciler['refreshDocSemanticMeta'];
    backfillDocSemanticMeta: DerivedIndexReconciler['backfillDocSemanticMeta'];
    isVectorModuleEnabled: () => boolean;
    rebuildKeywordIndexForDoc: DerivedIndexReconciler['rebuildKeywordIndexForDoc'];
    rebuildKeywordIndexForNodes: DerivedIndexReconciler['rebuildKeywordIndexForNodes'];
    rebuildKeywordIndexForAllDocs: DerivedIndexReconciler['rebuildKeywordIndexForAllDocs'];
    optimizeKeywordIndex: DerivedIndexReconciler['optimizeKeywordIndex'];
    deleteKeywordDoc: DerivedIndexReconciler['deleteKeywordDoc'];
    deleteDocVectors: DerivedIndexReconciler['deleteDocVectors'];
    pruneStaleDocVectors: DerivedIndexReconciler['pruneStaleDocVectors'];
    reconcile: DerivedIndexReconciler['reconcile'];
    maintainDerivedAfterWrite: DerivedIndexReconciler['maintainDerivedAfterWrite'];
  };
  close(): void;
}

export function createDerivedIndexReconciler(options: ReconcilerOptions = {}): DerivedIndexReconciler {
  let keywordStore: KeywordStore | null = null;
  let vectorStore: VectorStore | null = null;

  function lanceDbPath(): string {
    const value = String(resolveValue(options.lanceDbPath, '') || '').trim();
    if (!value) throw new Error('derived index reconciler requires lanceDbPath');
    return value;
  }

  function getStore(): ReconcilerStore {
    const store = resolveValue(options.getStore);
    if (!store?.db) throw new Error('derived index reconciler requires an initialized store');
    return store;
  }

  function getVectorConfig(): VectorConfig {
    return resolveValue(options.getVectorConfig, {} as VectorConfig) || {};
  }

  function isVectorModuleEnabled(): boolean {
    return options.isVectorModuleEnabled?.() === true;
  }

  function assertVectorModuleEnabled(): void {
    if (!isVectorModuleEnabled()) throw new Error(options.vectorDisabledMessage || '向量模块已由用户禁用');
  }

  // 嵌入前按 token 预算分桶（第 2 步守卫）：超模型窗口的节点跳过（不嵌、不中断整批，避免后端 HTTP 400
  // 整批空转），记进 skipped 供回执醒目列出、引导拆分。countTokens（注入）或 maxInputTokens（按模型配置）
  // 任一缺失 → 守卫关闭、全部可嵌（旧行为）。item.text 即嵌入串（embedInputOf 产出）。
  async function partitionByBudget<T extends { id: string; text: string }>(items: T[] = []): Promise<PartitionResult<T>> {
    const maxTokens = Number(getVectorConfig().maxInputTokens) || 0;
    if (!maxTokens || typeof options.countTokens !== 'function') {
      return { embeddable: items, skipped: [] };
    }
    const embeddable: T[] = [];
    const skipped: SkippedItem[] = [];
    for (const item of items) {
      const tokens = await options.countTokens(item.text);
      if (tokens > maxTokens) skipped.push({ id: item.id, tokens, maxTokens });
      else embeddable.push(item);
    }
    return { embeddable, skipped };
  }

  async function getKeywordStore(): Promise<KeywordStore> {
    if (!keywordStore) {
      keywordStore = new KeywordStore(lanceDbPath());
      await keywordStore.init();
    }
    return keywordStore;
  }

  async function ensureKeywordIndexRows(rows: unknown[] = []): Promise<void> {
    const keywords = await getKeywordStore();
    await keywords.ensureRows(rows as Parameters<KeywordStore['ensureRows']>[0]);
  }

  // 整篇重建该文档 BM25：分批游标拉 SQL 行（绝不全量进内存），扛百万字大文档。
  async function rebuildKeywordIndexForDoc(docId: unknown): Promise<void> {
    const keywords = await getKeywordStore();
    await rebuildDocKeywordIncremental(keywords, docId);
  }

  async function rebuildKeywordIndexForAllDocs(): Promise<void> {
    const keywords = await getKeywordStore();
    await keywords.replaceRows(keywordIndexRowsForAllDocs(getStore()));
  }

  // 分批补建某 doc 的关键字索引：delete + 按 id 游标分批拉 SQL 行 add，绝不全量进 JS 内存。
  async function rebuildDocKeywordIncremental(keywords: KeywordStore, docId: unknown): Promise<void> {
    await keywords.deleteDoc(docId);
    const stmt = getStore().db.prepare(`
      SELECT id, doc_id, address, node_title, text, node_note, updated_at
      FROM nodes WHERE doc_id = ? AND id > ? ORDER BY id LIMIT ?
    `);
    const BATCH = 5000;
    let lastId = '';
    for (;;) {
      const rows = stmt.all<NodeKeywordRow>(docId, lastId, BATCH);
      if (rows.length === 0) break;
      await keywords.addRows(rows);
      lastId = rows[rows.length - 1].id;
      if (rows.length < BATCH) break;
    }
  }

  // 增量同步某 doc 的关键字索引（4-6-2）：只删改动/删除节点的旧行、只补改动节点的当前行，
  // 避免整篇 deleteDoc + 重灌（LanceDB append-only 下整篇重灌是碎片/版本爆炸的根源）。
  // touched = 新增 + keyword 内容变化的节点（仍存在）；deleted = 已删节点（已不在 nodes）。
  async function rebuildKeywordIndexForNodes(docId: unknown, touchedIds: unknown[] = [], deletedIds: unknown[] = []): Promise<void> {
    const keywords = await getKeywordStore();
    const touched = [...new Set((touchedIds || []).map((v) => String(v ?? '').trim()).filter(Boolean))];
    const deleted = [...new Set((deletedIds || []).map((v) => String(v ?? '').trim()).filter(Boolean))];
    const toDelete = [...new Set([...touched, ...deleted])];
    if (toDelete.length > 0) await keywords.deleteNodes(toDelete);
    if (touched.length === 0) return;
    // 拉 touched 的当前行补回（分批，避免 SQL IN 过长）。删除的节点不在此集合，自然不会被补回。
    const db = getStore().db;
    const BATCH = 500;
    for (let i = 0; i < touched.length; i += BATCH) {
      const chunk = touched.slice(i, i + BATCH);
      const rows = db.prepare(`
        SELECT id, doc_id, address, node_title, text, node_note, updated_at
        FROM nodes WHERE doc_id = ? AND id IN (${chunk.map(() => '?').join(',')})
      `).all<NodeKeywordRow>(docId, ...chunk);
      if (rows.length > 0) await keywords.addRows(rows);
    }
  }

  // 关键字索引碎片回收（任务 2，触发点待定，不挂在读写热路径）：LanceDB append-only MVCC 下 add/delete
  // 持续累积 data fragment 与历史版本、从不自动回收（实测可堆到 1335 碎片 / 2440 旧版本 / 3.6GB），
  // 把 deleteDoc/add 拖慢近一个数量级。compaction 合并碎片；给 cleanupOlderThan 连带 prune 旧版本。
  async function optimizeKeywordIndex({ cleanupOlderThan = null }: MaintenanceOptions = {}): Promise<unknown> {
    const keywords = await getKeywordStore();
    return keywords.optimize({ cleanupOlderThan });
  }

  // 向量表碎片回收（与 keyword 对称）。向量模块禁用时跳过。
  async function optimizeVectorIndex({ cleanupOlderThan = null }: MaintenanceOptions = {}): Promise<unknown> {
    if (!isVectorModuleEnabled()) return { ok: true, skipped: 'vector-disabled' };
    const vectors = await getVectorStore();
    return vectors.optimize({ cleanupOlderThan });
  }

  // 向量模块自给自足的后台维护（4-6）：回收 keyword + vector 两个 lance 表的碎片/旧版本。
  // 由主库的维护调度器派发信号触发——调度器只发信号、不知道这里做什么；主库维护逻辑不内联这段（解耦）。
  async function runMaintenance({ cleanupOlderThan = null }: MaintenanceOptions = {}): Promise<{ ok: boolean; keyword?: unknown; vector?: unknown }> {
    const olderThan = cleanupOlderThan || new Date();
    const out: { keyword?: unknown; vector?: unknown } = {};
    try { out.keyword = await optimizeKeywordIndex({ cleanupOlderThan: olderThan }); }
    catch (error) { out.keyword = { ok: false, error: (error as { message?: string } | null)?.message || String(error) }; }
    if (isVectorModuleEnabled()) {
      try { out.vector = await optimizeVectorIndex({ cleanupOlderThan: olderThan }); }
      catch (error) { out.vector = { ok: false, error: (error as { message?: string } | null)?.message || String(error) }; }
    }
    return { ok: true, ...out };
  }

  // 查询时确保关键字索引就绪：入库已增量维护，这里只用计数比对判断是否缺失，
  // 缺失才分批补建（一次），绝不每次查询全量重建（projectneed 4-16）。
  async function ensureKeywordIndexReady(payload: Record<string, unknown> = {}): Promise<void> {
    const store = getStore();
    const keywords = await getKeywordStore();
    const allDocs = payload.allDocs === true || payload.all_docs === true || payload.scope === 'all';
    let docIds: string[];
    if (allDocs) {
      docIds = store.db!.prepare('SELECT id FROM docs').all<{ id: string }>().map((row) => String(row.id));
    } else {
      const docId = normalizeStableId(payload.scopeDocId ?? payload.scope_doc_id ?? payload.docId ?? payload.doc_id, null);
      docIds = docId ? [docId] : [];
    }
    for (const docId of docIds) {
      const sqlCount = Number(store.db!.prepare('SELECT COUNT(*) AS c FROM nodes WHERE doc_id = ?').get<{ c: number }>(docId)?.c) || 0;
      if (sqlCount === 0) continue;
      const kwCount = Math.max(0, Number(await keywords.countDocRows(docId)) || 0);
      if (kwCount >= sqlCount) continue;
      await rebuildDocKeywordIncremental(keywords, docId);
    }
  }

  async function deleteKeywordDoc(docId: unknown): Promise<void> {
    const keywords = await getKeywordStore();
    await keywords.deleteDoc(docId);
  }

  async function keywordSearch({ terms = [], docId = null, limit }: KeywordSearchInput = {}): Promise<unknown> {
    const keywords = await getKeywordStore();
    return keywords.search({ terms, docId, limit });
  }

  async function getVectorStore(): Promise<VectorStore> {
    assertVectorModuleEnabled();
    if (!vectorStore) {
      vectorStore = new VectorStore(lanceDbPath(), { dimensions: getVectorConfig().dimensions });
      await vectorStore.init();
    }
    return vectorStore;
  }

  async function resetVectorStoreTable(dimensions: number | undefined = getVectorConfig().dimensions): Promise<void> {
    if (vectorStore) {
      vectorStore.close();
      vectorStore = null;
    }
    const vectors = new VectorStore(lanceDbPath(), { dimensions, reset: true });
    await vectors.init();
    vectors.close();
  }

  // 检索就绪 = 完整性（projectneed 14-2）：缺失/陈旧/残留任一存在都不开放语义检索——
  // 带着陈旧向量返回相似度结果是错误输出，不是降级输出。
  async function requireDocVectorIndex(docId: unknown): Promise<true> {
    const result = await reconcile(docId, { dryRun: true });
    if (result.skipped) throw new Error(options.vectorDisabledMessage || '向量模块已由用户禁用');
    if (result.ok === false) throw new Error(`向量索引未就绪（${result.reason || 'doc_not_found'}）`);
    if (!result.ready) {
      throw new Error(
        `向量索引未就绪（待补 ${result.pendingCount}、残留 ${result.orphanCount}）：语义检索不开放，`
        + '交互查询不会现场生成整篇文档向量，请先运行向量补建（reconcile fillNow）补齐；'
        + '期间可改用关键词检索与结构定位。'
      );
    }
    return true;
  }

  // 批量状态（library_index 等列表场景）：行数快筛只是就绪的必要条件，便宜不诚实——
  // 正文一致性由检索入口 requireDocVectorIndex 与完整性检验把关（14-2）。
  async function docVectorStatus(docIds: unknown[] = []): Promise<Record<string, DocVectorStatusEntry>> {
    const ids = positiveIds(docIds);
    const result: Record<string, DocVectorStatusEntry> = {};
    if (!isVectorModuleEnabled()) {
      for (const id of ids) result[id] = { enabled: false, vectorCount: 0, reason: 'vector_disabled' };
      return result;
    }
    try {
      const vectors = await getVectorStore();
      const nodeCountStmt = getStore().db.prepare("SELECT COUNT(*) AS count FROM nodes WHERE doc_id = ? AND TRIM(text) <> ''");
      for (const id of ids) {
        const vectorCount = Math.max(0, Number(await vectors.countDocVectors(id)) || 0);
        const nodeCount = Math.max(0, Number(nodeCountStmt.get<{ count: number }>(id)?.count) || 0);
        result[id] = { enabled: true, available: nodeCount > 0 && vectorCount >= nodeCount, vectorCount, nodeCount };
      }
    } catch (error) {
      for (const id of ids) {
        result[id] = { enabled: false, vectorCount: 0, reason: (error as { message?: string } | null | undefined)?.message || 'vector_unavailable' };
      }
    }
    return result;
  }

  // 持久化语义状态到 docs.meta.semantic（写入维护、读取读列，免每次查 lance 的计算税）。
  // 建/补向量的收口、push/import 落库、启动回填都调它刷新这一列。
  async function refreshDocSemanticMeta(docId: unknown): Promise<void> {
    const id = normalizeStableId(docId);
    if (!id) return;
    const store = getStore();
    const row = store.db!.prepare('SELECT meta FROM docs WHERE id = ?').get<{ meta: string | null }>(id);
    if (!row) return;
    const statusMap = await docVectorStatus([id]);
    const semantic = normalizeSemanticStatus(statusMap[id] || {});
    let meta: Record<string, unknown> = {};
    try { meta = row.meta ? JSON.parse(row.meta) as Record<string, unknown> : {}; } catch { meta = {}; }
    if (!meta || typeof meta !== 'object') meta = {};
    meta.semantic = semantic;
    store.db!.prepare('UPDATE docs SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id);
  }

  // 启动回填：把还没持久化 semantic 的存量文档补上（默认只补 meta.semantic 为 NULL 的，已填的跳过）。
  // 读取侧改读 meta 列后，存量若不回填会显示退化，故后端初始化时后台跑一次。
  async function backfillDocSemanticMeta({ onlyMissing = true }: { onlyMissing?: boolean } = {}): Promise<{ ok: true; filled: number }> {
    const store = getStore();
    const rows = onlyMissing
      ? store.db!.prepare("SELECT id FROM docs WHERE json_extract(meta, '$.semantic') IS NULL").all<{ id: string }>()
      : store.db!.prepare('SELECT id FROM docs').all<{ id: string }>();
    let filled = 0;
    for (const row of rows) {
      try { await refreshDocSemanticMeta(row.id); filled += 1; } catch { /* 单 doc 失败不阻断整体回填 */ }
    }
    return { ok: true, filled };
  }

  async function embedTexts(texts: string[]): Promise<number[][]> {
    if (typeof options.embedTexts !== 'function') throw new Error('derived index reconciler requires embedTexts for vector operations');
    return options.embedTexts(texts);
  }

  // 完整性扫描内核（projectneed 15-8-1 / 14-2）：向量有效性绑 node id + 节点自有正文。
  // LanceDB 行存有 embed 时所见正文，与 SQL 当前正文直接比对——无状态、不靠脏标记：
  //   SQL 有、Lance 无           → missing（缺失）
  //   两边有、正文不一致         → changed（陈旧）
  //   Lance 有、SQL 无或正文已空 → stale（残留）
  // SQL 侧按 id 游标分批、Lance 侧只全取 id 集合（不带正文），正文按批比对，
  // 不把整 doc 两侧正文同时拉进 JS 内存。只扫正文非空节点：结构/标题节点不进向量。
  async function scanDocVectorIntegrity(docId: unknown, { onMissing = null, onChanged = null, onBatchEnd = null }: IntegrityScanCallbacks = {}): Promise<IntegrityResult> {
    const store = getStore();
    const vectors = await getVectorStore();
    const lanceIds = new Set(await vectors.listDocVectorIds(docId));
    const vectorCountBefore = lanceIds.size;
    const SCAN = 1000;
    const stmt = store.db!.prepare("SELECT id, text, node_title, node_note FROM nodes WHERE doc_id = ? AND TRIM(text) <> '' AND id > ? ORDER BY id LIMIT ?");
    let lastId = '';
    let nodeCount = 0;
    let existingCurrent = 0;
    let missingCount = 0;
    let changedCount = 0;
    const seen = new Set<string>();
    for (;;) {
      const rows = stmt.all<NodeScanRow>(docId, lastId, SCAN);
      if (rows.length === 0) break;
      nodeCount += rows.length;
      const presentIds: string[] = [];
      for (const row of rows) {
        const id = String(row.id);
        seen.add(id);
        if (lanceIds.has(id)) presentIds.push(id);
      }
      const lanceText = presentIds.length ? await vectors.textByNodeIds(presentIds) : new Map<string, string>();
      for (const row of rows) {
        const id = String(row.id);
        const current = embedInputOf(row); // 嵌入串 = 标题+正文+备注（与 reconcile 同口径）
        if (!lanceIds.has(id)) {
          missingCount += 1;
          if (onMissing) await onMissing({ id, text: current });
        } else if (lanceText.get(id) !== current) {
          changedCount += 1;
          if (onChanged) await onChanged({ id, text: current });
        } else {
          existingCurrent += 1;
        }
      }
      if (onBatchEnd) await onBatchEnd({ scanned: nodeCount });
      lastId = rows[rows.length - 1].id;
      if (rows.length < SCAN) break;
    }
    const staleIds = [...lanceIds].filter((id) => !seen.has(id));
    return { nodeCount, vectorCountBefore, existingCurrent, missingCount, changedCount, staleIds };
  }

  // 完整性检验 + 补齐（projectneed 15-8-1 / 14-2）：检验与补齐一体——残留删除、
  // 缺失补嵌、正文已变更删旧重嵌；已一致节点不动不重算。中断后重跑天然续传：
  // 已补部分在下一轮变 existingCurrent。保存路径不调用本入口（8-3-2-2/4-6-1）。
  async function ensureDocVectors(docId: unknown, ensureOptions: EnsureDocVectorsOptions = {}): Promise<Record<string, unknown>> {
    const onProgress = typeof ensureOptions.onProgress === 'function' ? ensureOptions.onProgress : null;
    if (!isVectorModuleEnabled()) {
      return { ok: true, skipped: true, reason: 'vector_disabled' };
    }
    const store = getStore();
    const exists = store.db!.prepare('SELECT 1 AS x FROM docs WHERE id = ?').get<{ x: number }>(docId);
    if (!exists) return { ok: false, reason: 'doc_not_found', docId };
    const vectors = await getVectorStore();
    // batchSize 是单个 worker 的基础批大小；workerCount 决定同一文档内并发跑多少个 embedding 子批。
    // 写库仍在 Promise.all 收口后集中 upsert，避免 LanceDB 并发写。
    const vectorConfig = getVectorConfig();
    const batchSize = Math.max(1, Math.min(128, Number(vectorConfig.batchSize) || 16));
    const workerCount = Math.max(1, Math.min(8, Number(vectorConfig.workerCount) || 1));
    const embedChunk = Math.max(batchSize, 256);
    const embedWindow = embedChunk * workerCount;
    let missingInserted = 0;
    let changedDeleted = 0;
    let scannedSoFar = 0;
    const pendingMissing: PendingItem[] = [];
    const pendingChanged: PendingItem[] = [];
    const skippedItems: SkippedItem[] = []; // 超长跳过（第 2 步守卫）：不嵌、不中断整批、汇总进返回。
    // 攒满 workerCount 个 embedChunk 才 embed：扫描批与嵌入批解耦；内存峰值 = workerCount * embedChunk。
    const flushEmbed = async (force = false): Promise<void> => {
      type EmbedBatchItem = PendingItem & { changed: boolean };
      const takeBatch = (): EmbedBatchItem[] => {
        const batch: EmbedBatchItem[] = [];
        while (batch.length < embedChunk && (pendingChanged.length || pendingMissing.length)) {
          if (pendingChanged.length) batch.push({ ...pendingChanged.shift()!, changed: true });
          else batch.push({ ...pendingMissing.shift()!, changed: false });
        }
        return batch;
      };
      const embedBatch = async (batch: EmbedBatchItem[]): Promise<{ changedRows: VectorUpsertPayload[]; missingRows: VectorUpsertPayload[]; skipped: SkippedItem[] }> => {
        const partition = await partitionByBudget(batch);
        const changedRows: VectorUpsertPayload[] = [];
        const missingRows: VectorUpsertPayload[] = [];
        const embeddable = partition.embeddable;
        if (embeddable.length > 0) {
          const embeddings = await embedTexts(embeddable.map((item) => item.text));
          embeddable.forEach((item, index) => {
            const row: VectorUpsertPayload = { nodeId: item.id, docId, text: item.text, vector: embeddings[index] };
            (item.changed ? changedRows : missingRows).push(row);
          });
        }
        return { changedRows, missingRows, skipped: partition.skipped };
      };
      while (
        pendingMissing.length + pendingChanged.length >= embedWindow
        || (force && pendingMissing.length + pendingChanged.length > 0)
      ) {
        const batches: EmbedBatchItem[][] = [];
        while (batches.length < workerCount && (pendingChanged.length || pendingMissing.length)) {
          const batch = takeBatch();
          if (batch.length === 0) break;
          batches.push(batch);
        }
        const changedRows: VectorUpsertPayload[] = [];
        const missingRows: VectorUpsertPayload[] = [];
        const results = await Promise.all(batches.map((batch) => embedBatch(batch)));
        for (const result of results) {
          changedRows.push(...result.changedRows);
          missingRows.push(...result.missingRows);
          for (const item of result.skipped) skippedItems.push(item);
        }
        // 写入恒按 id upsert（vector-store 内 mergeInsert）：changed 覆盖旧行、missing 插入新行，
        // 不再分「先删/直接 add」两路，一次写入即可（也不会再产生重复行）。
        if (changedRows.length || missingRows.length) {
          await vectors.upsertNodeVectors([...changedRows, ...missingRows]);
          changedDeleted += changedRows.length;
          missingInserted += missingRows.length;
        }
        await onProgress?.({
          stage: 'batch_done',
          docId,
          scanned: scannedSoFar,
          missingInserted,
          changedDeleted,
          workers: batches.length,
          embedChunk,
          upserted: changedRows.length + missingRows.length
        });
      }
    };
    const integrity = await scanDocVectorIntegrity(docId, {
      onMissing: async (item) => {
        pendingMissing.push(item);
        await flushEmbed();
      },
      onChanged: async (item) => {
        pendingChanged.push(item);
        await flushEmbed();
      },
      onBatchEnd: async ({ scanned }) => {
        scannedSoFar = scanned;
      }
    });
    // 扫描总结事件：nodes/vectorsBefore/stale/changed 全量统计（ensure-doc-vectors 脚本消费）。
    await onProgress?.({
      stage: 'scan',
      docId,
      nodeCount: integrity.nodeCount,
      vectorCountBefore: integrity.vectorCountBefore,
      staleCount: integrity.staleIds.length,
      changedCount: integrity.changedCount
    });
    await flushEmbed(true);
    const staleDeleted = integrity.staleIds.length
      ? await vectors.deleteNodeVectors(integrity.staleIds)
      : 0;
    const vectorCountAfter = Math.max(0, Number(await vectors.countDocVectors(docId)) || 0);
    await onProgress?.({
      stage: 'done',
      docId,
      scanned: integrity.nodeCount,
      vectorCountAfter,
      missingInserted,
      changedDeleted,
      staleDeleted
    });
    await refreshDocSemanticMeta(docId);
    return {
      ok: true,
      docId,
      nodeCount: integrity.nodeCount,
      vectorCountBefore: integrity.vectorCountBefore,
      vectorCountAfter,
      existingCurrent: integrity.existingCurrent,
      staleDeleted,
      changedDeleted,
      missingInserted,
      skippedNodes: skippedItems,
      skippedCount: skippedItems.length
    };
  }

  // pull 自对账（4-6-1/14-2/15-8-1）：主进程写完 SQL 只发本信号、不传变更集，向量库自查 SQL 对账。
  // 派生索引只读主数据、自算 Merkle 指纹对账自己的向量，不碰主库 content_hash/subtree_hash 列与脏标记
  // （那是版本系统的事，向量库不触发其回写）。subtree_hash top-down 剪枝：未变子树整体跳过，
  // 流式百万节点也只对账变化子树。fillNow=true 当场 embed 待补；false 只删孤儿、返回待补数，
  // 由 completeness 闸拦检索、留待后面补（保存路径不 embed，4-6-1）。
  async function reconcile(docId: unknown, reconcileOptions: ReconcileOptions = {}): Promise<ReconcileResult> {
    if (!isVectorModuleEnabled()) return { ok: true, skipped: true, reason: 'vector_disabled' };
    const id = normalizeStableId(docId);
    if (!id) return { ok: false, reason: 'invalid_doc_id' };
    const fillNow = reconcileOptions.fillNow === true;
    const dryRun = reconcileOptions.dryRun === true;
    const store = getStore();
    if (!store.db!.prepare('SELECT 1 AS x FROM docs WHERE id = ?').get<{ x: number }>(id)) {
      return { ok: false, reason: 'doc_not_found', docId: id };
    }
    const vectors = await getVectorStore();

    // 只读拉本 doc 全节点（结构 + 5 内容字段），自算 Merkle 指纹——不触发主库回写。
    const rows = store.db!.prepare(
      'SELECT id, parent_id, sort_order, text, node_title, node_note, node_type, trust_level FROM nodes WHERE doc_id = ?'
    ).all<NodeRowForReconcile>(id);
    const sqlHashes: Map<string, SubtreeHashEntry> = computeSubtreeHashes(rows);

    // 正文非空节点才进向量；嵌入串 = 标题+正文+备注（embedInputOf）。同时按邻接表建子表（按 sort_order）。
    const textById = new Map<string, string>();
    const childrenByParent = new Map<string, NodeRowForReconcile[]>();
    for (const row of rows) {
      const key = row.parent_id == null ? '__root__' : String(row.parent_id);
      let list = childrenByParent.get(key);
      if (!list) {
        list = [];
        childrenByParent.set(key, list);
      }
      list.push(row);
      if (String(row.text ?? '').trim() !== '') textById.set(String(row.id), embedInputOf(row));
    }
    for (const list of childrenByParent.values()) {
      list.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
    }

    // top-down 逐层剪枝：正文节点 subtree_hash 匹配 lance → 整子树一致、剪掉不下行；否则下行。
    // 待补判定：无 lance 行=缺失；有行且 content_hash 不符=陈旧。旧表迁移遗留的空 content_hash 行
    // 不当陈旧误判——按存储文本核对：文本一致=向量仍有效（嵌的就是这段文本，只缺哈希，不待补），
    // 文本不符=真陈旧待补。空哈希行不持久回填（lance update 不支持按行不同值的批量写、逐行写会把
    // 表打碎片）：每次按文本核就绪，该 doc 重嵌后自带哈希、即恢复剪枝。结构节点（lance 无行）不剪、只下行一层。
    const pending: PendingItem[] = [];
    let layer = (childrenByParent.get('__root__') || []).map((row) => String(row.id));
    while (layer.length) {
      const lanceHashes = await vectors.hashesByNodeIds(layer);
      // 只对「有 lance 行但 content_hash 空」的旧行拉存储文本核对；新表无空哈希行 → 零额外查询。
      const legacyIds = layer.filter((nodeId) => { const l = lanceHashes.get(nodeId); return l && !l.contentHash; });
      const legacyText = legacyIds.length ? await vectors.textByNodeIds(legacyIds) : new Map<string, string>();
      const nextLayer: string[] = [];
      for (const nodeId of layer) {
        const sql = sqlHashes.get(nodeId);
        const lance = lanceHashes.get(nodeId);
        if (lance && sql && lance.subtreeHash && lance.subtreeHash === sql.subtreeHash) continue;
        if (textById.has(nodeId)) {
          const sqlText = textById.get(nodeId)!;
          let stale = false;
          if (!lance) stale = true;                                          // 缺失
          else if (lance.contentHash) stale = lance.contentHash !== (sql?.contentHash || ''); // 有哈希：哈希定夺
          else stale = legacyText.get(nodeId) !== sqlText;                   // 空哈希旧行：文本定夺（一致=有效）
          if (stale) pending.push({ id: nodeId, text: sqlText, contentHash: sql?.contentHash || '', subtreeHash: sql?.subtreeHash || '' });
        }
        const kids = childrenByParent.get(nodeId);
        if (kids) for (const kid of kids) nextLayer.push(String(kid.id));
      }
      layer = nextLayer;
    }

    // 孤儿：lance 有、SQL 正文集已无 → 删（lance 不存父子结构，按全 doc id 差集兜底）。
    // 陈旧：pending 里 lance 已有行但 hash 不符的（正文变了、节点还在）——非 fillNow 也必须删。
    // 陈旧向量比缺失更糟：跨文档语义检索绕过 completeness 闸直接查 lance，留着旧向量会按旧正文打分、
    // 却用 node_id 回查显示新正文（错配）；删成「缺失」是安全降级，下次 fillNow 补回。fillNow 走
    // upsert 覆盖陈旧行、不必单独删。dryRun（completeness 检查）只读：不删、不嵌、只数待补/孤儿。
    const lanceIds = await vectors.listDocVectorIds(id);
    const lanceIdSet = new Set(lanceIds.map(String));
    const orphans = lanceIds.filter((nodeId) => !textById.has(String(nodeId)));
    const staleIds = (dryRun || fillNow) ? [] : pending.filter((item) => lanceIdSet.has(String(item.id))).map((item) => item.id);
    const toDelete = dryRun ? [] : [...orphans, ...staleIds];
    const deleted = toDelete.length ? await vectors.deleteNodeVectors(toDelete) : 0;

    // 超长守卫 + fillNow 当场 embed：分桶跳超长（skipped），embed 余下待补并 upsert（带 Merkle 哈希）。
    // dryRun（completeness 检查）不分桶、只数 pending（超长仍计入待补、自然阻断就绪以引导拆分）。
    let filled = 0;
    let skipped: SkippedItem[] = [];
    if (pending.length && !dryRun) {
      const partition = await partitionByBudget(pending);
      skipped = partition.skipped;
      if (fillNow) {
        const batchSize = Math.max(1, Math.min(128, Number(getVectorConfig().batchSize) || 16));
        const embedChunk = Math.max(batchSize, 256);
        for (let offset = 0; offset < partition.embeddable.length; offset += embedChunk) {
          const batch = partition.embeddable.slice(offset, offset + embedChunk);
          const embeddings = await embedTexts(batch.map((item) => item.text));
          await vectors.upsertNodeVectors(batch.map((item, index) => ({
            nodeId: item.id,
            docId: id,
            text: item.text,
            contentHash: item.contentHash,
            subtreeHash: item.subtreeHash,
            vector: embeddings[index]
          })));
          filled += batch.length;
        }
      }
    }

    if (!dryRun) await refreshDocSemanticMeta(id);
    // ready = 对账后一致：dryRun 看「无待补且无孤儿」；写模式看「可嵌的都嵌了」。超长 skipped 不计入应嵌
    // （它本就不可嵌、报告引导拆分而非硬阻断，plan 落实点3）——否则 filled 永不等于 pending，永远 not ready。
    const embeddableCount = pending.length - skipped.length;
    const ready = dryRun
      ? (pending.length === 0 && orphans.length === 0)
      : (pending.length === 0 || (fillNow && filled === embeddableCount));
    return { ok: true, docId: id, fillNow, pendingCount: pending.length, orphanCount: orphans.length, filled, deleted, ready, skippedNodes: skipped, skippedCount: skipped.length };
  }


  // ── 写侧向量维护已收口进 reconcile（pull 自对账，见本文件 reconcile()）：以下原三个函数功能未删除、只是改由 reconcile 统一承担，别误以为这块功能被砍了 ──
  // 1) 原 upsertVectorForNode（节点改正文后即时重嵌单节点）
  //    → node.update 现发 reconcile(fillNow:false)：保存路径不 embed、只标待补（4-6-1），待补由 completeness 闸或显式 vectors 动词补齐。
  // 2) 原 embedStreamNodes（流式 push 只 embed 这批新节点，O(K)、避 ensureDocVectors 的 OOM 墙）
  //    → stream.push + embed:true 现发 reconcile(fillNow:true)：自查 SQL、subtree_hash 剪枝跳已嵌、只嵌本批新增。
  // 3) 原 deleteVectorsForNodes（编辑落主干清受影响节点的陈旧向量，8-3-2-2）
  //    → 现并入 reconcile 的孤儿/陈旧对账：按最终节点集差集删孤儿+陈旧，比按增量列表删更稳、不漏历史遗留。
  // 调用面切换见 handlers/write/{node,doc,history}.mjs 的 vector.reconcile effect。

  async function deleteDocVectors(docId: unknown): Promise<void> {
    if (!isVectorModuleEnabled()) return;
    const vectors = await getVectorStore();
    await vectors.deleteDoc(docId);
  }

  // 孤儿向量对账清理（4-6-1：只删、不 embed/重算）：editBranch 落主干走「只清陈旧」，
  // 但按本次增量列表（deletedNodeIds/vectorStaleNodeIds）删可能漏掉历史遗留孤儿或未覆盖
  // 的删除，导致向量行数 > 节点数。这里按最终节点集对账，删掉「向量在、节点已不存在」的
  // 行，确保库中不存孤儿（vectorCount 不再虚高）。纯 id 集合差集 + 删除，无 GPU。
  async function pruneStaleDocVectors(docId: unknown): Promise<Record<string, unknown>> {
    if (!isVectorModuleEnabled()) return { ok: true, skipped: true, reason: 'vector_disabled' };
    const vectors = await getVectorStore();
    const lanceIds = Array.from(await vectors.listDocVectorIds(docId));
    if (lanceIds.length === 0) return { ok: true, docId, pruned: 0 };
    const store = getStore();
    const rows = store.db!.prepare('SELECT id FROM nodes WHERE doc_id = ?').all<Pick<NodeRow, 'id'>>(docId);
    const current = new Set(rows.map((r) => String(r.id)));
    const staleIds = lanceIds.filter((id) => !current.has(String(id)));
    if (staleIds.length === 0) return { ok: true, docId, pruned: 0 };
    const pruned = await vectors.deleteNodeVectors(staleIds);
    await refreshDocSemanticMeta(docId);
    return { ok: true, docId, pruned };
  }

  async function vectorSearch({ docId = null, query, limit = 20 }: { docId?: unknown; query?: string; limit?: number } = {}): Promise<unknown> {
    assertVectorModuleEnabled();
    const scopedDocId = normalizeStableId(docId, null);
    if (scopedDocId) await requireDocVectorIndex(scopedDocId);
    const [vector] = await embedTexts([query ?? '']);
    const vectors = await getVectorStore();
    return vectors.search({
      docId: scopedDocId,
      vector,
      limit: limit || 20
    });
  }

  // 写操作落主库之后的派生索引维护（projectneed 4-6）：调用方=写分发收尾（mutation-api）或导入编排层，
  // 主库只报告"这篇文档怎么变了"（普通内容变更 / 删除 / 全库地址重排 + 要不要当场建向量），
  // 派生索引自己消化怎么维护。
  // - BM25 关键词：编辑/导入完即整篇重建该文档（分批游标、扛大文档；纯 CPU、不算计增量）。
  // - 稠密向量：零耦合，默认不建（失活留显式 vectors 动词补）；唯一当场建的情形是导入显式 embed:true
  //   （这里当场全量 reconcile）。删除连带回收向量行（纯删行、不涉 embedding 成本，不清会命中已删内容）。
  async function maintainDerivedAfterWrite(docId: unknown, { deleted = false, allDocs = false, embed = false, touchedNodeIds = null, deletedNodeIds = null }: MaintainAfterWriteOptions = {}): Promise<Record<string, unknown>> {
    if (allDocs) {
      await rebuildKeywordIndexForAllDocs();
      return { ok: true, scope: 'allDocs' };
    }
    const id = normalizeStableId(docId, null);
    if (!id) return { ok: true, scope: 'noop' };
    if (deleted) {
      await deleteKeywordDoc(id);
      await deleteDocVectors(id);
      return { ok: true, docId: id, scope: 'deleted' };
    }
    // 有受影响节点集（merge/save 提供 touched/deleted）→ 增量同步；否则整篇重建（导入/restore/无 hint 兜底）。
    const incremental = Array.isArray(touchedNodeIds) || Array.isArray(deletedNodeIds);
    if (incremental) {
      await rebuildKeywordIndexForNodes(id, touchedNodeIds || [], deletedNodeIds || []);
    } else {
      await rebuildKeywordIndexForDoc(id);
    }
    if (embed) {
      await reconcile(id, { fillNow: true });
    } else {
      // 不建向量，但刷一次向量就绪状态缓存（docs.meta.semantic）：让 index 列表反映当前向量覆盖率
      //（新导入=missing 0/N）。这是派生索引模块维护自己的缓存、读 lance 计数、轻量、不 embedding。
      await refreshDocSemanticMeta(id);
    }
    return { ok: true, docId: id, scope: incremental ? 'keyword(incremental)' : 'keyword', vector: embed };
  }

  function readContext() {
    return {
      docVectorStatus,
      ensureKeywordIndexRows,
      ensureKeywordIndexReady,
      keywordSearch,
      vectorSearch
    };
  }

  function writeContext() {
    return {
      ensureDocVectors,
      refreshDocSemanticMeta,
      backfillDocSemanticMeta,
      isVectorModuleEnabled,
      rebuildKeywordIndexForDoc,
      rebuildKeywordIndexForNodes,
      rebuildKeywordIndexForAllDocs,
      optimizeKeywordIndex,
      deleteKeywordDoc,
      deleteDocVectors,
      pruneStaleDocVectors,
      reconcile,
      maintainDerivedAfterWrite
    };
  }

  function close() {
    if (vectorStore) vectorStore.close();
    vectorStore = null;
    if (keywordStore) keywordStore.close();
    keywordStore = null;
  }

  return {
    ensureKeywordIndexRows,
    rebuildKeywordIndexForDoc,
    rebuildKeywordIndexForNodes,
    rebuildKeywordIndexForAllDocs,
    optimizeKeywordIndex,
    optimizeVectorIndex,
    runMaintenance,
    deleteKeywordDoc,
    keywordSearch,
    resetVectorStoreTable,
    requireDocVectorIndex,
    docVectorStatus,
    ensureDocVectors,
    refreshDocSemanticMeta,
    backfillDocSemanticMeta,
    deleteDocVectors,
    pruneStaleDocVectors,
    reconcile,
    maintainDerivedAfterWrite,
    vectorSearch,
    readContext,
    writeContext,
    close
  };
}
