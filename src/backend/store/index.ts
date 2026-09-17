import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';

import { bodyCharCount } from '../../core/char-count.js';
import { computeSubtreeHashes, computeSubtreeHashesIncremental, type MerkleNode } from '../../core/merkle.js';
import { compareNodeAddress } from '../shared.js';
import {
  TABLES_SQL,
  SCHEMA_VERSION,
  type DocRow,
  type EditBranchRow,
  type NodeRow,
} from '../db/schema.js';
import {
  compareStableIds,
  newStableId,
  requireStableId
} from '../db/ids.js';
import {
  normalizePositiveId,
} from '../db/normalizers.js';
import { renderDocMarkdown } from '../../core/markdown-export.js';
import { EditorSnapshotTokens } from '../editor-session/editor-snapshot-tokens.js';
import * as history from './history.js';
import type {
  CertifyNodesPayload,
  RevertCommitPayload,
  SaveHistorySnapshotPayload
} from './history.js';
import * as editBranch from './edit-branch.js';
import * as editBranchStage from './edit-branch-stage.js';
import * as source from './source.js';
import * as node from './node.js';
import * as axiomRef from './axiom-ref.js';
import * as document from './document.js';
import * as stream from './stream.js';
import * as query from './query.js';
export type { DocMaterializedRows } from './query.js';
import { createMaintenanceScheduler } from './maintenance-scheduler.js';
import type { EditBranchProjectionPort, ExternalEntryPort, StoreDomainPorts } from './domain-port.js';

type RowObject = Record<string, unknown>;
type StoreInitOptions = { readonly?: boolean };
type StoreMaintenanceResult = {
  gc?: unknown;
  checkpoint?: unknown;
  vacuum?: unknown;
};
type CountRow = { count: number };
type AxiomRootRefRow = { axiom_id: string; root_id: string };
type AxiomIdRow = { axiom_id: string };
type NodeHashRow = Pick<
  NodeRow,
  | 'id'
  | 'parent_id'
  | 'sort_order'
  | 'text'
  | 'node_title'
  | 'node_note'
  | 'node_type'
  | 'trust_level'
  | 'content_hash'
  | 'subtree_hash'
> & MerkleNode;
type NodeHashStructureRow = Pick<NodeRow, 'id' | 'parent_id' | 'sort_order' | 'content_hash' | 'subtree_hash'> & MerkleNode;
type NodeHashContentRow = Pick<NodeRow, 'id' | 'text' | 'node_title' | 'node_note' | 'node_type' | 'trust_level'> & MerkleNode;
type NodeAddressRow = Pick<NodeRow, 'id' | 'parent_id' | 'sort_order'>;
// 从子模块函数签名去掉第一个 store 参数，剩下的就是门面壳要透传的参数。
// 与 ReturnType 配合让 IftreeStore.xxx(...) 自动从 editBranch.xxx 推导出真签名，
// 不再走 `_callEditBranch(name: string, args)` 字符串 dispatch（字符串 dispatch 永远丢类型）。
// 第一个参数位置必须用 any（不能 unknown）——conditional type 的参数位是逆变，unknown 不能匹配
// 子模块函数实际的 EditBranchStore（=IftreeStore）参数类型，会推出 never。
type TailParameters<T> = T extends (first: any, ...rest: infer R) => any ? R : never;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// PDF 高亮几何（含入参区间清洗）已移至 ./pdf-highlight-geometry.mjs（后端解耦第 1 步）。
// 编辑分支的 base-snapshot / empty-diff / entry-trust 判定已移至 ./edit-branch.mjs；
// 节点补丁字段校验（hasOwnValue / assertNoHumanTagField / assertNoEditTrustField）移至 ../shared.mjs，
// 由底座 updateNode 与编辑分支暂存方法共用。


// 对比弹窗的 diff/公理渲染与节点客户端别名已移至 ./diff-view.mjs（后端解耦第 1 步）。

export class IftreeStore {
  dbPath: string;
  db: Database | null;
  inTransaction: boolean;
  readonly: boolean;
  editorSnapshots: EditorSnapshotTokens;
  maintenance: ReturnType<typeof createMaintenanceScheduler>;
  // VACUUM 最短间隔（进程内计，重启清零可接受——重启后首个够格 tick 允许 VACUUM）。
  static readonly VACUUM_MIN_INTERVAL_MS = 6 * 3600 * 1000;
  _lastVacuumAt = 0;
  _streamPushCache: Map<string, { at: number; result: RowObject }> | null;
  _bulkTouchedDocIds: Set<string> | null;
  // 内部访问 db 一律走 conn：构造前 / close 后命中即立即抛，比满地 this.db!.x 真消除 NPE 隐患。
  // 守卫已在意者（如 _runStoreMaintenance line 241 / close 等）继续用 this.db 直接判 null。
  private get conn(): Database {
    if (!this.db) throw new Error('IftreeStore database is not initialized');
    return this.db;
  }

  constructor(dbPath: string, readonly domainPorts: StoreDomainPorts = {}) {
    this.dbPath = dbPath;
    this.db = null;
    this.inTransaction = false;
    this.readonly = false;
    this.editorSnapshots = new EditorSnapshotTokens(this);
    this._streamPushCache = null;
    this._bulkTouchedDocIds = null;
    // 后台维护调度器（主库位置，4-6）：只派发信号。主库在此注册自己的维护 handler（只碰 SQLite，绝不
    // 内联向量/lance 逻辑）；向量模块的 handler 由 host 接线时注册（自给自足）。host 启动时 start()。
    this.maintenance = createMaintenanceScheduler();
    this.maintenance.register('store', () => this._runStoreMaintenance());
  }

  requireEditBranchPort(): EditBranchProjectionPort {
    if (!this.domainPorts.editBranch) throw new Error('IftreeStore edit-branch port is not configured');
    return this.domainPorts.editBranch;
  }

  requireExternalEntryPort(): ExternalEntryPort {
    if (!this.domainPorts.externalEntries) throw new Error('IftreeStore external-entry port is not configured');
    return this.domainPorts.externalEntries;
  }

  // 主库自身维护（只碰 SQLite，不内联任何向量/lance 逻辑）：对象库 GC、WAL checkpoint 截断、高碎片时 VACUUM。
  // 由维护调度器在单写队列里串行调用，与正常写互斥。单步失败不影响其它步。
  _runStoreMaintenance() {
    if (!this.db || this.readonly) return { ok: true, skipped: 'no-db' };
    const out: StoreMaintenanceResult = {};
    try { out.gc = this.gcHistoryObjects(); } catch (error) { out.gc = errorMessage(error); }
    try { this.conn.pragma('wal_checkpoint(TRUNCATE)'); out.checkpoint = true; } catch (error) { out.checkpoint = errorMessage(error); }
    // VACUUM 与轻量维护（checkpoint/optimize）分两档：全量 VACUUM 重建整库、实测 ~10s/290MB 且期间写排队，
    // 比 checkpoint 重两个量级。除空闲页占比门槛外再加最短间隔，防高删除期连续 tick 都够格、反复长阻塞
    // 写队列（间隔数值是保守拍的，按实际节奏可调）。VACUUM 不能在事务内。
    try {
      const free = Number(this.conn.pragma('freelist_count', { simple: true })) || 0;
      const total = Number(this.conn.pragma('page_count', { simple: true })) || 1;
      const sinceLastVacuum = Date.now() - this._lastVacuumAt;
      if (!(free > 10000 && free / total > 0.2)) {
        out.vacuum = { skipped: `freelist ${free}/${total}` };
      } else if (sinceLastVacuum < IftreeStore.VACUUM_MIN_INTERVAL_MS) {
        out.vacuum = { skipped: `interval ${Math.round(sinceLastVacuum / 60000)}min < ${Math.round(IftreeStore.VACUUM_MIN_INTERVAL_MS / 60000)}min` };
      } else {
        this.conn.exec('VACUUM');
        this._lastVacuumAt = Date.now();
        out.vacuum = { freed: free };
      }
    } catch (error) { out.vacuum = errorMessage(error); }
    return { ok: true, ...out };
  }

  init(options: StoreInitOptions = {}) {
    const readonly = options.readonly === true;
    this.readonly = readonly;
    // WAL 不支持网络文件系统，数据库必须在本地盘（projectneed 18-6-2）；
    // 映射盘符无法廉价识别，这里只拦最明显的 UNC 形态。
    if (/^(\\\\|\/\/)/.test(String(this.dbPath))) {
      throw new Error(`数据库路径不能是网络位置（WAL 要求本地盘）：${this.dbPath}`);
    }
    if (!readonly) mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath, readonly ? { readonly: true, fileMustExist: true } : undefined);
    this.conn.pragma('busy_timeout = 5000');
    // 常驻层（frontend-refactor §5.1）：页缓存 + mmap 让热数据驻后端 RAM，IPC 回源不碰盘。
    // 在 readonly 分支 return 之前设——GUI/MCP 的全部读都走只读连接，它是最该配缓存的连接。
    // cache_size 负值 = KB；256MB 与 bulk 导入的 1GB 相比取保守档（多连接各自持有一份）。
    // mmap_size 是上限而非占用，按库实际大小映射；WAL 模式与 mmap 读取兼容。
    this.conn.pragma('cache_size = -262144');
    this.conn.pragma('temp_store = MEMORY');
    this.conn.pragma('mmap_size = 4294967296');
    // 正文字数 UDF：与 JS 侧 bodyCharCount 同源，供读层聚合（library_index / 子树合计）按「忽略空白」口径计数，
    // 使切分粒度（simple/complete）不影响字数。只读连接也注册（library_index 等走只读读取也要它）。
    this.conn.function('body_char_count', { deterministic: true }, (value: unknown) => bodyCharCount(value));
    if (readonly) {
      this.conn.pragma('query_only = ON');
      return;
    }
    // WAL：持续写入时只读实例并发读不被阻塞（projectneed 18-6-2）。
    // 切换需要短暂独占；被旧 rollback 模式连接占着时 SQLite 静默返回原模式，必须炸而不是带病运行。
    const journalMode = String(this.conn.pragma('journal_mode = WAL', { simple: true }));
    if (journalMode.toLowerCase() !== 'wal') {
      throw new Error(`journal_mode 切换 WAL 失败（仍为 ${journalMode}）：关闭其他占用该库的进程后重试`);
    }
    // WAL 标准搭配：NORMAL 在断电时最多丢最近 checkpoint 后的提交，不损坏库。
    this.conn.pragma('synchronous = NORMAL');
    // 旧库补列须在 exec(TABLES_SQL) 之前：hash 失效触发器（DROP+CREATE）引用 tree_object_hash，
    // 缺列时建触发器会失败；全新库表还不存在，ensureColumn 内部 catch 吞掉后由建表语句带上该列。
    // 加列即全 NULL = 首次全量写树，之后增量（对象树 hash 缓存，快照/undo token 剪枝依据）。
    this.ensureColumn('nodes', 'tree_object_hash', 'TEXT');
    // 同理：span 归属脏位触发器（DROP+CREATE）引用 docs.span_map_dirty，缺列时建触发器会失败。
    // 加列即 dirty=1 / hash=NULL = 下次写快照全量扫一遍归属，之后靠触发器维护脏位。
    this.ensureColumn('docs', 'span_map_hash', 'TEXT');
    this.ensureColumn('docs', 'span_map_dirty', 'INTEGER NOT NULL DEFAULT 1');
    // commits 的 span 归属指针：旧行留 NULL（旧库不兼容、不修复——restore 时退回现行行为）。
    this.ensureColumn('commits', 'span_map_hash', 'TEXT');
    this.conn.exec(TABLES_SQL);
    this._migrateObjectKindCheck();
    this._migrateEditBranchEntriesToTable();
    this.applySchemaVersion();
    this.domainPorts.lifecycle?.afterStoreInit(this);
  }

  // 一次性重建 objects 表，只为把 kind 的 CHECK 从 ('blob','tree','source') 放宽到含 'spanmap'
  // （SQLite 不能 ALTER 一个 CHECK 约束，只能重建）。objects 没有索引、没有任何外键指向它，
  // 重建 = 建新表 + 整表搬 + 换名。幂等：直接读 sqlite_master 里的建表 SQL，已含 'spanmap' 就跳过
  // （半途中断重启安全——整段在一个事务里，要么旧表原封不动、要么新表就位）。
  _migrateObjectKindCheck() {
    if (!this.hasTable('objects')) return;
    const row = this.conn.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'objects'"
    ).get<{ sql: string | null }>();
    const createSql = String(row?.sql || '');
    if (createSql.length === 0 || createSql.includes('spanmap')) return;
    this.withTransaction(() => {
      this.conn.exec(`
        CREATE TABLE objects_kind_migration (
          hash TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK(kind IN ('blob', 'tree', 'source', 'spanmap')),
          data TEXT NOT NULL
        );
        INSERT INTO objects_kind_migration (hash, kind, data) SELECT hash, kind, data FROM objects;
        DROP TABLE objects;
        ALTER TABLE objects_kind_migration RENAME TO objects;
      `);
    });
  }

  // 一次性搬迁：把还整包躺在 edit_branches.diff 里的 entries 搬进子表（storage: entries_table），
  // diff 列改写为元壳。分支表行数 = 活跃草稿数（个位数量级），全表扫零成本；幂等——已有子表行的
  // 分支跳过（半途中断重启续跑安全）。
  _migrateEditBranchEntriesToTable() {
    if (!this.hasTable('edit_branches') || !this.hasTable('edit_branch_entries')) return;
    const rows = this.conn.prepare(`
      SELECT id, diff FROM edit_branches
      WHERE diff LIKE '%"entries":%' AND diff NOT LIKE '%"entries":[]%'
    `).all<Pick<EditBranchRow, 'id' | 'diff'>>();
    if (rows.length === 0) return;
    const hasEntries = this.conn.prepare('SELECT 1 FROM edit_branch_entries WHERE branch_id = ? LIMIT 1');
    const insert = this.conn.prepare(`
      INSERT INTO edit_branch_entries (branch_id, seq, status, created_at, undone_at, entry)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const rewriteDiff = this.conn.prepare('UPDATE edit_branches SET diff = ? WHERE id = ?');
    this.withTransaction(() => {
      for (const row of rows) {
        if (hasEntries.get(row.id)) continue;
        let diff: Record<string, unknown>;
        try { diff = (JSON.parse(row.diff || '{}') as Record<string, unknown>) || {}; } catch { continue; }
        const entries = Array.isArray(diff.entries) ? diff.entries : [];
        if (entries.length === 0) continue;
        entries.forEach((rawEntry, index) => {
          const entry = (rawEntry || {}) as Record<string, unknown>;
          const { status, createdAt, undoneAt, ...payload } = entry;
          insert.run(
            row.id,
            index + 1,
            status === 'undone' ? 'undone' : 'active',
            createdAt ? String(createdAt) : null,
            undoneAt ? String(undoneAt) : null,
            JSON.stringify(payload)
          );
        });
        const { entries: _dropped, ...metaRest } = diff;
        rewriteDiff.run(JSON.stringify({ ...metaRest, storage: 'entries_table' }), row.id);
      }
    });
  }

  // schema 版本闸：建表后只读 user_version 决定要不要迁移，跑过（版本已到位）启动期零全表扫。
  // 新空库与现有 0.5.0 live（结构已最新）直接盖章到当前版；更老或结构不符的库拒绝原地启动，
  // 引导走 导出→导入 迁移（本版本不在 init 里做旧库原地升级）。
  applySchemaVersion() {
    const current = Number(this.conn.pragma('user_version', { simple: true }));
    if (current === SCHEMA_VERSION) return;
    if (current === 0) {
      if (!this.isLatestStructure()) {
        throw new Error(
          '数据库结构不是 0.5.0+ 形态，本版本只兼容 0.5.0 起的库；'
          + '更老的库请用 导出→导入 迁移（scripts/export-db-to-json + scripts/import-db-from-json）'
        );
      }
      this.conn.pragma(`user_version = ${SCHEMA_VERSION}`);
      return;
    }
    if (current < SCHEMA_VERSION) {
      throw new Error(
        `数据库 schema 版本 ${current} 低于当前 ${SCHEMA_VERSION}；`
        + '本版本不在启动期做旧库原地升级，请用 导出→导入 迁移'
      );
    }
    throw new Error(`数据库 schema 版本 ${current} 高于当前 ${SCHEMA_VERSION}；请升级应用`);
  }

  // 0.5.0 live 的结构标志：字数缓存列在、提交走内容寻址、过渡列已删——据此给未盖章的库判断能否直接盖章。
  isLatestStructure() {
    return this.hasColumn('nodes', 'title_chars')
      && this.hasColumn('commits', 'root_tree_hash')
      && !this.hasColumn('commits', 'snapshot');
  }

  // 读时惰性补算 base 文档的 Merkle 哈希缓存（nodes.content_hash/subtree_hash 列）。
  // doc 未脏 → 直接读列；脏（编辑过 / 新导入 / 旧库迁移）→ 整树重算并回写、清脏标记（即「必要时整树重算」）。
  // 返回 Map<id,{contentHash,subtreeHash}> 供 diff 当 base 侧用，免去每个 session 重算整个 base。
  // 落盘时机：读一律走 readonly 连接，下面的回写被 `!this.readonly` 挡掉、只返回计算结果；
  // 真正的物化发生在写连接的写分发收尾（mutation-api 的 materializeNodeHashes）。
  ensureNodeHashes(docId: unknown) {
    // 结构行不拉正文：脏行（hash 为 NULL，节点级失效触发器置的）才补拉 5 个内容字段。
    const structureRows = this.conn.prepare(
      'SELECT id, parent_id, sort_order, content_hash, subtree_hash FROM nodes WHERE doc_id = ?'
    ).all<NodeHashStructureRow>(docId);
    if (structureRows.length === 0) return new Map();
    const dirtyCount = structureRows.reduce((n, row) => (row.content_hash && row.subtree_hash ? n : n + 1), 0);
    const doc = this.conn.prepare('SELECT nodes_hash_dirty FROM docs WHERE id = ?').get<Pick<DocRow, 'nodes_hash_dirty'>>(docId);
    const docDirty = !doc || Number(doc.nodes_hash_dirty) !== 0;
    if (dirtyCount === 0) {
      // 位=1 但无 NULL 行 = 旧触发器时代的陈旧态（升级前最后一次写只置了粗位）：退全量，
      // 重算清位后即归新常态。位=0 且无 NULL 行 = clean，直接读列。
      if (docDirty) return this._recomputeAllNodeHashes(docId);
      return new Map(structureRows.map((row) => [String(row.id), { contentHash: row.content_hash, subtreeHash: row.subtree_hash }]));
    }
    // 脏行过半：重算集≈全树，增量没有优势，少一趟双查直接全量。
    if (dirtyCount * 2 >= structureRows.length) return this._recomputeAllNodeHashes(docId);
    const contentRows = this.conn.prepare(
      'SELECT id, text, node_title, node_note, node_type, trust_level FROM nodes WHERE doc_id = ? AND (content_hash IS NULL OR subtree_hash IS NULL)'
    ).all<NodeHashContentRow>(docId);
    const contentById = new Map<string, MerkleNode>(contentRows.map((row) => [String(row.id), row]));
    const { recomputed, fullRecomputeNeeded } = computeSubtreeHashesIncremental(structureRows, contentById);
    if (fullRecomputeNeeded) return this._recomputeAllNodeHashes(docId);
    if (!this.readonly) {
      const update = this.conn.prepare('UPDATE nodes SET content_hash = ?, subtree_hash = ? WHERE id = ?');
      this.withTransaction(() => {
        for (const [id, hash] of recomputed) update.run(hash.contentHash, hash.subtreeHash, id);
        this.conn.prepare('UPDATE docs SET nodes_hash_dirty = 0 WHERE id = ?').run(docId);
      });
    }
    // 返回全表：存量行打底、重算结果覆盖。
    const out = new Map(structureRows.map((row) => [String(row.id), { contentHash: row.content_hash, subtreeHash: row.subtree_hash }]));
    for (const [id, hash] of recomputed) out.set(id, hash);
    return out;
  }

  // 全量重算兜底（原实现主体）：新导入 / 旧库陈旧 / 脏行过半 / 增量前提破损时走这里。
  _recomputeAllNodeHashes(docId: unknown) {
    const rows = this.conn.prepare(
      'SELECT id, parent_id, sort_order, text, node_title, node_note, node_type, trust_level, content_hash, subtree_hash FROM nodes WHERE doc_id = ?'
    ).all<NodeHashRow>(docId);
    if (rows.length === 0) return new Map();
    const hashes = computeSubtreeHashes(rows);
    if (!this.readonly) {
      const update = this.conn.prepare('UPDATE nodes SET content_hash = ?, subtree_hash = ? WHERE id = ?');
      this.withTransaction(() => {
        for (const [id, hash] of hashes) update.run(hash.contentHash, hash.subtreeHash, id);
        this.conn.prepare('UPDATE docs SET nodes_hash_dirty = 0 WHERE id = ?').run(docId);
      });
    }
    return hashes;
  }

  columnInfo(table: string, name: string) {
    try {
      return this.conn.prepare(`PRAGMA table_info(${table})`).all()
        .find((column) => column.name === name) || null;
    } catch {
      return null;
    }
  }

  columnType(table: string, name: string) {
    return String(this.columnInfo(table, name)?.type || '').trim().toUpperCase();
  }

  hasColumn(table: string, name: string) {
    return this.columnInfo(table, name) !== null;
  }

  dropColumnIfExists(table: string, name: string) {
    let columns;
    try {
      columns = this.conn.prepare(`PRAGMA table_info(${table})`).all();
    } catch {
      return false;
    }
    if (!columns.some((column) => column.name === name)) return false;
    this.conn.exec(`ALTER TABLE ${table} DROP COLUMN ${name}`);
    return true;
  }

  ensureColumn(table: string, name: string, definition: string) {
    try {
      const columns = this.conn.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((column) => column.name === name)) {
        this.conn.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        return true;
      }
    } catch { /* table may not exist yet */ }
    return false;
  }

  hasNodeColumns(names = []) {
    try {
      const columns = new Set(this.conn.prepare('PRAGMA table_info(nodes)').all().map((column) => column.name));
      return names.every((name) => columns.has(name));
    } catch {
      return false;
    }
  }

  hasTable(name: unknown) {
    try {
      return Boolean(this.conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(String(name || '')));
    } catch {
      return false;
    }
  }

  hasEditBranchesTable() {
    return this.hasTable('edit_branches');
  }

  hasNodeStructureMetadataColumns() {
    return false;
  }

  ensureExistingAxiomRefs() {
    try {
      const rows = this.conn.prepare(`
        SELECT axioms.id AS axiom_id, roots.id AS root_id
        FROM axioms
        JOIN nodes roots ON roots.doc_id = axioms.doc_id AND roots.parent_id IS NULL
        WHERE NOT EXISTS (
          SELECT 1 FROM refs
          WHERE refs.source_type = 'axiom'
            AND refs.source_id = axioms.id
            AND refs.target_type = 'node'
            AND refs.target_id = roots.id
            AND refs.ref_kind = '事实前提'
        )
      `).all<AxiomRootRefRow>();
      const insert = this.conn.prepare(`
        INSERT INTO refs (id, source_type, source_id, target_type, target_id, ref_kind, note)
        VALUES (?, 'axiom', ?, 'node', ?, '事实前提', NULL)
      `);
      this.withTransaction(() => {
        for (const row of rows) insert.run(newStableId(), row.axiom_id, row.root_id);
      });
    } catch { /* table may not exist yet */ }
  }

  ensureAxiomRefsForDoc(docId: unknown) {
    try {
      const root = this.conn.prepare('SELECT id FROM nodes WHERE doc_id = ? AND parent_id IS NULL ORDER BY id LIMIT 1').get<Pick<NodeRow, 'id'>>(docId);
      if (!root) return;
      const rows = this.conn.prepare(`
        SELECT axioms.id AS axiom_id
        FROM axioms
        WHERE axioms.doc_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM refs
            WHERE refs.source_type = 'axiom'
              AND refs.source_id = axioms.id
              AND refs.target_type = 'node'
              AND refs.target_id = ?
              AND refs.ref_kind = '事实前提'
          )
      `).all<AxiomIdRow>(docId, root.id);
      const insert = this.conn.prepare(`
        INSERT INTO refs (id, source_type, source_id, target_type, target_id, ref_kind, note)
        VALUES (?, 'axiom', ?, 'node', ?, '事实前提', NULL)
      `);
      this.withTransaction(() => {
        for (const row of rows) insert.run(newStableId(), row.axiom_id, root.id);
      });
    } catch { /* table may not exist yet */ }
  }

  refreshAllAddresses() {
    const docs = this.conn.prepare('SELECT id FROM docs ORDER BY id').all<Pick<DocRow, 'id'>>();
    let updated = 0;
    this.withTransaction(() => {
      const updateStmt = this.conn.prepare('UPDATE nodes SET depth = ?, address = ? WHERE doc_id = ? AND id = ?');
      for (const { id: docId } of docs) {
        updated += this.refreshDocAddresses(docId, updateStmt).updated;
      }
    });
    return { updated, docs: docs.length };
  }

  refreshDocAddresses(docId: unknown, updateStmt: Statement | null = null) {
    const normalizedDocId = normalizePositiveId(docId);
    if (normalizedDocId === null) return { updated: 0 };
    const rows = this.conn.prepare(`
      SELECT id, parent_id, sort_order
      FROM nodes
      WHERE doc_id = ?
      ORDER BY parent_id IS NOT NULL, parent_id, sort_order, id
    `).all<NodeAddressRow>(normalizedDocId);
    if (rows.length === 0) return { updated: 0 };

    const childrenByParent = new Map<string | null, NodeAddressRow[]>();
    for (const row of rows) {
      const parentKey = row.parent_id ?? null;
      if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
      childrenByParent.get(parentKey)!.push(row);
    }
    for (const children of childrenByParent.values()) {
      children.sort((left, right) => left.sort_order - right.sort_order || compareStableIds(left.id, right.id));
    }

    const update = updateStmt || this.conn.prepare('UPDATE nodes SET depth = ?, address = ? WHERE doc_id = ? AND id = ?');
    let updated = 0;
    const visit = (node: NodeAddressRow, address: string, depth: number) => {
      const result = update.run(depth, address, normalizedDocId, node.id);
      updated += result.changes || 0;
      const children = childrenByParent.get(node.id) || [];
      for (let index = 0; index < children.length; index += 1) {
        visit(children[index]!, `${address}-${index + 1}`, depth + 1);
      }
    };

    this.withTransaction(() => {
      const roots = childrenByParent.get(null) || [];
      for (let index = 0; index < roots.length; index += 1) {
        visit(roots[index]!, String(index + 1), 1);
      }
    });
    return { updated };
  }

  refreshAddressScopes(docId: unknown, parentIds: unknown[] | unknown = []) {
    const normalizedDocId = normalizePositiveId(docId);
    if (normalizedDocId === null) return { updated: 0, scopes: 0 };
    const normalizedParentIds: Array<string | null> = [];
    const seen = new Set<string>();
    for (const value of Array.isArray(parentIds) ? parentIds : [parentIds]) {
      let parentId = null;
      if (value !== null && value !== undefined) {
        parentId = normalizePositiveId(value);
        if (parentId === null) continue;
      }
      const key = parentId === null ? 'root' : String(parentId);
      if (seen.has(key)) continue;
      seen.add(key);
      normalizedParentIds.push(parentId);
    }
    let updated = 0;
    for (const parentId of normalizedParentIds) {
      updated += this.refreshAddressScope(normalizedDocId, parentId).updated;
    }
    return { updated, scopes: normalizedParentIds.length };
  }

  refreshAddressScope(docId: unknown, parentId: unknown = null) {
    const normalizedDocId = normalizePositiveId(docId);
    if (normalizedDocId === null) return { updated: 0 };
    let baseAddress = '';
    let baseDepth = 0;
    if (parentId !== null && parentId !== undefined) {
      const parent = this.conn.prepare(`
        SELECT address, depth
        FROM nodes
        WHERE doc_id = ? AND id = ?
      `).get<Pick<NodeRow, 'address' | 'depth'>>(normalizedDocId, parentId);
      if (!parent) return { updated: 0 };
      baseAddress = parent.address || '';
      baseDepth = Math.max(1, Math.floor(Number(parent.depth) || 1));
    }

    const rows = this.conn.prepare(`
      WITH RECURSIVE scoped(id, parent_id, sort_order) AS (
        SELECT id, parent_id, sort_order
        FROM nodes
        WHERE doc_id = ? AND parent_id IS ?
        UNION ALL
        SELECT child.id, child.parent_id, child.sort_order
        FROM nodes child
        JOIN scoped parent ON child.parent_id = parent.id
        WHERE child.doc_id = ?
      )
      SELECT id, parent_id, sort_order
      FROM scoped
      ORDER BY parent_id IS NOT NULL, parent_id, sort_order, id
    `).all<NodeAddressRow>(normalizedDocId, parentId ?? null, normalizedDocId);
    if (rows.length === 0) return { updated: 0 };

    const childrenByParent = new Map<string | null, NodeAddressRow[]>();
    for (const row of rows) {
      const parentKey = row.parent_id ?? null;
      if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
      childrenByParent.get(parentKey)!.push(row);
    }
    for (const children of childrenByParent.values()) {
      children.sort((left, right) => left.sort_order - right.sort_order || compareStableIds(left.id, right.id));
    }

    const update = this.conn.prepare(`
      UPDATE nodes
      SET depth = ?,
          address = ?
      WHERE doc_id = ? AND id = ?
        AND (depth IS NOT ? OR address IS NOT ?)
    `);
    let updated = 0;
    const visit = (node: NodeAddressRow, address: string, depth: number) => {
      const result = update.run(depth, address, normalizedDocId, node.id, depth, address);
      updated += result.changes || 0;
      const children = childrenByParent.get(node.id) || [];
      for (let index = 0; index < children.length; index += 1) {
        visit(children[index]!, `${address}-${index + 1}`, depth + 1);
      }
    };

    const rootKey = parentId === null || parentId === undefined ? null : String(parentId);
    const roots = childrenByParent.get(rootKey) || [];
    for (let index = 0; index < roots.length; index += 1) {
      const address = parentId === null || parentId === undefined
        ? String(index + 1)
        : `${baseAddress}-${index + 1}`;
      visit(roots[index]!, address, baseDepth + 1);
    }
    return { updated };
  }

  removeRootAxiomRefs(docId: unknown = null) {
    try {
      const params: unknown[] = [];
      const docFilter = docId ? 'AND axioms.doc_id = ?' : '';
      if (docId) params.push(docId);
      this.conn.prepare(`
        DELETE FROM refs
        WHERE source_type = 'axiom'
          AND target_type = 'node'
          AND ref_kind = '事实前提'
          AND EXISTS (
            SELECT 1
            FROM axioms
            JOIN nodes roots ON roots.doc_id = axioms.doc_id AND roots.parent_id IS NULL
            WHERE axioms.id = refs.source_id
              AND roots.id = refs.target_id
              ${docFilter}
          )
      `).run(...params);
    } catch { /* table may not exist yet */ }
  }

  close() {
    this.maintenance?.stop?.();
    if (this.db) this.db.close();
    this.db = null;
  }

  listDocs(...args: TailParameters<typeof document.listDocs>): ReturnType<typeof document.listDocs> { return document.listDocs(this, ...args); }

  listDocFolders(...args: TailParameters<typeof document.listDocFolders>): ReturnType<typeof document.listDocFolders> { return document.listDocFolders(this, ...args); }

  createDocFolder(...args: TailParameters<typeof document.createDocFolder>): ReturnType<typeof document.createDocFolder> { return document.createDocFolder(this, ...args); }

  updateDocFolder(...args: TailParameters<typeof document.updateDocFolder>): ReturnType<typeof document.updateDocFolder> { return document.updateDocFolder(this, ...args); }

  deleteDocFolder(...args: TailParameters<typeof document.deleteDocFolder>): ReturnType<typeof document.deleteDocFolder> { return document.deleteDocFolder(this, ...args); }

  moveDocToFolder(...args: TailParameters<typeof document.moveDocToFolder>): ReturnType<typeof document.moveDocToFolder> { return document.moveDocToFolder(this, ...args); }

  createDoc(...args: TailParameters<typeof document.createDoc>): ReturnType<typeof document.createDoc> { return document.createDoc(this, ...args); }

  deleteDoc(...args: TailParameters<typeof document.deleteDoc>): ReturnType<typeof document.deleteDoc> { return document.deleteDoc(this, ...args); }

  // ─── 流式写入与文档编辑模式（projectneed 4-16）──────────────
  getDocEditMode(...args: TailParameters<typeof stream.getDocEditMode>): ReturnType<typeof stream.getDocEditMode> { return stream.getDocEditMode(this, ...args); }

  setDocEditMode(...args: TailParameters<typeof stream.setDocEditMode>): ReturnType<typeof stream.setDocEditMode> { return stream.setDocEditMode(this, ...args); }

  _streamPushFromCache(...args: TailParameters<typeof stream.streamPushFromCache>): ReturnType<typeof stream.streamPushFromCache> { return stream.streamPushFromCache(this, ...args); }

  _rememberStreamPush(...args: TailParameters<typeof stream.rememberStreamPush>): ReturnType<typeof stream.rememberStreamPush> { return stream.rememberStreamPush(this, ...args); }

  pushStreamNodes(...args: TailParameters<typeof stream.pushStreamNodes>): ReturnType<typeof stream.pushStreamNodes> { return stream.pushStreamNodes(this, ...args); }

  beginBulkImport(...args: TailParameters<typeof stream.beginBulkImport>): ReturnType<typeof stream.beginBulkImport> { return stream.beginBulkImport(this, ...args); }

  endBulkImport(...args: TailParameters<typeof stream.endBulkImport>): ReturnType<typeof stream.endBulkImport> { return stream.endBulkImport(this, ...args); }

  hasActiveBulkImport(...args: TailParameters<typeof stream.hasActiveBulkImport>): ReturnType<typeof stream.hasActiveBulkImport> { return stream.hasActiveBulkImport(this, ...args); }

  // ===== 编辑分支子系统转调壳（实现在 ./edit-branch.mjs；门面对外面与抽出前逐字一致）=====
  // 每个壳用 TailParameters + ReturnType 从子模块函数签名自动推参/返；直调 editBranch.xxx
  // 不再经字符串 dispatch（字符串 dispatch 永远丢类型，调用方拿到 unknown）。

  normalizeEditBranchOwner(...args: TailParameters<typeof editBranch.normalizeEditBranchOwner>): ReturnType<typeof editBranch.normalizeEditBranchOwner> { return editBranch.normalizeEditBranchOwner(this, ...args); }
  activeEditBranchForBaseDoc(...args: TailParameters<typeof editBranch.activeEditBranchForBaseDoc>): ReturnType<typeof editBranch.activeEditBranchForBaseDoc> { return editBranch.activeEditBranchForBaseDoc(this, ...args); }
  activeEditBranchForShadowDoc(...args: TailParameters<typeof editBranch.activeEditBranchForShadowDoc>): ReturnType<typeof editBranch.activeEditBranchForShadowDoc> { return editBranch.activeEditBranchForShadowDoc(this, ...args); }
  activeEditBranchForDoc(...args: TailParameters<typeof editBranch.activeEditBranchForDoc>): ReturnType<typeof editBranch.activeEditBranchForDoc> { return editBranch.activeEditBranchForDoc(this, ...args); }
  listActiveEditBranches(...args: TailParameters<typeof editBranch.listActiveEditBranches>): ReturnType<typeof editBranch.listActiveEditBranches> { return editBranch.listActiveEditBranches(this, ...args); }
  docIdForMutationPayload(...args: TailParameters<typeof editBranch.docIdForMutationPayload>): ReturnType<typeof editBranch.docIdForMutationPayload> { return editBranch.docIdForMutationPayload(this, ...args); }
  nodePatchForEditBranch(...args: TailParameters<typeof editBranch.nodePatchForEditBranch>): ReturnType<typeof editBranch.nodePatchForEditBranch> { return editBranch.nodePatchForEditBranch(this, ...args); }
  _appendEditBranchEntry(...args: TailParameters<typeof editBranch._appendEditBranchEntry>): ReturnType<typeof editBranch._appendEditBranchEntry> { return editBranch._appendEditBranchEntry(this, ...args); }
  editBranchHistoryState(...args: TailParameters<typeof editBranch.editBranchHistoryState>): ReturnType<typeof editBranch.editBranchHistoryState> { return editBranch.editBranchHistoryState(this, ...args); }
  computeThreeWayMerge(...args: TailParameters<typeof editBranch.computeThreeWayMerge>): ReturnType<typeof editBranch.computeThreeWayMerge> { return editBranch.computeThreeWayMerge(this, ...args); }
  _trunkNodeRow(...args: TailParameters<typeof editBranch._trunkNodeRow>): ReturnType<typeof editBranch._trunkNodeRow> { return editBranch._trunkNodeRow(this, ...args); }
  _trunkSubtreeHash(...args: TailParameters<typeof editBranch._trunkSubtreeHash>): ReturnType<typeof editBranch._trunkSubtreeHash> { return editBranch._trunkSubtreeHash(this, ...args); }
  _validateEditBranchEntriesAgainstTrunk(...args: TailParameters<typeof editBranch._validateEditBranchEntriesAgainstTrunk>): ReturnType<typeof editBranch._validateEditBranchEntriesAgainstTrunk> { return editBranch._validateEditBranchEntriesAgainstTrunk(this, ...args); }
  applyThreeWayMerge(...args: TailParameters<typeof editBranch.applyThreeWayMerge>): ReturnType<typeof editBranch.applyThreeWayMerge> { return editBranch.applyThreeWayMerge(this, ...args); }
  _replaceEditBranchDiff(...args: TailParameters<typeof editBranch._replaceEditBranchDiff>): ReturnType<typeof editBranch._replaceEditBranchDiff> { return editBranch._replaceEditBranchDiff(this, ...args); }
  undoEditBranchEntry(...args: TailParameters<typeof editBranch.undoEditBranchEntry>): ReturnType<typeof editBranch.undoEditBranchEntry> { return editBranch.undoEditBranchEntry(this, ...args); }
  redoEditBranchEntry(...args: TailParameters<typeof editBranch.redoEditBranchEntry>): ReturnType<typeof editBranch.redoEditBranchEntry> { return editBranch.redoEditBranchEntry(this, ...args); }
  _fetchBaseRefsForDoc(...args: TailParameters<typeof editBranch._fetchBaseRefsForDoc>): ReturnType<typeof editBranch._fetchBaseRefsForDoc> { return editBranch._fetchBaseRefsForDoc(this, ...args); }
  editBranchBaseInputs(...args: TailParameters<typeof editBranch.editBranchBaseInputs>): ReturnType<typeof editBranch.editBranchBaseInputs> { return editBranch.editBranchBaseInputs(this, ...args); }
  _projectedDocForBranch(...args: TailParameters<typeof editBranch._projectedDocForBranch>): ReturnType<typeof editBranch._projectedDocForBranch> { return editBranch._projectedDocForBranch(this, ...args); }
  liveDocSnapshot(...args: TailParameters<typeof editBranch.liveDocSnapshot>): ReturnType<typeof editBranch.liveDocSnapshot> { return editBranch.liveDocSnapshot(this, ...args); }
  _findProjectedNode(...args: TailParameters<typeof editBranch._findProjectedNode>): ReturnType<typeof editBranch._findProjectedNode> { return editBranch._findProjectedNode(this, ...args); }
  _findProjectedAxiom(...args: TailParameters<typeof editBranch._findProjectedAxiom>): ReturnType<typeof editBranch._findProjectedAxiom> { return editBranch._findProjectedAxiom(this, ...args); }
  stageEditBranchNodeUpdate(...args: TailParameters<typeof editBranchStage.stageEditBranchNodeUpdate>): ReturnType<typeof editBranchStage.stageEditBranchNodeUpdate> { return editBranchStage.stageEditBranchNodeUpdate(this, ...args); }
  stageEditBranchNodeInsert(...args: TailParameters<typeof editBranchStage.stageEditBranchNodeInsert>): ReturnType<typeof editBranchStage.stageEditBranchNodeInsert> { return editBranchStage.stageEditBranchNodeInsert(this, ...args); }
  stageEditBranchNodeDelete(...args: TailParameters<typeof editBranchStage.stageEditBranchNodeDelete>): ReturnType<typeof editBranchStage.stageEditBranchNodeDelete> { return editBranchStage.stageEditBranchNodeDelete(this, ...args); }
  stageEditBranchNodeMove(...args: TailParameters<typeof editBranchStage.stageEditBranchNodeMove>): ReturnType<typeof editBranchStage.stageEditBranchNodeMove> { return editBranchStage.stageEditBranchNodeMove(this, ...args); }
  stageEditBranchNodePromote(...args: TailParameters<typeof editBranchStage.stageEditBranchNodePromote>): ReturnType<typeof editBranchStage.stageEditBranchNodePromote> { return editBranchStage.stageEditBranchNodePromote(this, ...args); }
  stageEditBranchNodeSplit(...args: TailParameters<typeof editBranchStage.stageEditBranchNodeSplit>): ReturnType<typeof editBranchStage.stageEditBranchNodeSplit> { return editBranchStage.stageEditBranchNodeSplit(this, ...args); }
  stageEditBranchNodeMergeInto(...args: TailParameters<typeof editBranchStage.stageEditBranchNodeMergeInto>): ReturnType<typeof editBranchStage.stageEditBranchNodeMergeInto> { return editBranchStage.stageEditBranchNodeMergeInto(this, ...args); }
  stageEditBranchNodeMergePrevious(...args: TailParameters<typeof editBranchStage.stageEditBranchNodeMergePrevious>): ReturnType<typeof editBranchStage.stageEditBranchNodeMergePrevious> { return editBranchStage.stageEditBranchNodeMergePrevious(this, ...args); }
  stageEditBranchNodeReparent(...args: TailParameters<typeof editBranchStage.stageEditBranchNodeReparent>): ReturnType<typeof editBranchStage.stageEditBranchNodeReparent> { return editBranchStage.stageEditBranchNodeReparent(this, ...args); }
  stageEditBranchNodeMoveBefore(...args: TailParameters<typeof editBranchStage.stageEditBranchNodeMoveBefore>): ReturnType<typeof editBranchStage.stageEditBranchNodeMoveBefore> { return editBranchStage.stageEditBranchNodeMoveBefore(this, ...args); }
  stageEditBranchNodeMoveAfter(...args: TailParameters<typeof editBranchStage.stageEditBranchNodeMoveAfter>): ReturnType<typeof editBranchStage.stageEditBranchNodeMoveAfter> { return editBranchStage.stageEditBranchNodeMoveAfter(this, ...args); }
  stageEditBranchAxiomAdd(...args: TailParameters<typeof editBranchStage.stageEditBranchAxiomAdd>): ReturnType<typeof editBranchStage.stageEditBranchAxiomAdd> { return editBranchStage.stageEditBranchAxiomAdd(this, ...args); }
  stageEditBranchAxiomUpdate(...args: TailParameters<typeof editBranchStage.stageEditBranchAxiomUpdate>): ReturnType<typeof editBranchStage.stageEditBranchAxiomUpdate> { return editBranchStage.stageEditBranchAxiomUpdate(this, ...args); }
  stageEditBranchAxiomDelete(...args: TailParameters<typeof editBranchStage.stageEditBranchAxiomDelete>): ReturnType<typeof editBranchStage.stageEditBranchAxiomDelete> { return editBranchStage.stageEditBranchAxiomDelete(this, ...args); }
  stageEditBranchAxiomMove(...args: TailParameters<typeof editBranchStage.stageEditBranchAxiomMove>): ReturnType<typeof editBranchStage.stageEditBranchAxiomMove> { return editBranchStage.stageEditBranchAxiomMove(this, ...args); }
  stageEditBranchRefAddAxiomToNode(...args: TailParameters<typeof editBranchStage.stageEditBranchRefAddAxiomToNode>): ReturnType<typeof editBranchStage.stageEditBranchRefAddAxiomToNode> { return editBranchStage.stageEditBranchRefAddAxiomToNode(this, ...args); }
  stageEditBranchRefAddNodeToNode(...args: TailParameters<typeof editBranchStage.stageEditBranchRefAddNodeToNode>): ReturnType<typeof editBranchStage.stageEditBranchRefAddNodeToNode> { return editBranchStage.stageEditBranchRefAddNodeToNode(this, ...args); }
  stageEditBranchRefDelete(...args: TailParameters<typeof editBranchStage.stageEditBranchRefDelete>): ReturnType<typeof editBranchStage.stageEditBranchRefDelete> { return editBranchStage.stageEditBranchRefDelete(this, ...args); }
  applyEditBranchDiffEntries(...args: TailParameters<typeof editBranch.applyEditBranchDiffEntries>): ReturnType<typeof editBranch.applyEditBranchDiffEntries> { return editBranch.applyEditBranchDiffEntries(this, ...args); }
  beginEditBranch(...args: TailParameters<typeof editBranch.beginEditBranch>): ReturnType<typeof editBranch.beginEditBranch> { return editBranch.beginEditBranch(this, ...args); }
  findEditBranch(...args: TailParameters<typeof editBranch.findEditBranch>): ReturnType<typeof editBranch.findEditBranch> { return editBranch.findEditBranch(this, ...args); }
  rebaseEditBranch(...args: TailParameters<typeof editBranch.rebaseEditBranch>): ReturnType<typeof editBranch.rebaseEditBranch> { return editBranch.rebaseEditBranch(this, ...args); }
  cherryPickEditBranchEntries(...args: TailParameters<typeof editBranch.cherryPickEditBranchEntries>): ReturnType<typeof editBranch.cherryPickEditBranchEntries> { return editBranch.cherryPickEditBranchEntries(this, ...args); }
  _cherryPickSource(...args: TailParameters<typeof editBranch._cherryPickSource>): ReturnType<typeof editBranch._cherryPickSource> { return editBranch._cherryPickSource(this, ...args); }
  _selectCherryPickEntries(...args: TailParameters<typeof editBranch._selectCherryPickEntries>): ReturnType<typeof editBranch._selectCherryPickEntries> { return editBranch._selectCherryPickEntries(this, ...args); }
  _copyCherryPickEntry(...args: TailParameters<typeof editBranch._copyCherryPickEntry>): ReturnType<typeof editBranch._copyCherryPickEntry> { return editBranch._copyCherryPickEntry(this, ...args); }
  saveEditBranch(...args: TailParameters<typeof editBranch.saveEditBranch>): ReturnType<typeof editBranch.saveEditBranch> { return editBranch.saveEditBranch(this, ...args); }
  _docNodeSignatures(...args: TailParameters<typeof editBranch._docNodeSignatures>): ReturnType<typeof editBranch._docNodeSignatures> { return editBranch._docNodeSignatures(this, ...args); }
  _commitEditBranchPayload(...args: TailParameters<typeof editBranch._commitEditBranchPayload>): ReturnType<typeof editBranch._commitEditBranchPayload> { return editBranch._commitEditBranchPayload(this, ...args); }
  discardEditBranch(...args: TailParameters<typeof editBranch.discardEditBranch>): ReturnType<typeof editBranch.discardEditBranch> { return editBranch.discardEditBranch(this, ...args); }

  getDoc(...args: TailParameters<typeof query.getDoc>): ReturnType<typeof query.getDoc> { return query.getDoc(this, ...args); }

  materializeDoc(...args: TailParameters<typeof query.materializeDoc>): ReturnType<typeof query.materializeDoc> { return query.materializeDoc(this, ...args); }

  hasDocTreeDepth(...args: TailParameters<typeof query.hasDocTreeDepth>): ReturnType<typeof query.hasDocTreeDepth> { return query.hasDocTreeDepth(this, ...args); }

  getDocStructureRows(...args: TailParameters<typeof query.getDocStructureRows>): ReturnType<typeof query.getDocStructureRows> { return query.getDocStructureRows(this, ...args); }

  getNodeTextBatch(...args: TailParameters<typeof query.getNodeTextBatch>): ReturnType<typeof query.getNodeTextBatch> { return query.getNodeTextBatch(this, ...args); }

  searchNodes(...args: TailParameters<typeof query.searchNodes>): ReturnType<typeof query.searchNodes> { return query.searchNodes(this, ...args); }

  getNodeAddress(...args: TailParameters<typeof query.getNodeAddress>): ReturnType<typeof query.getNodeAddress> { return query.getNodeAddress(this, ...args); }

  getSubtreeSlotRange(...args: TailParameters<typeof query.getSubtreeSlotRange>): ReturnType<typeof query.getSubtreeSlotRange> { return query.getSubtreeSlotRange(this, ...args); }

  getSubtreeTextWindow(...args: TailParameters<typeof query.getSubtreeTextWindow>): ReturnType<typeof query.getSubtreeTextWindow> { return query.getSubtreeTextWindow(this, ...args); }

  getAncestorChain(...args: TailParameters<typeof query.getAncestorChain>): ReturnType<typeof query.getAncestorChain> { return query.getAncestorChain(this, ...args); }

  getSubtreeAggregates(...args: TailParameters<typeof query.getSubtreeAggregates>): ReturnType<typeof query.getSubtreeAggregates> { return query.getSubtreeAggregates(this, ...args); }

  getNodeChildren(...args: TailParameters<typeof query.getNodeChildren>): ReturnType<typeof query.getNodeChildren> { return query.getNodeChildren(this, ...args); }

  getDocNodesPage(...args: TailParameters<typeof query.getDocNodesPage>): ReturnType<typeof query.getDocNodesPage> { return query.getDocNodesPage(this, ...args); }

  getSourceWindow(...args: TailParameters<typeof source.getSourceWindow>): ReturnType<typeof source.getSourceWindow> { return source.getSourceWindow(this, ...args); }

  saveSourceDocument(...args: TailParameters<typeof source.saveSourceDocument>): ReturnType<typeof source.saveSourceDocument> { return source.saveSourceDocument(this, ...args); }

  updateSourceBinding(...args: TailParameters<typeof source.updateSourceBinding>): ReturnType<typeof source.updateSourceBinding> { return source.updateSourceBinding(this, ...args); }

  setSourceDocumentReference(...args: TailParameters<typeof source.setSourceDocumentReference>): ReturnType<typeof source.setSourceDocumentReference> { return source.setSourceDocumentReference(this, ...args); }

  // PDF 高亮屏幕几何住 source 域（pdf-highlight-geometry），动作面在 handlers/read/node
  //（source.pdfHighlightRects / source.pdfHitRects）——store 不再留门面（§6-1）。

  insertNode(...args: TailParameters<typeof node.insertNode>): ReturnType<typeof node.insertNode> { return node.insertNode(this, ...args); }

  updateNode(...args: TailParameters<typeof node.updateNode>): ReturnType<typeof node.updateNode> { return node.updateNode(this, ...args); }

  deleteNodeSubtree(...args: TailParameters<typeof node.deleteNodeSubtree>): ReturnType<typeof node.deleteNodeSubtree> { return node.deleteNodeSubtree(this, ...args); }

  moveNode(...args: TailParameters<typeof node.moveNode>): ReturnType<typeof node.moveNode> { return node.moveNode(this, ...args); }

  splitNodeIntoChildren(...args: TailParameters<typeof node.splitNodeIntoChildren>): ReturnType<typeof node.splitNodeIntoChildren> { return node.splitNodeIntoChildren(this, ...args); }

  splitSourceParagraphsIntoSentenceChildren(...args: TailParameters<typeof node.splitSourceParagraphsIntoSentenceChildren>): ReturnType<typeof node.splitSourceParagraphsIntoSentenceChildren> { return node.splitSourceParagraphsIntoSentenceChildren(this, ...args); }

  mergeNodeIntoPreviousSibling(...args: TailParameters<typeof node.mergeNodeIntoPreviousSibling>): ReturnType<typeof node.mergeNodeIntoPreviousSibling> { return node.mergeNodeIntoPreviousSibling(this, ...args); }

  mergeNodeIntoTarget(...args: TailParameters<typeof node.mergeNodeIntoTarget>): ReturnType<typeof node.mergeNodeIntoTarget> { return node.mergeNodeIntoTarget(this, ...args); }

  promoteNode(...args: TailParameters<typeof node.promoteNode>): ReturnType<typeof node.promoteNode> { return node.promoteNode(this, ...args); }

  moveNodeToParent(...args: TailParameters<typeof node.moveNodeToParent>): ReturnType<typeof node.moveNodeToParent> { return node.moveNodeToParent(this, ...args); }

  moveNodeAfterSibling(...args: TailParameters<typeof node.moveNodeAfterSibling>): ReturnType<typeof node.moveNodeAfterSibling> { return node.moveNodeAfterSibling(this, ...args); }

  moveNodeBeforeSibling(...args: TailParameters<typeof node.moveNodeBeforeSibling>): ReturnType<typeof node.moveNodeBeforeSibling> { return node.moveNodeBeforeSibling(this, ...args); }

  isDescendant(...args: TailParameters<typeof node.isDescendant>): ReturnType<typeof node.isDescendant> { return node.isDescendant(this, ...args); }
  addAxiomRefToNode(...args: TailParameters<typeof axiomRef.addAxiomRefToNode>): ReturnType<typeof axiomRef.addAxiomRefToNode> { return axiomRef.addAxiomRefToNode(this, ...args); }

  addNodeRefToNode(...args: TailParameters<typeof axiomRef.addNodeRefToNode>): ReturnType<typeof axiomRef.addNodeRefToNode> { return axiomRef.addNodeRefToNode(this, ...args); }

  deleteRef(...args: TailParameters<typeof axiomRef.deleteRef>): ReturnType<typeof axiomRef.deleteRef> { return axiomRef.deleteRef(this, ...args); }

  // 未启用（待重新设计）：经 doc.exportMarkdown 入口已停用——渲染有「地址当标题 / 混入 node_note」等
  // 功能错误，导出应写文件而非返回命令行，幂等与 import/export 对称设计未定。实现暂留作重做
  // 参考，当前无入口可达；重做时连同 core.renderDocMarkdown 一并设计。
  exportDocMarkdown(docId: unknown) {
    const normalizedDocId = requireStableId(docId, 'export docId');
    const doc = this.conn.prepare('SELECT * FROM docs WHERE id = ?').get<DocRow>(normalizedDocId);
    if (!doc) throw new Error(`Document not found: ${normalizedDocId}`);
    const rows = this.conn.prepare(`
      SELECT *
      FROM nodes
      WHERE doc_id = ?
      ORDER BY depth, address, sort_order, id
    `).all<NodeRow>(normalizedDocId).sort(compareNodeAddress);
    // 渲染下沉 core/markdown-export.mjs（与导入侧 core/tree.mjs 对称）；store 只负责查库 + 地址排序。
    return renderDocMarkdown(doc, rows as Array<NodeRow & RowObject>);
  }

  // 历史读：列文档历史 / 节点级历史。祖先链查询与子树成员辅助是 history 模块内部实现、门面不暴露。
  listHistory(docId: unknown) {
    return history.listHistory(this, docId as string);
  }

  nodeHistory(docId: unknown, address: unknown, options: RowObject = {}) {
    return history.nodeHistory(this, docId, address, options);
  }

  createCommit(...args: TailParameters<typeof history.createCommit>): ReturnType<typeof history.createCommit> { return history.createCommit(this, ...args); }

  commitSnapshotFromRow(...args: TailParameters<typeof history.commitSnapshotFromRow>): ReturnType<typeof history.commitSnapshotFromRow> { return history.commitSnapshotFromRow(this, ...args); }

  commitSnapshot(...args: TailParameters<typeof history.commitSnapshot>): ReturnType<typeof history.commitSnapshot> { return history.commitSnapshot(this, ...args); }

  gcHistoryObjects() {
    return history.gcHistoryObjects(this);
  }

  saveHistorySnapshot(args: SaveHistorySnapshotPayload) {
    return history.saveHistorySnapshot(this, args);
  }

  certifyNodes(args: CertifyNodesPayload) {
    return history.certifyNodes(this, args);
  }

  computeDiff(...args: TailParameters<typeof history.computeDiff>): ReturnType<typeof history.computeDiff> { return history.computeDiff(this, ...args); }

  restoreCommit(commitId: unknown) {
    return history.restoreCommit(this, commitId);
  }

  revertCommit(args: RevertCommitPayload) {
    return history.revertCommit(this, args);
  }

  updateDocAxiomsCollapsed(...args: TailParameters<typeof document.updateDocAxiomsCollapsed>): ReturnType<typeof document.updateDocAxiomsCollapsed> { return document.updateDocAxiomsCollapsed(this, ...args); }

  updateDocTreeViewState(...args: TailParameters<typeof document.updateDocTreeViewState>): ReturnType<typeof document.updateDocTreeViewState> { return document.updateDocTreeViewState(this, ...args); }
  addAxiom(...args: TailParameters<typeof axiomRef.addAxiom>): ReturnType<typeof axiomRef.addAxiom> { return axiomRef.addAxiom(this, ...args); }

  listAxioms(...args: TailParameters<typeof axiomRef.listAxioms>): ReturnType<typeof axiomRef.listAxioms> { return axiomRef.listAxioms(this, ...args); }

  deleteAxiom(...args: TailParameters<typeof axiomRef.deleteAxiom>): ReturnType<typeof axiomRef.deleteAxiom> { return axiomRef.deleteAxiom(this, ...args); }

  updateAxiom(...args: TailParameters<typeof axiomRef.updateAxiom>): ReturnType<typeof axiomRef.updateAxiom> { return axiomRef.updateAxiom(this, ...args); }

  moveAxiom(...args: TailParameters<typeof axiomRef.moveAxiom>): ReturnType<typeof axiomRef.moveAxiom> { return axiomRef.moveAxiom(this, ...args); }

  getDocFolder(...args: TailParameters<typeof document.getDocFolder>): ReturnType<typeof document.getDocFolder> { return document.getDocFolder(this, ...args); }

  normalizeFolderId(...args: TailParameters<typeof document.normalizeFolderId>): ReturnType<typeof document.normalizeFolderId> { return document.normalizeFolderId(this, ...args); }

  nextFolderSortOrder(...args: TailParameters<typeof document.nextFolderSortOrder>): ReturnType<typeof document.nextFolderSortOrder> { return document.nextFolderSortOrder(this, ...args); }

  nextDocSortOrder(...args: TailParameters<typeof document.nextDocSortOrder>): ReturnType<typeof document.nextDocSortOrder> { return document.nextDocSortOrder(this, ...args); }

  isDocFolderDescendant(...args: TailParameters<typeof document.isDocFolderDescendant>): ReturnType<typeof document.isDocFolderDescendant> { return document.isDocFolderDescendant(this, ...args); }
  normalizeSiblingOrder(docId: unknown, parentId: unknown) {
    const siblings = this.conn.prepare(`
      SELECT id FROM nodes
      WHERE doc_id = ? AND parent_id IS ?
      ORDER BY sort_order, id
    `).all<Pick<NodeRow, 'id'>>(docId, parentId);

    siblings.forEach((sibling, index) => {
      this.conn.prepare('UPDATE nodes SET sort_order = ? WHERE id = ?').run(index + 1, sibling.id);
    });
  }

  setSiblingOrder(docId: unknown, parentId: unknown, orderedIds: unknown[]) {
    orderedIds.forEach((id, index) => {
      this.conn.prepare(`
        UPDATE nodes
        SET parent_id = ?, sort_order = ?
        WHERE doc_id = ? AND id = ?
      `).run(parentId, index + 1, docId, id);
    });
  }

  touchDoc(docId: unknown) {
    this.conn.prepare('UPDATE docs SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(docId);
  }

  createSnapshot(...args: TailParameters<typeof history.createSnapshot>): ReturnType<typeof history.createSnapshot> { return history.createSnapshot(this, ...args); }

  assertRestorableSnapshot(...args: TailParameters<typeof history.assertRestorableSnapshot>): ReturnType<typeof history.assertRestorableSnapshot> { return history.assertRestorableSnapshot(this, ...args); }

  writeDocSnapshotObjects(...args: TailParameters<typeof history.writeDocSnapshotObjects>): ReturnType<typeof history.writeDocSnapshotObjects> { return history.writeDocSnapshotObjects(this, ...args); }

  // 编辑器易失令牌（editor-session 域）：实例挂 store（生命周期随连接、对象库 GC 需 liveRoots 保活根），
  // 但动作面直接用 store.editorSnapshots.*（handlers/write/history）——store 不再留门面方法（§6-1）。

  restoreSnapshot(...args: TailParameters<typeof history.restoreSnapshot>): ReturnType<typeof history.restoreSnapshot> { return history.restoreSnapshot(this, ...args); }

  insertSnapshotNodes(...args: TailParameters<typeof history.insertSnapshotNodes>): ReturnType<typeof history.insertSnapshotNodes> { return history.insertSnapshotNodes(this, ...args); }

  // 写代数戳：data_version（其它连接的提交——只读连接感知写连接靠它，且在只读快照事务内冻结）
  // + total_changes（本连接累计写行数）。任何来源的写都会改变戳值，作缓存失效信号绝不给旧值。
  _dataChangeStamp(): string {
    const dataVersion = Number(this.conn.pragma('data_version', { simple: true })) || 0;
    const totalChanges = Number(this.conn.prepare('SELECT total_changes() AS c').get<{ c: number }>()?.c) || 0;
    return `${dataVersion}:${totalChanges}`;
  }

  // 只读快照事务（BEGIN DEFERRED）：WAL 下把一个请求内的多条 SELECT 钉在同一提交点。
  // 供只读连接（database.read 绕队列）用；与 withTransaction 的差别是不取写锁（IMMEDIATE
  // 在 readonly 连接直接报 SQLITE_READONLY，且会与写连接互相阻塞——正是绕行要避开的）。
  // fn 返回 Promise 的读动词（semantic 等）事务在 promise 未决时即 COMMIT——只读事务提前
  // 结束无害，只是那类动词退回逐查询快照，不享受请求级一致性。
  withReadSnapshot<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.inTransaction = true;
    this.conn.exec('BEGIN');
    try {
      const result = fn();
      this.conn.exec('COMMIT');
      return result;
    } catch (error) {
      this.conn.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  withTransaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();

    this.inTransaction = true;
    this.conn.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.conn.exec('COMMIT');
      return result;
    } catch (error) {
      this.conn.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
}
