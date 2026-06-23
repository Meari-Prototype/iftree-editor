import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

import { mergeNodeNotes } from '../../core/node-notes.mjs';
import { normalizeNodeType } from '../../core/node-model.mjs';
import { buildTree, splitSentences } from '../../core/tree.mjs';
import { computeSubtreeHashes } from '../../core/merkle.mjs';
import { compareNodeAddress, editModeMismatchMessage, parseJsonObject, assertNoHumanTagField } from '../shared.mjs';
import { memoryVolumeMetaOf } from '../memory/index.mjs';
import { AXIOM_ORDER_SQL, TABLES_SQL, SCHEMA_VERSION } from '../db/schema.mjs';
import {
  compareStableIds,
  newStableId,
  requireStableId,
  sameStableId
} from '../db/ids.mjs';
import {
  addressSortKey,
  areRecordsAddressSorted,
  hasPatchValue,
  normalizeDocFolderName,
  normalizeNodeIdBatch,
  normalizeNodeSizeMode,
  normalizeNullableText,
  normalizePositiveId,
  normalizePositiveNumber,
  normalizeSourcePosition,
  normalizeTreeViewState,
  patchValue,
  recordSentenceIndexes
} from '../db/normalizers.mjs';
import {
  assertRestorableSnapshotPayload,
  computeSnapshotDiff
} from '../db/snapshot-history.mjs';
import {
  buildCommitMeta,
  materializeTree,
  readSource,
  writeSource,
  // 别名避开 stream-push 路径里那个同名的局部 writeTree（按地址插树，语义不同）。
  writeTree as writeCommitTree
} from '../db/object-store.mjs';
import {
  LIBRARY_NAVIGATION_DOC_ID,
  LIBRARY_NAVIGATION_DOC_META,
  LIBRARY_NAVIGATION_DOC_TITLE
} from '../virtual-docs.mjs';
import {
  projectEditBranchDoc
} from '../edit-branch-projection.mjs';
import { pdfHighlightRects, pdfSpanHitRects } from '../pdf-highlight-geometry.mjs';
import { renderDocMarkdown } from '../../core/markdown-export.mjs';
import { EditorSnapshotTokens } from '../editor-snapshot-tokens.mjs';
import * as history from './history.mjs';
import * as editBranch from './edit-branch.mjs';

// 文档编辑模式三态（projectneed 4-16-8）：只读 / 增量编辑（流式写入）/ 完整编辑（2way/3way）。
const EDIT_MODES = Object.freeze(['readonly', 'incremental', 'full']);
// 流式写入请求级防抖窗口（毫秒）：短时间内携带同一幂等键的重复推送只生效一次（projectneed 4-16-5）。
const STREAM_PUSH_DEDUPE_MS = 10000;

// PDF 高亮几何（含入参区间清洗）已移至 ./pdf-highlight-geometry.mjs（后端解耦第 1 步）。
// 编辑分支的 base-snapshot / empty-diff / entry-trust 判定已移至 ./edit-branch.mjs；
// 节点补丁字段校验（hasOwnValue / assertNoHumanTagField / assertNoEditTrustField）移至 ../shared.mjs，
// 由底座 updateNode 与编辑分支暂存方法共用。


// 对比弹窗的 diff/公理渲染与节点客户端别名已移至 ./diff-view.mjs（后端解耦第 1 步）。
// store 仅在 getEditBranchDiffView 与编辑分支暂存方法里 import 复用它们。

export class IftreeStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.inTransaction = false;
    this.readonly = false;
    this.editorSnapshots = new EditorSnapshotTokens(this);
  }

  init(options = {}) {
    const readonly = options.readonly === true;
    this.readonly = readonly;
    // WAL 不支持网络文件系统，数据库必须在本地盘（projectneed 18-6-2）；
    // 映射盘符无法廉价识别，这里只拦最明显的 UNC 形态。
    if (/^(\\\\|\/\/)/.test(String(this.dbPath))) {
      throw new Error(`数据库路径不能是网络位置（WAL 要求本地盘）：${this.dbPath}`);
    }
    if (!readonly) mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath, readonly ? { readonly: true, fileMustExist: true } : undefined);
    this.db.pragma('busy_timeout = 5000');
    if (readonly) {
      this.db.pragma('query_only = ON');
      return;
    }
    // WAL：写入持续发生（事件卷落库）时只读实例并发读不被阻塞（projectneed 18-6-2）。
    // 切换需要短暂独占；被旧 rollback 模式连接占着时 SQLite 静默返回原模式，必须炸而不是带病运行。
    const journalMode = String(this.db.pragma('journal_mode = WAL', { simple: true }));
    if (journalMode.toLowerCase() !== 'wal') {
      throw new Error(`journal_mode 切换 WAL 失败（仍为 ${journalMode}）：关闭其他占用该库的进程后重试`);
    }
    // WAL 标准搭配：NORMAL 在断电时最多丢最近 checkpoint 后的提交，不损坏库。
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(TABLES_SQL);
    this.applySchemaVersion();
    this.ensureVirtualDocs();
  }

  // schema 版本闸：建表后只读 user_version 决定要不要迁移，跑过（版本已到位）启动期零全表扫。
  // 新空库与现有 0.5.0 live（结构已最新）直接盖章到当前版；更老或结构不符的库拒绝原地启动，
  // 引导走 导出→导入 迁移（本版本不在 init 里做旧库原地升级）。
  applySchemaVersion() {
    const current = Number(this.db.pragma('user_version', { simple: true }));
    if (current === SCHEMA_VERSION) return;
    if (current === 0) {
      if (!this.isLatestStructure()) {
        throw new Error(
          '数据库结构不是 0.5.0+ 形态，本版本只兼容 0.5.0 起的库；'
          + '更老的库请用 导出→导入 迁移（scripts/export-db-to-json + scripts/import-db-from-json）'
        );
      }
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
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
  ensureNodeHashes(docId) {
    const rows = this.db.prepare(
      'SELECT id, parent_id, sort_order, text, node_title, node_note, node_type, trust_level, content_hash, subtree_hash FROM nodes WHERE doc_id = ?'
    ).all(docId);
    if (rows.length === 0) return new Map();
    const doc = this.db.prepare('SELECT nodes_hash_dirty FROM docs WHERE id = ?').get(docId);
    const clean = doc && Number(doc.nodes_hash_dirty) === 0
      && rows.every((row) => row.content_hash && row.subtree_hash);
    if (clean) {
      return new Map(rows.map((row) => [String(row.id), { contentHash: row.content_hash, subtreeHash: row.subtree_hash }]));
    }
    const hashes = computeSubtreeHashes(rows);
    if (!this.readonly) {
      const update = this.db.prepare('UPDATE nodes SET content_hash = ?, subtree_hash = ? WHERE id = ?');
      this.withTransaction(() => {
        for (const [id, hash] of hashes) update.run(hash.contentHash, hash.subtreeHash, id);
        this.db.prepare('UPDATE docs SET nodes_hash_dirty = 0 WHERE id = ?').run(docId);
      });
    }
    return hashes;
  }

  ensureVirtualDocs() {
    this.db.prepare(`
      INSERT INTO docs (id, title, meta, folder_id, doc_sort_order)
      VALUES (?, ?, ?, NULL, 0)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        meta = excluded.meta
    `).run(
      LIBRARY_NAVIGATION_DOC_ID,
      LIBRARY_NAVIGATION_DOC_TITLE,
      JSON.stringify(LIBRARY_NAVIGATION_DOC_META)
    );
  }

  columnInfo(table, name) {
    try {
      return this.db.prepare(`PRAGMA table_info(${table})`).all()
        .find((column) => column.name === name) || null;
    } catch {
      return null;
    }
  }

  columnType(table, name) {
    return String(this.columnInfo(table, name)?.type || '').trim().toUpperCase();
  }

  hasColumn(table, name) {
    return this.columnInfo(table, name) !== null;
  }

  dropColumnIfExists(table, name) {
    let columns;
    try {
      columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    } catch {
      return false;
    }
    if (!columns.some((column) => column.name === name)) return false;
    this.db.exec(`ALTER TABLE ${table} DROP COLUMN ${name}`);
    return true;
  }

  ensureColumn(table, name, definition) {
    try {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        return true;
      }
    } catch { /* table may not exist yet */ }
    return false;
  }

  hasNodeColumns(names = []) {
    try {
      const columns = new Set(this.db.prepare('PRAGMA table_info(nodes)').all().map((column) => column.name));
      return names.every((name) => columns.has(name));
    } catch {
      return false;
    }
  }

  hasTable(name) {
    try {
      return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(String(name || '')));
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
      const rows = this.db.prepare(`
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
      `).all();
      const insert = this.db.prepare(`
        INSERT INTO refs (id, source_type, source_id, target_type, target_id, ref_kind, note)
        VALUES (?, 'axiom', ?, 'node', ?, '事实前提', NULL)
      `);
      this.withTransaction(() => {
        for (const row of rows) insert.run(newStableId(), row.axiom_id, row.root_id);
      });
    } catch { /* table may not exist yet */ }
  }

  ensureAxiomRefsForDoc(docId) {
    try {
      const root = this.db.prepare('SELECT id FROM nodes WHERE doc_id = ? AND parent_id IS NULL ORDER BY id LIMIT 1').get(docId);
      if (!root) return;
      const rows = this.db.prepare(`
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
      `).all(docId, root.id);
      const insert = this.db.prepare(`
        INSERT INTO refs (id, source_type, source_id, target_type, target_id, ref_kind, note)
        VALUES (?, 'axiom', ?, 'node', ?, '事实前提', NULL)
      `);
      this.withTransaction(() => {
        for (const row of rows) insert.run(newStableId(), row.axiom_id, root.id);
      });
    } catch { /* table may not exist yet */ }
  }

  refreshAllAddresses() {
    const docs = this.db.prepare('SELECT id FROM docs ORDER BY id').all();
    let updated = 0;
    this.withTransaction(() => {
      const updateStmt = this.db.prepare('UPDATE nodes SET depth = ?, address = ? WHERE doc_id = ? AND id = ?');
      for (const { id: docId } of docs) {
        updated += this.refreshDocAddresses(docId, updateStmt).updated;
      }
    });
    return { updated, docs: docs.length };
  }

  refreshDocAddresses(docId, updateStmt = null) {
    const normalizedDocId = normalizePositiveId(docId);
    if (normalizedDocId === null) return { updated: 0 };
    const rows = this.db.prepare(`
      SELECT id, parent_id, sort_order
      FROM nodes
      WHERE doc_id = ?
      ORDER BY parent_id IS NOT NULL, parent_id, sort_order, id
    `).all(normalizedDocId);
    if (rows.length === 0) return { updated: 0 };

    const childrenByParent = new Map();
    for (const row of rows) {
      const parentKey = row.parent_id ?? null;
      if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
      childrenByParent.get(parentKey).push(row);
    }
    for (const children of childrenByParent.values()) {
      children.sort((left, right) => left.sort_order - right.sort_order || compareStableIds(left.id, right.id));
    }

    const update = updateStmt || this.db.prepare('UPDATE nodes SET depth = ?, address = ? WHERE doc_id = ? AND id = ?');
    let updated = 0;
    const visit = (node, address, depth) => {
      const result = update.run(depth, address, normalizedDocId, node.id);
      updated += result.changes || 0;
      const children = childrenByParent.get(node.id) || [];
      for (let index = 0; index < children.length; index += 1) {
        visit(children[index], `${address}-${index + 1}`, depth + 1);
      }
    };

    this.withTransaction(() => {
      const roots = childrenByParent.get(null) || [];
      for (let index = 0; index < roots.length; index += 1) {
        visit(roots[index], String(index + 1), 1);
      }
    });
    return { updated };
  }

  refreshAddressScopes(docId, parentIds = []) {
    const normalizedDocId = normalizePositiveId(docId);
    if (normalizedDocId === null) return { updated: 0, scopes: 0 };
    const normalizedParentIds = [];
    const seen = new Set();
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

  refreshAddressScope(docId, parentId = null) {
    const normalizedDocId = normalizePositiveId(docId);
    if (normalizedDocId === null) return { updated: 0 };
    let baseAddress = '';
    let baseDepth = 0;
    if (parentId !== null && parentId !== undefined) {
      const parent = this.db.prepare(`
        SELECT address, depth
        FROM nodes
        WHERE doc_id = ? AND id = ?
      `).get(normalizedDocId, parentId);
      if (!parent) return { updated: 0 };
      baseAddress = parent.address || '';
      baseDepth = Math.max(1, Math.floor(Number(parent.depth) || 1));
    }

    const rows = this.db.prepare(`
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
    `).all(normalizedDocId, parentId ?? null, normalizedDocId);
    if (rows.length === 0) return { updated: 0 };

    const childrenByParent = new Map();
    for (const row of rows) {
      const parentKey = row.parent_id ?? null;
      if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
      childrenByParent.get(parentKey).push(row);
    }
    for (const children of childrenByParent.values()) {
      children.sort((left, right) => left.sort_order - right.sort_order || compareStableIds(left.id, right.id));
    }

    const update = this.db.prepare(`
      UPDATE nodes
      SET depth = ?,
          address = ?
      WHERE doc_id = ? AND id = ?
        AND (depth IS NOT ? OR address IS NOT ?)
    `);
    let updated = 0;
    const visit = (node, address, depth) => {
      const result = update.run(depth, address, normalizedDocId, node.id, depth, address);
      updated += result.changes || 0;
      const children = childrenByParent.get(node.id) || [];
      for (let index = 0; index < children.length; index += 1) {
        visit(children[index], `${address}-${index + 1}`, depth + 1);
      }
    };

    const roots = childrenByParent.get(parentId ?? null) || [];
    for (let index = 0; index < roots.length; index += 1) {
      const address = parentId === null || parentId === undefined
        ? String(index + 1)
        : `${baseAddress}-${index + 1}`;
      visit(roots[index], address, baseDepth + 1);
    }
    return { updated };
  }

  removeRootAxiomRefs(docId = null) {
    try {
      const params = [];
      const docFilter = docId ? 'AND axioms.doc_id = ?' : '';
      if (docId) params.push(docId);
      this.db.prepare(`
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
    if (this.db) this.db.close();
    this.db = null;
  }

  listDocs() {
    // 只隐藏「独立副本形态」的影子文档（shadow ≠ base 的旧形态行）；op-log 形态下
    // shadow_doc_id == base_doc_id，开着活跃分支的文档本体必须照常列出——
    // 否则 base 文档被自己的影子滤掉，前端文件树把它当「未导入」（实际翻过车）。
    const shadowFilter = this.hasEditBranchesTable()
      ? `WHERE NOT EXISTS (
        SELECT 1 FROM edit_branches eb
        WHERE eb.shadow_doc_id = d.id AND eb.status = 'active'
          AND eb.shadow_doc_id != eb.base_doc_id
      )`
      : '';
    return this.db.prepare(`
      SELECT
        d.*,
        (SELECT COUNT(*) FROM nodes n WHERE n.doc_id = d.id) AS node_count
      FROM docs d
      ${shadowFilter}
      ORDER BY d.folder_id IS NOT NULL, d.folder_id, d.doc_sort_order, d.updated_at DESC, d.id DESC
    `).all();
  }

  listDocFolders() {
    return this.db.prepare(`
      SELECT * FROM doc_folders
      ORDER BY parent_id IS NOT NULL, parent_id, sort_order, name, id
    `).all();
  }

  createDocFolder({ name, parentId = null }) {
    const folderName = normalizeDocFolderName(name);
    const normalizedParentId = this.normalizeFolderId(parentId);
    const sortOrder = this.nextFolderSortOrder(normalizedParentId);
    const result = this.db.prepare(`
      INSERT INTO doc_folders (parent_id, name, sort_order)
      VALUES (?, ?, ?)
    `).run(normalizedParentId, folderName, sortOrder);
    return this.db.prepare('SELECT * FROM doc_folders WHERE id = ?').get(Number(result.lastInsertRowid));
  }

  updateDocFolder(folderId, patch = {}) {
    const folder = this.getDocFolder(folderId);
    if (!folder) throw new Error(`Document folder not found: ${folderId}`);

    const updates = [];
    const values = [];
    if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
      const name = normalizeDocFolderName(patch.name);
      updates.push('name = ?');
      values.push(name);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'parentId')) {
      const parentId = this.normalizeFolderId(patch.parentId);
      if (parentId === folder.id) throw new Error('Folder cannot be moved into itself');
      if (parentId !== null && this.isDocFolderDescendant(parentId, folder.id)) {
        throw new Error('Folder cannot be moved into its descendant');
      }
      updates.push('parent_id = ?');
      values.push(parentId);
    }
    if (updates.length === 0) return folder;

    updates.push('updated_at = CURRENT_TIMESTAMP');
    this.db.prepare(`UPDATE doc_folders SET ${updates.join(', ')} WHERE id = ?`).run(...values, folder.id);
    return this.getDocFolder(folder.id);
  }

  deleteDocFolder(folderId) {
    const folder = this.getDocFolder(folderId);
    if (!folder) return false;

    const childCount = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM doc_folders WHERE parent_id = ?
    `).get(folder.id).count);
    const docCount = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM docs WHERE folder_id = ?
    `).get(folder.id).count);
    if (childCount > 0 || docCount > 0) {
      throw new Error('Cannot delete a non-empty folder');
    }

    this.db.prepare('DELETE FROM doc_folders WHERE id = ?').run(folder.id);
    return true;
  }

  moveDocToFolder({ docId, folderId = null }) {
    const doc = this.db.prepare('SELECT id FROM docs WHERE id = ?').get(docId);
    if (!doc) return false;
    const normalizedFolderId = this.normalizeFolderId(folderId);
    const sortOrder = this.nextDocSortOrder(normalizedFolderId);
    this.db.prepare(`
      UPDATE docs
      SET folder_id = ?, doc_sort_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(normalizedFolderId, sortOrder, doc.id);
    return true;
  }

  createDoc({ title, rootText = title, meta = null, folderId = null, skipInitialCommit = false }) {
    return this.withTransaction(() => {
      const normalizedFolderId = this.normalizeFolderId(folderId);
      const sortOrder = this.nextDocSortOrder(normalizedFolderId);
      const docId = newStableId();
      const rootNodeId = newStableId();
      this.db.prepare(`
        INSERT INTO docs (id, title, meta, folder_id, doc_sort_order)
        VALUES (?, ?, ?, ?, ?)
      `).run(docId, title, meta, normalizedFolderId, sortOrder);
      this.db.prepare(`
        INSERT INTO nodes (id, doc_id, parent_id, sort_order, node_type, text)
        VALUES (?, ?, NULL, 1, 'TEXT', ?)
      `).run(rootNodeId, docId, rootText || title);
      this.db.prepare(`
        INSERT INTO doc_heads (doc_id, head_commit_id)
        VALUES (?, NULL)
        ON CONFLICT(doc_id) DO NOTHING
      `).run(docId);
      this.refreshDocAddresses(docId);

      // 建文档即建初始 commit（历史起点）：否则首个编辑 commit 无父，编辑后 revert/restore 退不回初始态。
      // 结构化/句子导入会在装完整棵树后另建一次「导入」commit，故调用方传 skipInitialCommit 跳过这里的单根快照。
      if (!skipInitialCommit) {
        this.createCommit({ docId, summary: '初始版本', snapshot: this.createSnapshot(docId), author: 'import' });
      }

      return { id: docId, title, rootNodeId };
    });
  }

  // 为记忆卷写库内实体锚的 source 记录（projectneed 15-10-4：非导航文档必有库内实体锚）。
  // original_path 指向 .memory 下的 symlink/占位文件；raw_markdown 留空（正文在 nodes）。
  setMemoryAnchorSource(docId, originalPath, sourceType = 'memory-anchor') {
    if (!docId || !originalPath) throw new Error('setMemoryAnchorSource requires docId and originalPath');
    return this.withTransaction(() => {
      this.db.prepare('DELETE FROM source_documents WHERE doc_id = ?').run(docId);
      this.db.prepare(`
        INSERT INTO source_documents (doc_id, source_type, original_path, raw_markdown)
        VALUES (?, ?, ?, ?)
      `).run(docId, sourceType, originalPath, '');
      return true;
    });
  }

  deleteDoc(docId) {
    const doc = this.db.prepare('SELECT id, meta FROM docs WHERE id = ?').get(docId);
    if (!doc) return false;
    // 完整记忆永不删除（projectneed 15-10）：由结构保证而非纪律。
    // 但「永不删除」保的是有合法实体锚的卷；无实体锚的记忆卷属非法残留
    // （违反 3-5/15-10-4「非导航文档必有库内实体锚」），允许清除。
    if (memoryVolumeMetaOf(doc.meta)) {
      const anchored = this.db.prepare('SELECT 1 FROM source_documents WHERE doc_id = ? LIMIT 1').get(docId);
      if (anchored) {
        throw new Error(`记忆卷不可删除（完整记忆永不删除，projectneed 15-10）：${docId}`);
      }
    }

    this.withTransaction(() => {
      this.db.prepare('DELETE FROM edit_branches WHERE base_doc_id = ? OR shadow_doc_id = ?').run(docId, docId);
      this.db.prepare(`
        DELETE FROM refs
        WHERE (source_type = 'node' AND source_id IN (SELECT id FROM nodes WHERE doc_id = ?))
           OR (target_type = 'node' AND target_id IN (SELECT id FROM nodes WHERE doc_id = ?))
      `).run(docId, docId);
      // 打断 nodes.parent_id 自引用链再删：超深树（如导入的深 heading 链）直接 DELETE 会让
      // ON DELETE CASCADE 沿父链逐层递归，超过 SQLite 触发器递归上限而崩
      // （SqliteError: too many levels of trigger recursion）。置空 parent_id 后 cascade 即变平删。
      this.db.prepare('UPDATE nodes SET parent_id = NULL WHERE doc_id = ?').run(docId);
      this.db.prepare('DELETE FROM docs WHERE id = ?').run(docId);
    });

    return true;
  }

  // ─── 流式写入与文档编辑模式（projectneed 4-16）──────────────
  getDocEditMode(docId) {
    const row = this.db.prepare('SELECT edit_mode FROM docs WHERE id = ?').get(docId);
    return row ? (row.edit_mode || 'full') : null;
  }

  setDocEditMode(docId, mode) {
    const normalized = String(mode || '').trim();
    if (!EDIT_MODES.includes(normalized)) {
      throw new Error(`未知编辑模式：${mode}；只能是 ${EDIT_MODES.join(' / ')}`);
    }
    const doc = this.db.prepare('SELECT id FROM docs WHERE id = ?').get(docId);
    if (!doc) throw new Error(`Doc not found: ${docId}`);
    this.db.prepare('UPDATE docs SET edit_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(normalized, docId);
    return this.db.prepare('SELECT id, title, edit_mode FROM docs WHERE id = ?').get(docId);
  }

  _streamPushFromCache(key) {
    if (!key || !this._streamPushCache) return null;
    const hit = this._streamPushCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > STREAM_PUSH_DEDUPE_MS) {
      this._streamPushCache.delete(key);
      return null;
    }
    return hit.result;
  }

  _rememberStreamPush(key, result) {
    if (!key) return;
    if (!this._streamPushCache) this._streamPushCache = new Map();
    const now = Date.now();
    for (const [k, v] of this._streamPushCache) {
      if (now - v.at > STREAM_PUSH_DEDUPE_MS) this._streamPushCache.delete(k);
    }
    this._streamPushCache.set(key, { at: now, result });
  }

  // 一条流式节点：调用方按 4-16-7 给齐标准字段；trust_level 必给（4-16-4，不闭眼填），node_type 缺省 TEXT。
  // 流式节点标准字段：trust_level 必给（4-16-4），source_position 可选（配合 stream.attachSource
  // 的源文档层，流式文档同样能做句位对照），其余缺省。
  _streamNodeFields(item = {}) {
    // 写动词写入信任恒为不受控（projectneed 18-3：trust 字段下线，标受控只走 human 档 certify）；
    // 不再要求/采纳调用方给的 trust_level。事件卷的不受控约束（15-10-3）与此一致。
    return {
      trustLevel: '不受控',
      nodeType: normalizeNodeType(item.node_type ?? item.nodeType ?? 'TEXT'),
      text: typeof item.text === 'string' ? item.text : '',
      nodeTitle: item.node_title ?? item.nodeTitle ?? '',
      nodeNote: item.node_note ?? item.nodeNote ?? '',
      sourcePosition: normalizeSourcePosition(item.source_position ?? item.sourcePosition ?? null)
    };
  }

  _assertVolumeNodesUncontrolled(items) {
    for (const item of items || []) {
      const trust = item?.trust_level ?? item?.trustLevel ?? null;
      if (trust === '受控') {
        throw new Error('记忆卷节点一律不受控（projectneed 15-10-3）；收到 trust_level=受控');
      }
      const children = Array.isArray(item?.children) ? item.children : [];
      if (children.length) this._assertVolumeNodesUncontrolled(children);
    }
  }

  _insertStreamNode(docId, parentId, item = {}) {
    const f = this._streamNodeFields(item);
    return this.insertNode({ docId, parentId, text: f.text, nodeType: f.nodeType, nodeTitle: f.nodeTitle, nodeNote: f.nodeNote, sourcePosition: f.sourcePosition, trustLevel: f.trustLevel });
  }

  // 校验调用方给的 address 是纯追加（连续、不重复、与父自洽，4-16-2）；违反报错带定位，调用方读结构重算重推。
  _validateStreamAddresses(items, parentAddress, startOrder) {
    let expected = startOrder + 1;
    for (const item of items) {
      const addr = String(item?.address ?? '').trim();
      if (!addr) throw new Error('流式节点缺少 address');
      const cut = addr.lastIndexOf('-');
      const prefix = cut > 0 ? addr.slice(0, cut) : '';
      const order = Number(addr.slice(cut + 1));
      if (prefix !== parentAddress) {
        throw new Error(`地址 ${addr} 的父前缀应为 ${parentAddress || '(根)'}`);
      }
      if (!Number.isInteger(order) || order <= 0) {
        throw new Error(`地址 ${addr} 末段必须是正整数`);
      }
      if (order !== expected) {
        throw new Error(`地址不连续：父 ${parentAddress} 下期望下一个 ${parentAddress}-${expected}，收到 ${addr}`);
      }
      expected += 1;
      const children = Array.isArray(item.children) ? item.children : [];
      if (children.length) this._validateStreamAddresses(children, addr, 0);
    }
  }

  // 单一标准推送入口（4-16-7）：直接 append，不走 edit branch。
  // 首次省略 docId + 给 title => 新建增量编辑文档并挂根下；之后给 docId + parentId(uuid 挂载点) 追加。
  // 调用方给 address => 校验纯追加 + 批量直写（不重排、不刷结构链），地址/深度由 address 决定（4-16-2）；
  // 不给 address => 自动续号兜底（小流友好，O(n)）。去重是调用方责任，系统只按 idempotencyKey 请求级防抖（4-16-5）。
  pushStreamNodes({ docId = null, title = null, parentId = null, nodes = [], idempotencyKey = null } = {}) {
    const list = Array.isArray(nodes) ? nodes : [];
    if (list.length === 0) throw new Error('stream.push 需要至少一个节点');

    const cached = this._streamPushFromCache(idempotencyKey);
    if (cached) return { ...cached, deduped: true };

    const result = this.withTransaction(() => {
      let targetDocId = docId;
      let createdDoc = null;
      if (targetDocId === null || targetDocId === undefined || targetDocId === '') {
        const docTitle = String(title || '').trim();
        if (!docTitle) throw new Error('首次流式写入需要 title 以新建文档');
        createdDoc = this.createDoc({ title: docTitle });
        this.setDocEditMode(createdDoc.id, 'incremental');
        targetDocId = createdDoc.id;
      } else {
        const mode = this.getDocEditMode(targetDocId);
        if (mode === null) throw new Error(`Doc not found: ${targetDocId}`);
        if (mode !== 'incremental') {
          throw new Error(editModeMismatchMessage({ docId: targetDocId, current: mode, required: 'incremental', intent: '流式写入 push' }));
        }
        // 事件卷一律不受控（projectneed 15-10-3）：拒绝而非静默改写，让调用方知道契约被违反。
        const metaRow = this.db.prepare('SELECT meta FROM docs WHERE id = ?').get(targetDocId);
        if (memoryVolumeMetaOf(metaRow?.meta)) this._assertVolumeNodesUncontrolled(list);
      }

      const rootId = createdDoc
        ? createdDoc.rootNodeId
        : this.db.prepare('SELECT id FROM nodes WHERE doc_id = ? AND parent_id IS NULL').get(targetDocId)?.id;
      const mountId = parentId ?? rootId;
      const mount = this.db.prepare('SELECT id, address FROM nodes WHERE id = ? AND doc_id = ?').get(mountId, targetDocId);
      if (!mount) throw new Error(`挂载点 ${mountId} 不在文档 ${targetDocId} 中`);

      const useAddresses = list.some((item) => item && item.address != null);
      let createdCount = 0;
      let created;

      if (useAddresses) {
        const maxRow = this.db.prepare('SELECT MAX(sort_order) AS m FROM nodes WHERE doc_id = ? AND parent_id = ?').get(targetDocId, mountId);
        this._validateStreamAddresses(list, String(mount.address || ''), Number(maxRow?.m) || 0);
        const insert = this.db.prepare(`
          INSERT INTO nodes (id, doc_id, parent_id, sort_order, depth, address, node_type, text, node_title, node_note, source_position, trust_level)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const writeTree = (items, parentDbId) => items.map((item) => {
          const f = this._streamNodeFields(item);
          const addr = String(item.address).trim();
          const order = Number(addr.slice(addr.lastIndexOf('-') + 1));
          const id = newStableId();
          insert.run(id, targetDocId, parentDbId, order, addr.split('-').length, addr, f.nodeType, f.text, f.nodeTitle || '', f.nodeNote || '', f.sourcePosition, f.trustLevel);
          createdCount += 1;
          const children = Array.isArray(item.children) ? item.children : [];
          return { id, address: addr, children: children.length ? writeTree(children, id) : [] };
        });
        created = writeTree(list, mountId);
        this.touchDoc(targetDocId);
      } else {
        const insertTree = (items, parent) => items.map((item) => {
          const node = this._insertStreamNode(targetDocId, parent, item);
          createdCount += 1;
          const children = Array.isArray(item.children) ? item.children : [];
          return { id: node.id, address: node.address, children: children.length ? insertTree(children, node.id) : [] };
        });
        created = insertTree(list, mountId);
      }
      // createdRootId：首推新建文档时带回根节点 id，调用侧（handler）要把根节点
      // 补进增量 FTS——根不在推送列表里，漏掉会让索引行数永远比 SQL 少 1。
      return { docId: targetDocId, parentId: mountId, created, createdCount, createdRootId: createdDoc ? createdDoc.rootNodeId : null };
    });

    if (this._bulkTouchedDocIds && result.docId != null) this._bulkTouchedDocIds.add(String(result.docId));
    this._rememberStreamPush(idempotencyKey, result);
    return result;
  }

  // bulk 导入会话（projectneed 4-16）：海量流式写入前临时开，导完关。
  // 只做异步写（synchronous=OFF，省 fsync；崩溃丢最近批由地址校验+幂等重推兜底）。
  // journal 保持 WAL 不降级：WAL 下切 journal 需独占库（有并发读者即失败），
  // 且保持 WAL 才能让批导期间只读实例不被写阻塞（projectneed 18-6-2）。
  // 不再 drop 二级索引：SQL/FTS 都是增量维护、全程在线，没必要等导完重建；drop 反而让删除 cascade
  // 退化成 O(n²)、崩溃后索引悬空。唯一真正延迟的重活是 bge-m3 向量（离线补）。
  // 数值：cache_size 1GB、mmap 1GB（benchmark 机器合理默认，可调）。
  // pragma 挂在连接上：私有后端=只影响发起方；共享后端一条连接服务所有客户端，等效全局——
  // 由共享服务端的独占闸门兜底（begin 需独占、期间他人写被拒、独占者掉线自动 end，
  // 见 backend-shared-server）。
  beginBulkImport() {
    this.db.pragma('synchronous = OFF');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('cache_size = -1048576');
    this.db.pragma('mmap_size = 1073741824');
    // 记下本批 bulk 写过哪些文档（主库自己的写元信息）：endBulkImport 返回给调用方，
    // 供其触发一次派生索引维护（bulk 期间不逐批维护，避免 O(N²)）。主库不碰派生索引本身。
    this._bulkTouchedDocIds = new Set();
    return {
      ok: true,
      pragmas: { synchronous: 'OFF', journal_mode: 'WAL', cache_size: '1GB', mmap_size: '1GB' }
    };
  }

  endBulkImport() {
    // 不再重建索引（begin 不再 drop，索引全程在线，base schema 也已保证其存在）。
    // 先恢复安全写入再 checkpoint(TRUNCATE)：把批导膨胀的 -wal 押回主库并截断，且本次 checkpoint 落盘有 fsync。
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    const touchedDocIds = this._bulkTouchedDocIds ? [...this._bulkTouchedDocIds] : [];
    this._bulkTouchedDocIds = null;
    return { ok: true, touchedDocIds };
  }

  // 是否在 bulk 导入会话中：写分发收尾据此判断流式 push 是逐条当场维护（非 bulk）还是
  // 累积留 bulkEnd 统一维护（bulk 中），避免每批整篇重建 BM25 退化成 O(N²)。
  hasActiveBulkImport() {
    return this._bulkTouchedDocIds != null;
  }

  // ===== 编辑分支子系统转调壳（实现在 ./edit-branch.mjs；门面对外面与抽出前逐字一致）=====
  normalizeEditBranchOwner(...args) { return editBranch.normalizeEditBranchOwner(this, ...args); }
  activeEditBranchForBaseDoc(...args) { return editBranch.activeEditBranchForBaseDoc(this, ...args); }
  activeEditBranchForShadowDoc(...args) { return editBranch.activeEditBranchForShadowDoc(this, ...args); }
  activeEditBranchForDoc(...args) { return editBranch.activeEditBranchForDoc(this, ...args); }
  listActiveEditBranches(...args) { return editBranch.listActiveEditBranches(this, ...args); }
  docIdForMutationPayload(...args) { return editBranch.docIdForMutationPayload(this, ...args); }
  nodePatchForEditBranch(...args) { return editBranch.nodePatchForEditBranch(this, ...args); }
  _appendEditBranchEntry(...args) { return editBranch._appendEditBranchEntry(this, ...args); }
  editBranchHistoryState(...args) { return editBranch.editBranchHistoryState(this, ...args); }
  getEditBranchDiffView(...args) { return editBranch.getEditBranchDiffView(this, ...args); }
  computeThreeWayMerge(...args) { return editBranch.computeThreeWayMerge(this, ...args); }
  _trunkNodeRow(...args) { return editBranch._trunkNodeRow(this, ...args); }
  _trunkSubtreeHash(...args) { return editBranch._trunkSubtreeHash(this, ...args); }
  _validateEditBranchEntriesAgainstTrunk(...args) { return editBranch._validateEditBranchEntriesAgainstTrunk(this, ...args); }
  applyThreeWayMerge(...args) { return editBranch.applyThreeWayMerge(this, ...args); }
  _replaceEditBranchDiff(...args) { return editBranch._replaceEditBranchDiff(this, ...args); }
  undoEditBranchEntry(...args) { return editBranch.undoEditBranchEntry(this, ...args); }
  redoEditBranchEntry(...args) { return editBranch.redoEditBranchEntry(this, ...args); }
  _fetchBaseRefsForDoc(...args) { return editBranch._fetchBaseRefsForDoc(this, ...args); }
  _baseDocInputsForDoc(...args) { return editBranch._baseDocInputsForDoc(this, ...args); }
  _projectedDocForBranch(...args) { return editBranch._projectedDocForBranch(this, ...args); }
  liveDocSnapshot(...args) { return editBranch.liveDocSnapshot(this, ...args); }
  _findProjectedNode(...args) { return editBranch._findProjectedNode(this, ...args); }
  _findProjectedAxiom(...args) { return editBranch._findProjectedAxiom(this, ...args); }
  stageEditBranchNodeUpdate(...args) { return editBranch.stageEditBranchNodeUpdate(this, ...args); }
  stageEditBranchNodeInsert(...args) { return editBranch.stageEditBranchNodeInsert(this, ...args); }
  stageEditBranchNodeDelete(...args) { return editBranch.stageEditBranchNodeDelete(this, ...args); }
  stageEditBranchNodeMove(...args) { return editBranch.stageEditBranchNodeMove(this, ...args); }
  stageEditBranchNodePromote(...args) { return editBranch.stageEditBranchNodePromote(this, ...args); }
  stageEditBranchNodeSplit(...args) { return editBranch.stageEditBranchNodeSplit(this, ...args); }
  stageEditBranchNodeMergeInto(...args) { return editBranch.stageEditBranchNodeMergeInto(this, ...args); }
  stageEditBranchNodeMergePrevious(...args) { return editBranch.stageEditBranchNodeMergePrevious(this, ...args); }
  stageEditBranchNodeReparent(...args) { return editBranch.stageEditBranchNodeReparent(this, ...args); }
  stageEditBranchNodeMoveBefore(...args) { return editBranch.stageEditBranchNodeMoveBefore(this, ...args); }
  stageEditBranchNodeMoveAfter(...args) { return editBranch.stageEditBranchNodeMoveAfter(this, ...args); }
  stageEditBranchAxiomAdd(...args) { return editBranch.stageEditBranchAxiomAdd(this, ...args); }
  stageEditBranchAxiomUpdate(...args) { return editBranch.stageEditBranchAxiomUpdate(this, ...args); }
  stageEditBranchAxiomDelete(...args) { return editBranch.stageEditBranchAxiomDelete(this, ...args); }
  stageEditBranchAxiomMove(...args) { return editBranch.stageEditBranchAxiomMove(this, ...args); }
  stageEditBranchRefAddAxiomToNode(...args) { return editBranch.stageEditBranchRefAddAxiomToNode(this, ...args); }
  stageEditBranchRefAddNodeToNode(...args) { return editBranch.stageEditBranchRefAddNodeToNode(this, ...args); }
  stageEditBranchRefDelete(...args) { return editBranch.stageEditBranchRefDelete(this, ...args); }
  applyEditBranchDiffEntries(...args) { return editBranch.applyEditBranchDiffEntries(this, ...args); }
  beginEditBranch(...args) { return editBranch.beginEditBranch(this, ...args); }
  findEditBranch(...args) { return editBranch.findEditBranch(this, ...args); }
  rebaseEditBranch(...args) { return editBranch.rebaseEditBranch(this, ...args); }
  cherryPickEditBranchEntries(...args) { return editBranch.cherryPickEditBranchEntries(this, ...args); }
  _cherryPickSource(...args) { return editBranch._cherryPickSource(this, ...args); }
  _selectCherryPickEntries(...args) { return editBranch._selectCherryPickEntries(this, ...args); }
  _copyCherryPickEntry(...args) { return editBranch._copyCherryPickEntry(this, ...args); }
  saveEditBranch(...args) { return editBranch.saveEditBranch(this, ...args); }
  _docNodeSignatures(...args) { return editBranch._docNodeSignatures(this, ...args); }
  _commitEditBranchPayload(...args) { return editBranch._commitEditBranchPayload(this, ...args); }
  discardEditBranch(...args) { return editBranch.discardEditBranch(this, ...args); }

  createDocFromSentences({ title, sourcePath, sentences }) {
    return this.createDocFromSentenceRecords({
      title,
      sourcePath,
      records: sentences.map((text) => ({ text, vector: null }))
    });
  }

  createDocFromSentenceRecords({ title, sourcePath, records }) {
    return this.withTransaction(() => {
      const doc = this.createDoc({
        title,
        rootText: title,
        meta: JSON.stringify({ sourcePath, importedAt: new Date().toISOString() }),
        skipInitialCommit: true
      });
      const chapter = this.insertNode({
        docId: doc.id,
        parentId: doc.rootNodeId,
        text: '原始文本导入',
        nodeType: 'TEXT'
      });
      const importedNodeIds = [];
      const importedNodeIdsByRecordIndex = {};
      const insertNode = this.db.prepare(`
        INSERT INTO nodes (id, doc_id, parent_id, sort_order, node_type, text)
        VALUES (?, ?, ?, ?, 'TEXT', ?)
      `);

      for (const [index, record] of records.entries()) {
        const nodeId = newStableId();
        insertNode.run(nodeId, doc.id, chapter.id, index + 1, record.text);
        importedNodeIds.push(nodeId);
        for (const recordIndex of recordSentenceIndexes(record, index + 1)) {
          importedNodeIdsByRecordIndex[recordIndex] = nodeId;
        }
      }
      this.refreshAddressScopes(doc.id, [chapter.id]);
      this.createCommit({ docId: doc.id, summary: '导入', snapshot: this.createSnapshot(doc.id), author: 'import' });

      return { ...doc, importedNodeIds, importedNodeIdsByRecordIndex };
    });
  }

  createDocFromStructuredRecords({ title, sourcePath, records }) {
    return this.withTransaction(() => {
      const doc = this.createDoc({
        title,
        rootText: title,
        meta: JSON.stringify({ sourcePath, importedAt: new Date().toISOString(), structured: true }),
        skipInitialCommit: true
      });

      // Build address → nodeId map as we create nodes
      const addressToId = new Map();
      const importedNodeIds = [];
      const importedNodeIdsByRecordIndex = {};
      const sorted = areRecordsAddressSorted(records) ? records : [...records].sort(compareNodeAddress);
      const insertNode = this.db.prepare(`
        INSERT INTO nodes (
          id, doc_id, parent_id, sort_order, node_type, text, node_title, node_note, source_position, trust_level
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const record of sorted) {
        const address = String(record.address || '').trim();
        const parts = address.split('-').map(Number);

        let parentId = null;
        if (parts.length === 1) {
          // Root-level node → child of doc root
          parentId = doc.rootNodeId;
        } else {
          // Child node → parent address is address without last segment
          const parentAddr = parts.slice(0, -1).join('-');
          parentId = addressToId.get(parentAddr) || doc.rootNodeId;
        }

        const sortOrder = parts[parts.length - 1] || 1;
        const nodeType = normalizeNodeType(record.nodeType ?? record.node_type ?? 'TEXT');

        const nodeId = newStableId();
        insertNode.run(
          nodeId,
          doc.id,
          parentId,
          sortOrder,
          nodeType,
          record.text || '',
          '',
          '',
          normalizeSourcePosition(record.sourcePosition ?? record.source_position),
          record.trustLevel || null
        );

        addressToId.set(address, nodeId);
        importedNodeIds.push(nodeId);
        for (const recordIndex of recordSentenceIndexes(record)) {
          importedNodeIdsByRecordIndex[recordIndex] = nodeId;
        }
      }
      this.refreshDocAddresses(doc.id);
      this.createCommit({ docId: doc.id, summary: '导入', snapshot: this.createSnapshot(doc.id), author: 'import' });

      return { ...doc, importedNodeIds, importedNodeIdsByRecordIndex };
    });
  }

  getDoc(docId, options = {}) {
    const includeSourceSpans = options.includeSourceSpans !== false;
    const includeSourceDocumentContent = options.includeSourceDocumentContent !== false;
    const maxTreeDepth = Number(options.maxTreeDepth);
    const treeDepthLimit = Number.isInteger(maxTreeDepth) && maxTreeDepth > 0 ? maxTreeDepth : null;
    const doc = this.db.prepare(`
      SELECT
        docs.*,
        (SELECT COUNT(*) FROM nodes WHERE doc_id = docs.id) AS node_count
      FROM docs
      WHERE id = ?
    `).get(docId);
    if (!doc) return null;

    const depthRows = this.db.prepare(`
      SELECT depth, COUNT(*) AS count
      FROM nodes
      WHERE doc_id = ?
      GROUP BY depth
      ORDER BY depth
    `).all(docId);
    const depths = depthRows
      .map((row) => Math.floor(Number(row.depth) || 0))
      .filter((depth) => depth > 0);
    const effectiveMaxDepth = depths.length ? Math.max(...depths) : 1;
    const effectiveDepths = (depths.length ? depths : [1]).filter((depth) => depth <= effectiveMaxDepth);
    const treeDepthStats = {
      maxDepth: effectiveMaxDepth,
      depths: effectiveDepths.length ? effectiveDepths : [1],
      counts: Object.fromEntries(depthRows.map((row) => [
        Math.floor(Number(row.depth) || 0),
        Number(row.count) || 0
      ]).filter(([depth]) => depth > 0 && depth <= effectiveMaxDepth)),
      root: {
        subtreeMaxDepth: null,
        nextDepthNodeCount: null,
        subtreeTextChars: null
      }
    };

    // If the doc has an active edit branch, we need the full node list so the
    // lazy-diff projection can recompute addresses and depths consistently;
    // depth slicing kicks back in after projection.
    // 主文档视图只投影人类自己的编辑分支（owner=human）；外部/内置 agent 的分支
    // （owner=llm:<会话>）是 A5-5 待审/并行分支，经 diff 视图单独看，不混入主视图（沿用 15-4 待审语义）。
    const activeBranch = this.activeEditBranchForBaseDoc(docId, 'human');
    const sliceDepthForQuery = activeBranch ? null : treeDepthLimit;

    let nodes = sliceDepthForQuery
      ? this.db.prepare(`
        WITH visible_nodes AS (
          SELECT *
          FROM nodes
          WHERE doc_id = ? AND depth <= ?
        ),
        child_counts(parent_id, child_count) AS (
          SELECT child.parent_id, COUNT(*)
          FROM nodes child
          JOIN visible_nodes ON child.parent_id = visible_nodes.id
          WHERE child.doc_id = ?
          GROUP BY child.parent_id
        )
        SELECT visible_nodes.*,
          visible_nodes.depth AS tree_depth,
          COALESCE(child_counts.child_count, 0) AS child_count
        FROM visible_nodes
        LEFT JOIN child_counts ON child_counts.parent_id = visible_nodes.id
        ORDER BY visible_nodes.parent_id IS NOT NULL, visible_nodes.parent_id, visible_nodes.sort_order, visible_nodes.id
      `).all(docId, sliceDepthForQuery, docId)
      : this.db.prepare(`
        WITH child_counts(parent_id, child_count) AS (
          SELECT parent_id, COUNT(*)
          FROM nodes
          WHERE doc_id = ? AND parent_id IS NOT NULL
          GROUP BY parent_id
        )
        SELECT nodes.*,
          COALESCE(child_counts.child_count, 0) AS child_count
        FROM nodes
        LEFT JOIN child_counts ON child_counts.parent_id = nodes.id
        WHERE nodes.doc_id = ?
        ORDER BY nodes.parent_id IS NOT NULL, nodes.parent_id, nodes.sort_order, nodes.id
      `).all(docId, docId);
    let axioms = this.listAxioms(docId);
    let refs = this._fetchBaseRefsForDoc(docId);

    if (activeBranch) {
      const diff = JSON.parse(activeBranch.diff || '{}');
      const entries = Array.isArray(diff.entries) ? diff.entries : [];
      if (entries.length > 0) {
        const projected = projectEditBranchDoc({ docId, nodes, axioms, refs }, entries);
        nodes = projected.nodes;
        axioms = projected.axioms;
        refs = projected.refs;
        if (treeDepthLimit) {
          nodes = nodes.filter((node) => (Number(node.depth) || 0) <= treeDepthLimit);
        }
        // Recompute child_count after possible truncation
        const childCountByParent = new Map();
        for (const node of nodes) {
          const key = node.parent_id === null || node.parent_id === undefined ? 'root' : node.parent_id;
          childCountByParent.set(key, (childCountByParent.get(key) || 0) + 1);
        }
        for (const node of nodes) {
          node.child_count = childCountByParent.get(node.id) || 0;
        }
      }
    }

    const tree = buildTree(nodes);
    const addressById = new Map();
    const idByAddress = new Map();

    function indexAddresses(node) {
      if (!node) return;
      addressById.set(node.id, node.address);
      idByAddress.set(node.address, node.id);
      for (const child of node.children || []) indexAddresses(child);
    }
    indexAddresses(tree);

    const axiomById = new Map(axioms.map((axiom) => [String(axiom.id), axiom]));
    refs = refs.map((ref) => ({
        ...ref,
        source_address: ref.source_type === 'node'
          ? addressById.get(ref.source_id) || null
          : ref.source_type === 'axiom'
            ? `前提 ${axiomById.get(String(ref.source_id))?.label || ref.source_id}`
            : null,
        target_address: ref.target_type === 'node' ? addressById.get(ref.target_id) || null : null
      }));

    const history = this.listHistory(docId);
    const sourceDocument = includeSourceDocumentContent
      ? this.db.prepare('SELECT * FROM source_documents WHERE doc_id = ?').get(docId) || null
      : this.db.prepare(`
        SELECT doc_id, source_type, original_path, '' AS raw_markdown, created_at
        FROM source_documents
        WHERE doc_id = ?
      `).get(docId) || null;
    const sourcePdfPages = this.db.prepare(`
      SELECT page_number, width, height
      FROM source_pdf_pages
      WHERE doc_id = ?
      ORDER BY page_number
    `).all(docId);
    const sourceSpans = includeSourceSpans
      ? this.db.prepare(`
        SELECT * FROM source_spans
        WHERE doc_id = ?
        ORDER BY sentence_index, id
      `).all(docId).map((span) => ({
        ...span,
        node_address: span.node_id ? addressById.get(span.node_id) || null : null
      }))
      : [];

    return {
      doc,
      nodes,
      tree,
      axioms,
      refs,
      history,
      sourceDocument,
      sourcePdfPages,
      sourceSpans,
      treeDepthStats,
      idByAddress: Object.fromEntries(idByAddress)
    };
  }

  /** @param {{ docId?: any, depth?: number }} [payload] */
  hasDocTreeDepth({ docId, depth } = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    const targetDepth = Math.max(1, Math.floor(Number(depth) || 1));
    if (!normalizedDocId) {
      return { docId: null, depth: targetDepth, exists: false };
    }
    const row = this.db.prepare(`
      SELECT 1 AS exists_depth
      FROM nodes
      WHERE doc_id = ? AND depth = ?
      LIMIT 1
    `).get(normalizedDocId, targetDepth);
    return {
      docId: normalizedDocId,
      depth: targetDepth,
      exists: Boolean(row)
    };
  }

  /** @param {{ docId?: any }} [payload] */
  getDocStructureRows({ docId } = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    if (normalizedDocId === null) return [];
    return this.db.prepare(`
      WITH child_counts(parent_id, child_count) AS (
        SELECT parent_id, COUNT(*)
        FROM nodes
        WHERE doc_id = ? AND parent_id IS NOT NULL
        GROUP BY parent_id
      )
      SELECT nodes.id,
        nodes.doc_id,
        nodes.parent_id,
        nodes.sort_order,
        nodes.depth,
        nodes.address,
        COALESCE(child_counts.child_count, 0) AS child_count
      FROM nodes
      LEFT JOIN child_counts ON child_counts.parent_id = nodes.id
      WHERE nodes.doc_id = ?
      ORDER BY nodes.parent_id IS NOT NULL, nodes.parent_id, nodes.sort_order, nodes.id
    `).all(normalizedDocId, normalizedDocId);
  }

  /** @param {{ docId?: any, nodeIds?: any[] }} [payload] */
  getNodeTextBatch({ docId, nodeIds = [] } = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    const ids = normalizeNodeIdBatch(nodeIds, 500);
    if (normalizedDocId === null || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.db.prepare(`
      WITH requested_nodes AS (
        SELECT *
        FROM nodes
        WHERE doc_id = ? AND id IN (${placeholders})
      ),
      child_counts(parent_id, child_count) AS (
        SELECT parent_id, COUNT(*)
        FROM nodes
        WHERE doc_id = ? AND parent_id IN (SELECT id FROM requested_nodes)
        GROUP BY parent_id
      )
      SELECT requested_nodes.id,
        requested_nodes.doc_id,
        requested_nodes.parent_id,
        requested_nodes.sort_order,
        requested_nodes.depth,
        requested_nodes.address,
        requested_nodes.node_type,
        requested_nodes.text,
        requested_nodes.node_title,
        requested_nodes.node_note,
        requested_nodes.trust_level,
        requested_nodes.source_position,
        COALESCE(child_counts.child_count, 0) AS child_count,
        requested_nodes.created_at,
        requested_nodes.updated_at
      FROM requested_nodes
      LEFT JOIN child_counts ON child_counts.parent_id = requested_nodes.id
      ORDER BY requested_nodes.id
    `).all(normalizedDocId, ...ids, normalizedDocId);
  }

  /** @param {{ docId?: any, query?: string, limit?: number }} [payload] */
  searchNodes({ docId, query, limit = 20 } = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    const text = String(query || '').trim();
    if (normalizedDocId === null || !text) return [];
    const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
    const escaped = text.replace(/[\\%_]/g, (match) => `\\${match}`);
    const like = `%${escaped}%`;
    return this.db.prepare(`
      WITH matched AS (
        SELECT *
        FROM nodes
        WHERE doc_id = ?
          AND (
            address LIKE ? ESCAPE '\\'
            OR node_title LIKE ? ESCAPE '\\'
            OR text LIKE ? ESCAPE '\\'
            OR node_note LIKE ? ESCAPE '\\'
          )
        ORDER BY
          CASE
            WHEN address = ? THEN 0
            WHEN node_title LIKE ? ESCAPE '\\' THEN 1
            WHEN text LIKE ? ESCAPE '\\' THEN 2
            ELSE 3
          END,
          depth,
          address,
          id
        LIMIT ?
      ),
      child_counts(parent_id, child_count) AS (
        SELECT parent_id, COUNT(*)
        FROM nodes
        WHERE doc_id = ? AND parent_id IN (SELECT id FROM matched)
        GROUP BY parent_id
      )
      SELECT matched.*,
        COALESCE(child_counts.child_count, 0) AS child_count
      FROM matched
      LEFT JOIN child_counts ON child_counts.parent_id = matched.id
      ORDER BY
        CASE
          WHEN matched.address = ? THEN 0
          WHEN matched.node_title LIKE ? ESCAPE '\\' THEN 1
          WHEN matched.text LIKE ? ESCAPE '\\' THEN 2
          ELSE 3
        END,
        matched.depth,
        matched.address,
        matched.id
    `).all(
      normalizedDocId,
      like,
      like,
      like,
      like,
      text,
      like,
      like,
      safeLimit,
      normalizedDocId,
      text,
      like,
      like
    );
  }

  getNodeAddress(docId, nodeId) {
    const stored = this.db.prepare(`
      SELECT address
      FROM nodes
      WHERE doc_id = ? AND id = ?
    `).get(docId, nodeId);
    if (String(stored?.address || '').trim()) return String(stored.address);

    const getNode = this.db.prepare(`
      SELECT id, parent_id, sort_order
      FROM nodes
      WHERE doc_id = ? AND id = ?
    `);
    const getOrdinal = this.db.prepare(`
      SELECT COUNT(*) AS ordinal
      FROM nodes
      WHERE doc_id = ?
        AND parent_id IS ?
        AND (
          sort_order < ?
          OR (sort_order = ? AND id <= ?)
        )
    `);
    const parts = [];
    let currentId = nodeId;
    while (currentId !== null && currentId !== undefined) {
      const node = getNode.get(docId, currentId);
      if (!node) return null;
      const ordinal = Number(getOrdinal.get(
        docId,
        node.parent_id ?? null,
        node.sort_order,
        node.sort_order,
        node.id
      )?.ordinal || 0);
      if (ordinal <= 0) return null;
      parts.push(ordinal);
      currentId = node.parent_id ?? null;
    }
    return parts.reverse().join('-');
  }

  /** @param {{ docId?: any, nodeId?: any }} [payload] */
  getSubtreeSlotRange({ docId, nodeId } = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    const normalizedNodeId = normalizePositiveId(nodeId);
    if (normalizedDocId === null || normalizedNodeId === null) return [];
    const address = this.getNodeAddress(normalizedDocId, normalizedNodeId);
    if (!address) return [];
    const pathKey = addressSortKey(address);
    return this.db.prepare(`
      WITH RECURSIVE subtree(id, doc_id, parent_id, sort_order, depth, address, path_key) AS (
        SELECT id, doc_id, parent_id, sort_order, depth, address, ? AS path_key
        FROM nodes
        WHERE doc_id = ? AND id = ?
        UNION ALL
        SELECT child.id,
          child.doc_id,
          child.parent_id,
          child.sort_order,
          child.depth,
          child.address,
          subtree.path_key || '-' || printf('%010d', (
            SELECT COUNT(*)
            FROM nodes sibling
            WHERE sibling.doc_id = child.doc_id
              AND sibling.parent_id IS child.parent_id
              AND (
                sibling.sort_order < child.sort_order
                OR (sibling.sort_order = child.sort_order AND sibling.id <= child.id)
              )
          ))
        FROM nodes child
        JOIN subtree ON child.parent_id = subtree.id
        WHERE child.doc_id = ?
      ),
      child_counts(parent_id, child_count) AS (
        SELECT parent_id, COUNT(*)
        FROM nodes
        WHERE doc_id = ? AND parent_id IN (SELECT id FROM subtree)
        GROUP BY parent_id
      )
      SELECT subtree.id,
        subtree.doc_id,
        subtree.parent_id,
        subtree.sort_order,
        subtree.depth,
        subtree.address,
        COALESCE(child_counts.child_count, 0) AS child_count
      FROM subtree
      JOIN nodes ON nodes.id = subtree.id AND nodes.doc_id = subtree.doc_id
      LEFT JOIN child_counts ON child_counts.parent_id = subtree.id
      ORDER BY subtree.path_key
    `).all(pathKey, normalizedDocId, normalizedNodeId, normalizedDocId, normalizedDocId);
  }

  /** @param {{ docId?: any, nodeId?: any, offset?: number, limit?: number, charLimit?: number }} [payload] */
  getSubtreeTextWindow({ docId, nodeId, offset = 0, limit = 1000, charLimit = 0 } = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    const normalizedNodeId = normalizePositiveId(nodeId);
    if (normalizedDocId === null || normalizedNodeId === null) {
      return { rows: [], offset: 0, nextOffset: 0, limit: 0, charLimit: 0, textChars: 0, hasMore: false };
    }
    const root = this.db.prepare(`
      SELECT id, address, source_position
      FROM nodes
      WHERE doc_id = ? AND id = ?
    `).get(normalizedDocId, normalizedNodeId);
    const rootAddress = String(root?.address || '').trim();
    if (!root || !rootAddress) {
      return { rows: [], offset: 0, nextOffset: 0, limit: 0, charLimit: 0, textChars: 0, hasMore: false };
    }
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const safeLimit = Math.min(1000, Math.max(1, Math.floor(Number(limit) || 1000)));
    // 0 表示不启用字符预算
    const safeCharLimit = Math.max(0, Math.floor(Number(charLimit) || 0));
    const prefix = `${rootAddress}-%`;
    const orderBySource = Number.isFinite(Number(root.source_position));
    const rows = this.db.prepare(`
      WITH selected_nodes AS (
        SELECT *
        FROM nodes
        WHERE doc_id = ?
          AND (address = ? OR address LIKE ?)
        ORDER BY ${orderBySource
          ? '(id = ?) DESC, source_position IS NULL, source_position, id'
          : '(id = ?) DESC, id'}
        LIMIT ? OFFSET ?
      ),
      child_counts(parent_id, child_count) AS (
        SELECT parent_id, COUNT(*)
        FROM nodes
        WHERE doc_id = ? AND parent_id IN (SELECT id FROM selected_nodes)
        GROUP BY parent_id
      )
      SELECT selected_nodes.id,
        selected_nodes.doc_id,
        selected_nodes.parent_id,
        selected_nodes.sort_order,
        selected_nodes.depth,
        selected_nodes.address,
        selected_nodes.node_type,
        selected_nodes.text,
        selected_nodes.node_title,
        selected_nodes.node_note,
        selected_nodes.trust_level,
        selected_nodes.source_position,
        COALESCE(child_counts.child_count, 0) AS child_count,
        selected_nodes.created_at,
        selected_nodes.updated_at
      FROM selected_nodes
      LEFT JOIN child_counts ON child_counts.parent_id = selected_nodes.id
      ORDER BY ${orderBySource
        ? '(selected_nodes.id = ?) DESC, selected_nodes.source_position IS NULL, selected_nodes.source_position, selected_nodes.id'
        : '(selected_nodes.id = ?) DESC, selected_nodes.id'}
    `).all(normalizedDocId, rootAddress, prefix, normalizedNodeId, safeLimit + 1, safeOffset, normalizedDocId, normalizedNodeId);
    const rowTextChars = (row) => String(row.node_title || '').length + String(row.text || '').length + String(row.node_note || '').length;
    const fetched = rows.slice(0, safeLimit);
    let pageRows = fetched;
    let textChars = 0;
    if (safeCharLimit > 0) {
      // 字符预算：至少返回一行；累计达到预算后截断本页，保证 nextOffset 始终前进
      pageRows = [];
      for (const row of fetched) {
        pageRows.push(row);
        textChars += rowTextChars(row);
        if (textChars >= safeCharLimit) break;
      }
    } else {
      textChars = fetched.reduce((sum, row) => sum + rowTextChars(row), 0);
    }
    return {
      rows: pageRows,
      offset: safeOffset,
      nextOffset: safeOffset + pageRows.length,
      limit: safeLimit,
      charLimit: safeCharLimit,
      textChars,
      hasMore: rows.length > pageRows.length
    };
  }

  /** @param {{ docId?: any, nodeId?: any }} [payload] */
  getAncestorChain({ docId, nodeId } = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    const normalizedNodeId = normalizePositiveId(nodeId);
    if (normalizedDocId === null || normalizedNodeId === null) return [];
    return this.db.prepare(`
      WITH RECURSIVE ancestors(id, doc_id, parent_id, sort_order, depth, address) AS (
        SELECT id, doc_id, parent_id, sort_order, depth, address
        FROM nodes
        WHERE doc_id = ? AND id = ?
        UNION ALL
        SELECT parent.id, parent.doc_id, parent.parent_id, parent.sort_order, parent.depth, parent.address
        FROM nodes parent
        JOIN ancestors child ON child.parent_id = parent.id
        WHERE parent.doc_id = ?
      ),
      child_counts(parent_id, child_count) AS (
        SELECT parent_id, COUNT(*)
        FROM nodes
        WHERE doc_id = ? AND parent_id IN (SELECT id FROM ancestors)
        GROUP BY parent_id
      )
      SELECT ancestors.id,
        ancestors.doc_id,
        ancestors.parent_id,
        ancestors.sort_order,
        ancestors.depth,
        ancestors.address,
        COALESCE(child_counts.child_count, 0) AS child_count
      FROM ancestors
      LEFT JOIN child_counts ON child_counts.parent_id = ancestors.id
      ORDER BY ancestors.depth DESC
    `).all(normalizedDocId, normalizedNodeId, normalizedDocId, normalizedDocId);
  }

  getSubtreeAggregates() {
    return {};
  }

  getNodeChildren({ docId, parentId = null, offset = 0, limit = 300, anchorId = null, before = 0, after = 0 }) {
    const normalizedDocId = normalizePositiveId(docId);
    const normalizedParentId = parentId === null || parentId === undefined ? null : normalizePositiveId(parentId);
    const normalizedAnchorId = anchorId === null || anchorId === undefined ? null : normalizePositiveId(anchorId);
    if (!normalizedDocId) {
      return { rows: [], offset: 0, limit: 0, total: 0, hasMore: false, anchorOffset: null };
    }
    if (parentId !== null && parentId !== undefined && normalizedParentId === null) {
      return { rows: [], offset: 0, limit: 0, total: 0, hasMore: false, anchorOffset: null };
    }
    if (anchorId !== null && anchorId !== undefined && normalizedAnchorId === null) {
      return { rows: [], offset: 0, limit: 0, total: 0, hasMore: false, anchorOffset: null };
    }
    const requestedLimit = Math.min(1000, Math.max(1, Math.floor(Number(limit) || 300)));
    let safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    let safeLimit = requestedLimit;
    let anchorOffset = null;
    const total = Number(this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM nodes
      WHERE doc_id = ? AND parent_id IS ?
    `).get(normalizedDocId, normalizedParentId)?.count || 0);
    if (normalizedAnchorId !== null) {
      const anchor = this.db.prepare(`
        SELECT id, parent_id, sort_order
        FROM nodes
        WHERE doc_id = ? AND id = ?
      `).get(normalizedDocId, normalizedAnchorId);
      const anchorParentId = anchor?.parent_id === null || anchor?.parent_id === undefined ? null : normalizePositiveId(anchor.parent_id);
      if (anchor && sameStableId(anchorParentId, normalizedParentId)) {
        anchorOffset = Number(this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM nodes
          WHERE doc_id = ? AND parent_id IS ?
            AND (sort_order < ? OR (sort_order = ? AND id < ?))
        `).get(
          normalizedDocId,
          normalizedParentId,
          Number(anchor.sort_order) || 0,
          Number(anchor.sort_order) || 0,
          normalizedAnchorId
        )?.count || 0);
        const safeBefore = Math.max(0, Math.floor(Number(before) || 0));
        const safeAfter = Math.max(0, Math.floor(Number(after) || 0));
        safeOffset = Math.max(0, anchorOffset - safeBefore);
        safeLimit = Math.min(1000, Math.max(1, safeBefore + 1 + safeAfter, requestedLimit));
      }
    }
    const rows = this.db.prepare(`
      WITH selected_children AS (
        SELECT *
        FROM nodes
        WHERE doc_id = ? AND parent_id IS ?
        ORDER BY sort_order, id
        LIMIT ? OFFSET ?
      ),
      child_counts(parent_id, child_count) AS (
        SELECT parent_id, COUNT(*)
        FROM nodes
        WHERE doc_id = ? AND parent_id IN (SELECT id FROM selected_children)
        GROUP BY parent_id
      )
      SELECT selected_children.*,
        COALESCE(child_counts.child_count, 0) AS child_count
      FROM selected_children
      LEFT JOIN child_counts ON child_counts.parent_id = selected_children.id
      ORDER BY selected_children.sort_order, selected_children.id
    `).all(normalizedDocId, normalizedParentId, safeLimit, safeOffset, normalizedDocId);
    return {
      rows,
      offset: safeOffset,
      limit: safeLimit,
      anchorId: normalizedAnchorId,
      anchorOffset,
      total,
      hasMore: safeOffset + rows.length < total
    };
  }

  /** @param {{ docId?: any, afterId?: number, limit?: number }} [payload] */
  getDocNodesPage({ docId, afterId = 0, limit = 5000 } = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    if (!normalizedDocId) {
      return { rows: [], afterId: '', nextAfterId: '', limit: 0, hasMore: false };
    }
    const safeAfterId = normalizePositiveId(afterId) || '';
    const safeLimit = Math.min(10000, Math.max(100, Math.floor(Number(limit) || 5000)));
    const rows = this.db.prepare(`
      WITH selected_nodes AS (
        SELECT *
        FROM nodes
        WHERE doc_id = ? AND (? = '' OR id > ?)
        ORDER BY id
        LIMIT ?
      ),
      child_counts(parent_id, child_count) AS (
        SELECT parent_id, COUNT(*)
        FROM nodes
        WHERE doc_id = ? AND parent_id IN (SELECT id FROM selected_nodes)
        GROUP BY parent_id
      )
      SELECT selected_nodes.*,
        COALESCE(child_counts.child_count, 0) AS child_count
      FROM selected_nodes
      LEFT JOIN child_counts ON child_counts.parent_id = selected_nodes.id
      ORDER BY selected_nodes.id
    `).all(normalizedDocId, safeAfterId, safeAfterId, safeLimit + 1, normalizedDocId);
    const pageRows = rows.slice(0, safeLimit);
    const nextAfterId = pageRows.length > 0 ? pageRows[pageRows.length - 1].id : safeAfterId;
    return {
      rows: pageRows,
      afterId: safeAfterId,
      nextAfterId,
      limit: safeLimit,
      hasMore: rows.length > safeLimit
    };
  }

  /** @param {{ docId?: any, nodeId?: any, startOffset?: number | null, limit?: number, before?: number, spansLimit?: number }} [payload] */
  getSourceWindow({ docId, nodeId = null, startOffset = null, limit = 5000, before = null, spansLimit = 8000 } = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    if (!normalizedDocId) return null;

    const source = this.db.prepare(`
      SELECT doc_id, source_type, original_path, created_at, LENGTH(raw_markdown) AS raw_length
      FROM source_documents
      WHERE doc_id = ?
    `).get(normalizedDocId);
    if (!source) return null;

    const totalLength = Math.max(0, Number(source.raw_length) || 0);
    // limit 是总上下文窗口（默认 5000、上限 50000）。往前量未显式给 before 时自动分配：
    // min(⌊limit/5⌋, 1000)——limit≤5000 时前后 1:4，limit>5000 时往前封顶 1000、其余全归往后。
    // 显式给 before 则覆盖自动值（夹到 [0, limit]，用于需要多看上文的场景）。
    const safeLimit = Math.min(50000, Math.max(1, Math.floor(Number(limit) || 5000)));
    const hasExplicitBefore = before !== null && before !== undefined && Number.isFinite(Number(before));
    const safeBefore = hasExplicitBefore
      ? Math.max(0, Math.min(safeLimit, Math.floor(Number(before))))
      : Math.min(1000, Math.floor(safeLimit / 5));
    const safeSpansLimit = Math.min(20000, Math.max(100, Math.floor(Number(spansLimit) || 8000)));
    let anchor = Number(startOffset);
    const hasExplicitStartOffset = Number.isFinite(anchor);

    const normalizedNodeId = nodeId === null || nodeId === undefined ? null : normalizePositiveId(nodeId);
    if (!hasExplicitStartOffset && normalizedNodeId) {
      const directSpan = this.db.prepare(`
        SELECT MIN(start_offset) AS start_offset
        FROM source_spans
        WHERE doc_id = ? AND node_id = ?
      `).get(normalizedDocId, normalizedNodeId);
      if (directSpan?.start_offset !== null && directSpan?.start_offset !== undefined && Number.isFinite(Number(directSpan.start_offset))) {
        anchor = Number(directSpan.start_offset);
      } else {
        const node = this.db.prepare('SELECT source_position FROM nodes WHERE doc_id = ? AND id = ?')
          .get(normalizedDocId, normalizedNodeId);
        const sourcePosition = Math.floor(Number(node?.source_position));
        if (Number.isInteger(sourcePosition)) {
          const nearSpan = this.db.prepare(`
            SELECT start_offset
            FROM source_spans
            WHERE doc_id = ? AND sentence_index >= ?
            ORDER BY sentence_index, id
            LIMIT 1
          `).get(normalizedDocId, sourcePosition);
          if (nearSpan?.start_offset !== null && nearSpan?.start_offset !== undefined && Number.isFinite(Number(nearSpan.start_offset))) {
            anchor = Number(nearSpan.start_offset);
          }
        }
      }
    }

    if (!Number.isFinite(anchor)) anchor = 0;
    anchor = Math.min(totalLength, Math.max(0, Math.floor(anchor)));
    // 往前最多 safeBefore；撞文档头时往前用不满的额度并入往后、凑满 limit；
    // 撞文档尾时往后到底为止、往前不补（总窗口可能不足 limit）。
    const windowStart = Math.max(0, anchor - safeBefore);
    const actualBefore = anchor - windowStart;
    const windowEnd = Math.min(totalLength, anchor + (safeLimit - actualBefore));
    const rawMarkdown = windowEnd > windowStart
      ? this.db.prepare('SELECT substr(raw_markdown, ?, ?) AS text FROM source_documents WHERE doc_id = ?')
        .get(windowStart + 1, windowEnd - windowStart, normalizedDocId)?.text || ''
      : '';

    const sourceSpans = this.db.prepare(`
      SELECT *
      FROM source_spans
      WHERE doc_id = ? AND end_offset > ? AND start_offset < ?
      ORDER BY sentence_index, id
      LIMIT ?
    `).all(normalizedDocId, windowStart, windowEnd, safeSpansLimit).map((span) => ({
      ...span,
      absolute_start_offset: span.start_offset,
      absolute_end_offset: span.end_offset,
      start_offset: Math.max(0, Number(span.start_offset) - windowStart),
      end_offset: Math.min(windowEnd - windowStart, Number(span.end_offset) - windowStart)
    }));

    return {
      docId: normalizedDocId,
      anchorNodeId: normalizedNodeId,
      startOffset: windowStart,
      endOffset: windowEnd,
      totalLength,
      hasBefore: windowStart > 0,
      hasAfter: windowEnd < totalLength,
      raw_markdown: rawMarkdown,
      sourceDocument: {
        doc_id: source.doc_id,
        source_type: source.source_type,
        original_path: source.original_path,
        raw_markdown: '',
        created_at: source.created_at
      },
      sourceSpans
    };
  }

  saveSourceDocument({
    docId,
    sourcePath = null,
    sourceType = 'md',
    rawMarkdown = '',
    spans = [],
    pdfPages = [],
    pdfChars = [],
    docBlocks = [],
    nodeIdsBySentenceIndex = null
  }) {
    const doc = this.db.prepare('SELECT id FROM docs WHERE id = ?').get(docId);
    if (!doc) throw new Error(`Document not found: ${docId}`);

    const nodeIdForSentence = (sentenceIndex) => {
      const numericIndex = Number(sentenceIndex);
      if (!nodeIdsBySentenceIndex) return null;
      if (nodeIdsBySentenceIndex instanceof Map) {
        return nodeIdsBySentenceIndex.get(numericIndex) ?? nodeIdsBySentenceIndex.get(String(numericIndex)) ?? null;
      }
      if (Array.isArray(nodeIdsBySentenceIndex)) return nodeIdsBySentenceIndex[numericIndex - 1] ?? null;
      return nodeIdsBySentenceIndex[numericIndex] ?? nodeIdsBySentenceIndex[String(numericIndex)] ?? null;
    };

    return this.withTransaction(() => {
      this.db.prepare('DELETE FROM source_spans WHERE doc_id = ?').run(docId);
      this.db.prepare('DELETE FROM source_pdf_chars WHERE doc_id = ?').run(docId);
      this.db.prepare('DELETE FROM source_pdf_pages WHERE doc_id = ?').run(docId);
      this.db.prepare('DELETE FROM source_doc_blocks WHERE doc_id = ?').run(docId);
      this.db.prepare('DELETE FROM source_documents WHERE doc_id = ?').run(docId);
      this.db.prepare(`
        INSERT INTO source_documents (doc_id, source_type, original_path, raw_markdown)
        VALUES (?, ?, ?, ?)
      `).run(docId, sourceType || 'md', sourcePath, rawMarkdown || '');

      const insertSpan = this.db.prepare(`
        INSERT INTO source_spans (doc_id, node_id, sentence_index, start_offset, end_offset, text)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const span of spans || []) {
        const sentenceIndex = Number(span.sentence_index ?? span.sentenceIndex ?? span.index);
        if (!Number.isFinite(sentenceIndex) || sentenceIndex <= 0) continue;
        const startOffset = Number(span.start_offset ?? span.startOffset);
        const endOffset = Number(span.end_offset ?? span.endOffset);
        if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset) || endOffset < startOffset) continue;
        insertSpan.run(
          docId,
          nodeIdForSentence(sentenceIndex),
          sentenceIndex,
          startOffset,
          endOffset,
          span.text || ''
        );
      }

      const insertPdfPage = this.db.prepare(`
        INSERT INTO source_pdf_pages (doc_id, page_number, width, height)
        VALUES (?, ?, ?, ?)
      `);
      for (const page of pdfPages || []) {
        const pageNumber = Number(page.page_number ?? page.pageNumber);
        const width = Number(page.width);
        const height = Number(page.height);
        if (!Number.isFinite(pageNumber) || !Number.isFinite(width) || !Number.isFinite(height)) continue;
        insertPdfPage.run(docId, pageNumber, width, height);
      }

      const insertPdfChar = this.db.prepare(`
        INSERT INTO source_pdf_chars (doc_id, char_offset, page_number, x0, y0, x1, y1, char_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of pdfChars || []) {
        const charOffset = Number(item.char_offset ?? item.charOffset);
        const pageNumber = Number(item.page_number ?? item.pageNumber);
        const x0 = Number(item.x0);
        const y0 = Number(item.y0);
        const x1 = Number(item.x1);
        const y1 = Number(item.y1);
        if (
          !Number.isFinite(charOffset) ||
          !Number.isFinite(pageNumber) ||
          !Number.isFinite(x0) ||
          !Number.isFinite(y0) ||
          !Number.isFinite(x1) ||
          !Number.isFinite(y1)
        ) continue;
        insertPdfChar.run(docId, charOffset, pageNumber, x0, y0, x1, y1, item.char_text ?? item.charText ?? '');
      }

      const insertDocBlock = this.db.prepare(`
        INSERT INTO source_doc_blocks (doc_id, block_index, start_offset, end_offset)
        VALUES (?, ?, ?, ?)
      `);
      for (const block of docBlocks || []) {
        const blockIndex = Number(block.block_index ?? block.blockIndex);
        const startOffset = Number(block.start_offset ?? block.startOffset);
        const endOffset = Number(block.end_offset ?? block.endOffset);
        if (!Number.isFinite(blockIndex) || !Number.isFinite(startOffset) || !Number.isFinite(endOffset) || endOffset < startOffset) continue;
        insertDocBlock.run(docId, blockIndex, startOffset, endOffset);
      }

      this.touchDoc(docId);
      return this.db.prepare('SELECT * FROM source_documents WHERE doc_id = ?').get(docId);
    });
  }

  updateSourceBinding({ docId, sourcePath, sourceType = 'file', rawMarkdown = '' }) {
    const normalizedDocId = normalizePositiveId(docId);
    const pathText = String(sourcePath || '').trim();
    if (!normalizedDocId || !pathText) throw new Error('Source binding requires docId and sourcePath');
    return this.withTransaction(() => {
      const doc = this.db.prepare('SELECT id, meta FROM docs WHERE id = ?').get(normalizedDocId);
      if (!doc) throw new Error(`Document not found: ${normalizedDocId}`);
      const meta = parseJsonObject(doc.meta);
      this.db.prepare('UPDATE docs SET meta = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(JSON.stringify({ ...meta, sourcePath: pathText }), normalizedDocId);
      const existing = this.db.prepare('SELECT doc_id FROM source_documents WHERE doc_id = ?').get(normalizedDocId);
      if (existing) {
        this.db.prepare('UPDATE source_documents SET source_type = ?, original_path = ? WHERE doc_id = ?')
          .run(sourceType || 'file', pathText, normalizedDocId);
      } else {
        this.db.prepare(`
          INSERT INTO source_documents (doc_id, source_type, original_path, raw_markdown)
          VALUES (?, ?, ?, ?)
        `).run(normalizedDocId, sourceType || 'file', pathText, rawMarkdown || '');
      }
      return this.db.prepare('SELECT * FROM source_documents WHERE doc_id = ?').get(normalizedDocId);
    });
  }

  // PDF 高亮屏幕几何实现见 ./pdf-highlight-geometry.mjs；此处保留 store 门面方法，注入 db 句柄。
  getPdfHighlightRects(docId, ranges) {
    return pdfHighlightRects(this.db, docId, ranges);
  }

  getPdfSpanHitRects(docId) {
    return pdfSpanHitRects(this.db, docId);
  }

  insertNode({ docId, parentId, text = '', nodeType = 'TEXT', nodeTitle = '', nodeNote = '', sourcePosition = null, trustLevel = null, afterNodeId = null }) {
    const siblings = this.db.prepare(`
      SELECT id, sort_order FROM nodes
      WHERE doc_id = ? AND parent_id IS ?
      ORDER BY sort_order, id
    `).all(docId, parentId);

    let insertOrder = siblings.length + 1;
    if (afterNodeId !== null) {
      const index = siblings.findIndex((node) => node.id === afterNodeId);
      if (index >= 0) insertOrder = siblings[index].sort_order + 1;
    }

    this.db.prepare(`
      UPDATE nodes
      SET sort_order = sort_order + 1
      WHERE doc_id = ? AND parent_id IS ? AND sort_order >= ?
    `).run(docId, parentId, insertOrder);

    const nodeId = newStableId();
    const normalizedNodeType = normalizeNodeType(nodeType);
    this.db.prepare(`
      INSERT INTO nodes (id, doc_id, parent_id, sort_order, node_type, text, node_title, node_note, source_position, trust_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(nodeId, docId, parentId, insertOrder, normalizedNodeType, text, nodeTitle || '', nodeNote || '', normalizeSourcePosition(sourcePosition), normalizeNullableText(trustLevel));

    this.refreshAddressScopes(docId, [parentId]);
    this.touchDoc(docId);
    return this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
  }

  updateNode(nodeId, patch) {
    assertNoHumanTagField(patch, 'updateNode patch');
    const current = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    if (!current) throw new Error(`Node not found: ${nodeId}`);

    const next = {
      text: patch.text ?? current.text,
      node_title: patch.node_title ?? patch.nodeTitle ?? current.node_title,
      node_note: patch.node_note ?? patch.nodeNote ?? current.node_note,
      source_position: patchValue(patch, 'source_position', 'sourcePosition', current.source_position),
      node_type: normalizeNodeType(patchValue(patch, 'node_type', 'nodeType', current.node_type)),
      trust_level: normalizeNullableText(patchValue(patch, 'trust_level', 'trustLevel', current.trust_level))
    };

    this.db.prepare(`
      UPDATE nodes
      SET text = ?, node_title = ?, node_note = ?, source_position = ?, node_type = ?, trust_level = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      next.text,
      next.node_title || '',
      next.node_note || '',
      normalizeSourcePosition(next.source_position),
      next.node_type,
      next.trust_level,
      nodeId
    );

    this.touchDoc(current.doc_id);
    return this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
  }

  deleteNodeSubtree(nodeId) {
    const node = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    if (!node) return false;
    if (node.parent_id === null) throw new Error('Cannot delete document root node');

    this.withTransaction(() => {
      // 节点被摧毁 → 指向子树内任何节点的引用连带蒸发（refs 无外键，需手工清）。
      this.db.prepare(`
        WITH RECURSIVE subtree(id) AS (
          SELECT id FROM nodes WHERE id = ?
          UNION ALL
          SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
        )
        DELETE FROM refs
        WHERE (source_type = 'node' AND source_id IN (SELECT id FROM subtree))
           OR (target_type = 'node' AND target_id IN (SELECT id FROM subtree))
      `).run(nodeId);
      this.db.prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
      this.normalizeSiblingOrder(node.doc_id, node.parent_id);
      this.refreshAddressScopes(node.doc_id, [node.parent_id]);
      this.touchDoc(node.doc_id);
    });
    return true;
  }

  moveNode(nodeId, direction) {
    const node = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    if (!node || node.parent_id === null) return false;

    const comparator = direction === 'up' ? '<' : '>';
    const order = direction === 'up' ? 'DESC' : 'ASC';
    const sibling = this.db.prepare(`
      SELECT * FROM nodes
      WHERE doc_id = ? AND parent_id IS ? AND sort_order ${comparator} ?
      ORDER BY sort_order ${order}
      LIMIT 1
    `).get(node.doc_id, node.parent_id, node.sort_order);

    if (!sibling) return false;

    this.withTransaction(() => {
      this.db.prepare('UPDATE nodes SET sort_order = ? WHERE id = ?').run(sibling.sort_order, node.id);
      this.db.prepare('UPDATE nodes SET sort_order = ? WHERE id = ?').run(node.sort_order, sibling.id);
      this.refreshAddressScopes(node.doc_id, [node.parent_id]);
      this.touchDoc(node.doc_id);
    });
    return true;
  }

  splitNodeIntoChildren(nodeId, options = {}) {
    const node = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    if (this.splitSourceParagraphsIntoSentenceChildren(node)) return true;

    const sentences = splitSentences(node.text, {
      splitAsciiPunctuation: options.splitAsciiPunctuation === true || options.split_ascii_punctuation === true
    });
    if (sentences.length < 2) return false;

    this.withTransaction(() => {
      this.db.prepare('UPDATE nodes SET text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(sentences[0], nodeId);

      this.db.prepare(`
        UPDATE nodes
        SET sort_order = sort_order + ?
        WHERE doc_id = ? AND parent_id IS ? AND sort_order >= 1
      `).run(sentences.length - 1, node.doc_id, nodeId);

      const insert = this.db.prepare(`
        INSERT INTO nodes (id, doc_id, parent_id, sort_order, node_type, text)
        VALUES (?, ?, ?, ?, 'TEXT', ?)
      `);
      sentences.slice(1).forEach((sentence, index) => {
        insert.run(newStableId(), node.doc_id, nodeId, index + 1, sentence);
      });

      this.normalizeSiblingOrder(node.doc_id, nodeId);
      this.refreshAddressScopes(node.doc_id, [nodeId]);
      this.touchDoc(node.doc_id);
    });

    return true;
  }

  splitSourceParagraphsIntoSentenceChildren(rootNode) {
    const candidates = this.db.prepare(`
      WITH RECURSIVE subtree(id) AS (
        SELECT id FROM nodes WHERE id = ?
        UNION ALL
        SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
      )
      SELECT n.*
      FROM nodes n
      JOIN subtree s ON n.id = s.id
      WHERE n.source_position IS NOT NULL
        AND ABS(n.source_position - CAST(n.source_position AS INTEGER)) > 0.000001
      ORDER BY n.id
    `).all(rootNode.id);
    if (candidates.length === 0) return false;

    const spansForNode = this.db.prepare(`
      SELECT *
      FROM source_spans
      WHERE node_id = ?
      ORDER BY sentence_index, id
    `);
    const childCount = this.db.prepare('SELECT COUNT(*) AS count FROM nodes WHERE parent_id = ?');
    const targetRows = [];
    for (const candidate of candidates) {
      if (childCount.get(candidate.id)?.count > 0) continue;
      const spans = spansForNode.all(candidate.id);
      if (spans.length > 0) targetRows.push({ node: candidate, spans });
    }
    if (targetRows.length === 0) return false;

    this.withTransaction(() => {
      const clearParagraph = this.db.prepare('UPDATE nodes SET text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      const insert = this.db.prepare(`
        INSERT INTO nodes (id, doc_id, parent_id, sort_order, node_type, text, source_position)
        VALUES (?, ?, ?, ?, 'TEXT', ?, ?)
      `);
      const updateSpan = this.db.prepare('UPDATE source_spans SET node_id = ? WHERE id = ?');

      for (const target of targetRows) {
        clearParagraph.run('', target.node.id);
        for (const [index, span] of target.spans.entries()) {
          const nodeId = newStableId();
          insert.run(
            nodeId,
            target.node.doc_id,
            target.node.id,
            index + 1,
            span.text || '',
            normalizeSourcePosition(span.sentence_index)
          );
          updateSpan.run(nodeId, span.id);
        }
        this.normalizeSiblingOrder(target.node.doc_id, target.node.id);
      }
      this.refreshAddressScopes(rootNode.doc_id, targetRows.map((target) => target.node.id));
      this.touchDoc(rootNode.doc_id);
    });

    return true;
  }

  mergeNodeIntoPreviousSibling(nodeId) {
    const node = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    if (!node || node.parent_id === null) return false;

    const previous = this.db.prepare(`
      SELECT * FROM nodes
      WHERE doc_id = ? AND parent_id IS ? AND sort_order < ?
      ORDER BY sort_order DESC, id DESC
      LIMIT 1
    `).get(node.doc_id, node.parent_id, node.sort_order);

    if (!previous) return false;

    this.withTransaction(() => {
      const mergedText = [previous.text, node.text]
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join('\n\n');
      const mergedTitle = mergeNodeNotes(previous.node_title, node.node_title);
      const mergedNote = mergeNodeNotes(previous.node_note, node.node_note);

      this.db.prepare('UPDATE nodes SET text = ?, node_title = ?, node_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(mergedText, mergedTitle, mergedNote, previous.id);

      const previousChildCount = Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM nodes WHERE doc_id = ? AND parent_id IS ?
      `).get(node.doc_id, previous.id).count);

      const movingChildren = this.db.prepare(`
        SELECT id FROM nodes
        WHERE doc_id = ? AND parent_id IS ?
        ORDER BY sort_order, id
      `).all(node.doc_id, node.id);

      movingChildren.forEach((child, index) => {
        this.db.prepare('UPDATE nodes SET parent_id = ?, sort_order = ? WHERE id = ?')
          .run(previous.id, previousChildCount + index + 1, child.id);
      });

      this.db.prepare('UPDATE source_spans SET node_id = ? WHERE node_id = ?').run(previous.id, node.id);
      // 被合并节点被摧毁 → 指向它的引用连带蒸发（孩子已搬走、其引用不动）。
      this.db.prepare(`
        DELETE FROM refs
        WHERE (source_type = 'node' AND source_id = ?)
           OR (target_type = 'node' AND target_id = ?)
      `).run(node.id, node.id);
      this.db.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
      this.normalizeSiblingOrder(node.doc_id, node.parent_id);
      this.normalizeSiblingOrder(node.doc_id, previous.id);
      this.refreshAddressScopes(node.doc_id, [node.parent_id, previous.id]);
      this.touchDoc(node.doc_id);
    });

    return true;
  }

  mergeNodeIntoTarget({ nodeId, targetNodeId }) {
    const node = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    const target = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(targetNodeId);
    if (!node || !target) return false;
    if (node.parent_id === null) return false;
    if (node.id === target.id) return false;
    if (node.doc_id !== target.doc_id) return false;
    if (this.isDescendant(target.id, node.id)) return false;

    this.withTransaction(() => {
      const mergedText = [target.text, node.text]
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join('\n\n');
      const mergedTitle = mergeNodeNotes(target.node_title, node.node_title);
      const mergedNote = mergeNodeNotes(target.node_note, node.node_note);

      this.db.prepare('UPDATE nodes SET text = ?, node_title = ?, node_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(mergedText, mergedTitle, mergedNote, target.id);

      const targetChildCount = Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM nodes WHERE doc_id = ? AND parent_id IS ?
      `).get(node.doc_id, target.id).count);

      const movingChildren = this.db.prepare(`
        SELECT id FROM nodes
        WHERE doc_id = ? AND parent_id IS ?
        ORDER BY sort_order, id
      `).all(node.doc_id, node.id);

      movingChildren.forEach((child, index) => {
        this.db.prepare('UPDATE nodes SET parent_id = ?, sort_order = ? WHERE id = ?')
          .run(target.id, targetChildCount + index + 1, child.id);
      });

      const oldParentId = node.parent_id;
      this.db.prepare('UPDATE source_spans SET node_id = ? WHERE node_id = ?').run(target.id, node.id);
      // 被合并节点被摧毁 → 指向它的引用连带蒸发（孩子已搬走、其引用不动）。
      this.db.prepare(`
        DELETE FROM refs
        WHERE (source_type = 'node' AND source_id = ?)
           OR (target_type = 'node' AND target_id = ?)
      `).run(node.id, node.id);
      this.db.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
      this.normalizeSiblingOrder(node.doc_id, oldParentId);
      this.normalizeSiblingOrder(node.doc_id, target.id);
      this.refreshAddressScopes(node.doc_id, [oldParentId, target.id]);
      this.touchDoc(node.doc_id);
    });

    return true;
  }

  promoteNode(nodeId) {
    const node = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    if (!node || node.parent_id === null) return false;

    const parent = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(node.parent_id);
    if (!parent || parent.parent_id === null) return false;

    this.withTransaction(() => {
      this.db.prepare(`
        UPDATE nodes
        SET sort_order = sort_order + 1
        WHERE doc_id = ? AND parent_id IS ? AND sort_order > ?
      `).run(node.doc_id, parent.parent_id, parent.sort_order);

      this.db.prepare('UPDATE nodes SET parent_id = ?, sort_order = ? WHERE id = ?')
        .run(parent.parent_id, parent.sort_order + 1, node.id);

      this.normalizeSiblingOrder(node.doc_id, parent.id);
      this.normalizeSiblingOrder(node.doc_id, parent.parent_id);
      this.refreshAddressScopes(node.doc_id, [parent.id, parent.parent_id]);
      this.touchDoc(node.doc_id);
    });

    return true;
  }

  moveNodeToParent({ nodeId, newParentId }) {
    const node = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    const newParent = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(newParentId);
    if (!node || !newParent) return false;
    if (node.parent_id === null) return false;
    if (node.id === newParent.id) return false;
    if (node.doc_id !== newParent.doc_id) return false;
    if (this.isDescendant(newParent.id, node.id)) return false;

    const newOrder = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM nodes WHERE doc_id = ? AND parent_id IS ?
    `).get(node.doc_id, newParent.id).count) + 1;

    this.withTransaction(() => {
      const oldParentId = node.parent_id;
      this.db.prepare('UPDATE nodes SET parent_id = ?, sort_order = ? WHERE id = ?')
        .run(newParent.id, newOrder, node.id);
      this.normalizeSiblingOrder(node.doc_id, oldParentId);
      this.normalizeSiblingOrder(node.doc_id, newParent.id);
      this.refreshAddressScopes(node.doc_id, [oldParentId, newParent.id]);
      this.touchDoc(node.doc_id);
    });

    return true;
  }

  moveNodeAfterSibling({ nodeId, targetNodeId }) {
    const node = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    const target = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(targetNodeId);
    if (!node || !target) return false;
    if (node.parent_id === null || target.parent_id === null) return false;
    if (node.id === target.id) return false;
    if (node.doc_id !== target.doc_id) return false;
    if (this.isDescendant(target.parent_id, node.id)) return false;

    this.withTransaction(() => {
      const targetSiblings = this.db.prepare(`
        SELECT id FROM nodes
        WHERE doc_id = ? AND parent_id IS ? AND id != ?
        ORDER BY sort_order, id
      `).all(node.doc_id, target.parent_id, node.id).map((item) => item.id);

      const targetIndex = targetSiblings.indexOf(target.id);
      targetSiblings.splice(targetIndex + 1, 0, node.id);

      this.db.prepare('UPDATE nodes SET parent_id = ? WHERE id = ?').run(target.parent_id, node.id);
      this.setSiblingOrder(node.doc_id, target.parent_id, targetSiblings);
      if (node.parent_id !== target.parent_id) this.normalizeSiblingOrder(node.doc_id, node.parent_id);
      this.refreshAddressScopes(node.doc_id, [node.parent_id, target.parent_id]);
      this.touchDoc(node.doc_id);
    });

    return true;
  }

  moveNodeBeforeSibling({ nodeId, targetNodeId }) {
    const node = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    const target = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(targetNodeId);
    if (!node || !target) return false;
    if (node.parent_id === null || target.parent_id === null) return false;
    if (node.id === target.id) return false;
    if (node.doc_id !== target.doc_id) return false;
    if (this.isDescendant(target.parent_id, node.id)) return false;

    this.withTransaction(() => {
      const targetSiblings = this.db.prepare(`
        SELECT id FROM nodes
        WHERE doc_id = ? AND parent_id IS ? AND id != ?
        ORDER BY sort_order, id
      `).all(node.doc_id, target.parent_id, node.id).map((item) => item.id);

      const targetIndex = targetSiblings.indexOf(target.id);
      if (targetIndex < 0) return;
      targetSiblings.splice(targetIndex, 0, node.id);

      const oldParentId = node.parent_id;
      this.db.prepare('UPDATE nodes SET parent_id = ? WHERE id = ?').run(target.parent_id, node.id);
      this.setSiblingOrder(node.doc_id, target.parent_id, targetSiblings);
      if (oldParentId !== target.parent_id) this.normalizeSiblingOrder(node.doc_id, oldParentId);
      this.refreshAddressScopes(node.doc_id, [oldParentId, target.parent_id]);
      this.touchDoc(node.doc_id);
    });

    return true;
  }

  isDescendant(candidateId, ancestorId) {
    let current = this.db.prepare('SELECT parent_id FROM nodes WHERE id = ?').get(candidateId);
    while (current?.parent_id !== null && current?.parent_id !== undefined) {
      if (current.parent_id === ancestorId) return true;
      current = this.db.prepare('SELECT parent_id FROM nodes WHERE id = ?').get(current.parent_id);
    }
    return false;
  }

  addAxiomRefToNode({ docId, nodeId, axiomId, note = null }) {
    const target = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    if (!target) throw new Error(`Target node not found: ${nodeId}`);
    const axiom = this.db.prepare('SELECT * FROM axioms WHERE id = ?').get(axiomId);
    if (!axiom) throw new Error(`Axiom not found: ${axiomId}`);
    if (!sameStableId(target.doc_id, docId) || !sameStableId(axiom.doc_id, docId)) {
      throw new Error('Axiom and node must belong to the same document');
    }
    if (target.parent_id === null || target.parent_id === undefined) {
      throw new Error('根节点天然引用全部事实前提，无需添加引用。');
    }

    const existing = this.db.prepare(`
      SELECT * FROM refs
      WHERE source_type = 'axiom'
        AND source_id = ?
        AND target_type = 'node'
        AND target_id = ?
        AND ref_kind = '事实前提'
      LIMIT 1
    `).get(axiomId, nodeId);
    if (existing) return existing;

    const refId = newStableId();
    this.db.prepare(`
      INSERT INTO refs (id, source_type, source_id, target_type, target_id, ref_kind, note)
      VALUES (?, 'axiom', ?, 'node', ?, '事实前提', ?)
    `).run(refId, axiomId, nodeId, normalizeNullableText(note));

    this.touchDoc(docId);
    return this.db.prepare('SELECT * FROM refs WHERE id = ?').get(refId);
  }

  addNodeRefToNode({ docId, sourceNodeId, targetNodeId, refKind, note = null }) {
    const kind = normalizeNullableText(refKind);
    if (!kind) throw new Error('ref.addNodeToNode requires refKind');
    const source = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(sourceNodeId);
    if (!source) throw new Error(`Source node not found: ${sourceNodeId}`);
    const target = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(targetNodeId);
    if (!target) throw new Error(`Target node not found: ${targetNodeId}`);
    if (!sameStableId(source.doc_id, docId) || !sameStableId(target.doc_id, docId)) {
      throw new Error('Source node and target node must belong to the same document');
    }
    const existing = this.db.prepare(`
      SELECT * FROM refs
      WHERE source_type = 'node'
        AND source_id = ?
        AND target_type = 'node'
        AND target_id = ?
        AND ref_kind = ?
      LIMIT 1
    `).get(sourceNodeId, targetNodeId, kind);
    if (existing) return existing;

    const refId = newStableId();
    this.db.prepare(`
      INSERT INTO refs (id, source_type, source_id, target_type, target_id, ref_kind, note)
      VALUES (?, 'node', ?, 'node', ?, ?, ?)
    `).run(refId, sourceNodeId, targetNodeId, kind, normalizeNullableText(note));

    this.touchDoc(docId);
    return this.db.prepare('SELECT * FROM refs WHERE id = ?').get(refId);
  }

  deleteRef(refId) {
    const ref = this.db.prepare('SELECT * FROM refs WHERE id = ?').get(refId);
    if (!ref) return false;

    let docId = null;
    if (ref.source_type === 'node') {
      docId = this.db.prepare('SELECT doc_id FROM nodes WHERE id = ?').get(ref.source_id)?.doc_id ?? null;
    }
    if (docId === null && ref.target_type === 'node') {
      docId = this.db.prepare('SELECT doc_id FROM nodes WHERE id = ?').get(ref.target_id)?.doc_id ?? null;
    }

    this.db.prepare('DELETE FROM refs WHERE id = ?').run(refId);
    if (docId !== null) this.touchDoc(docId);
    return true;
  }

  exportDocMarkdown(docId) {
    const normalizedDocId = requireStableId(docId, 'export docId');
    const doc = this.db.prepare('SELECT * FROM docs WHERE id = ?').get(normalizedDocId);
    if (!doc) throw new Error(`Document not found: ${normalizedDocId}`);
    const rows = this.db.prepare(`
      SELECT *
      FROM nodes
      WHERE doc_id = ?
      ORDER BY depth, address, sort_order, id
    `).all(normalizedDocId).sort(compareNodeAddress);
    // 渲染下沉 core/markdown-export.mjs（与导入侧 core/tree.mjs 对称）；store 只负责查库 + 地址排序。
    return renderDocMarkdown(doc, rows);
  }

  // 历史读：列文档历史 / 节点级历史。祖先链查询与子树成员辅助是 history 模块内部实现、门面不暴露。
  listHistory(docId) {
    return history.listHistory(this, docId);
  }

  nodeHistory(docId, address, options) {
    return history.nodeHistory(this, docId, address, options);
  }

  // commit 写入（第 4 步内容寻址）：快照拆进对象库——节点树走 writeTree（blob/tree 按 hash 去重）、
  // raw_markdown 走 writeSource（source 对象去重）；doc/axioms/refs 这三块小且重复率低的内联进 meta 列。
  // entries（edit-branch 提交的 operation 级条目）也内联进 meta：它是快照重建不出的操作序列，
  //   cherry-pick 重放、单 ref history.diff 展示都要它；体积按改动数（O(改动) 非 O(文档)）。
  // 不再存整篇 snapshot + 冗余 field-diff（新行那两列留空默认值，迁移脚本最终删列）。
  /** @param {{ docId?: any, summary?: any, snapshot?: any, entries?: any, committedAt?: any, author?: any }} arg */
  createCommit({ docId, summary = null, snapshot = {}, entries = null, committedAt = null, author = null }) {
    const normalizedDocId = requireStableId(docId, 'commit docId');
    const head = this.db.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?').get(normalizedDocId);
    const commitId = newStableId();

    const tree = writeCommitTree(this.db, snapshot.nodes || []);
    const sourceHash = writeSource(this.db, snapshot.sourceDocument?.raw_markdown);
    const meta = buildCommitMeta(snapshot, entries);

    this.db.prepare(`
      INSERT INTO commits (id, doc_id, parent_commit_id, committed_at, summary, author, root_node_id, root_tree_hash, source_hash, meta)
      VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?, ?, ?)
    `).run(
      commitId,
      normalizedDocId,
      head?.head_commit_id || null,
      committedAt,
      summary,
      author || null,
      tree?.root_node_id || null,
      tree?.root_tree_hash || null,
      sourceHash,
      JSON.stringify(meta)
    );
    this.db.prepare(`
      INSERT INTO doc_heads (doc_id, head_commit_id, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(doc_id) DO UPDATE SET
        head_commit_id = excluded.head_commit_id,
        updated_at = CURRENT_TIMESTAMP
    `).run(normalizedDocId, commitId);
    return this.db.prepare('SELECT * FROM commits WHERE id = ?').get(commitId);
  }

  // 从 commit 行重建完整快照 {doc, nodes, axioms, refs, sourceDocument}（所有读历史路径的唯一重建口）。
  // 节点树 + raw_markdown 从对象库展开（materializeTree 顺带算 address/depth）、doc/axioms/refs 从内联 meta 取。
  // 未迁移旧行（无 root_tree_hash 但有 snapshot/diff 列）回退读旧形态——迁移删列后该兜底自动失效。
  commitSnapshotFromRow(row) {
    if (!row) return null;
    if (!row.root_tree_hash) {
      const legacy = this._legacyCommitSnapshot(row);
      return legacy?.nodes ? legacy : null;
    }
    const nodes = materializeTree(this.db, row.root_tree_hash, row.root_node_id);
    const meta = parseJsonObject(row.meta) || {};
    const sourceMeta = meta.sourceDocument || null;
    const rawMarkdown = readSource(this.db, row.source_hash);
    return {
      doc: meta.doc ?? null,
      nodes,
      axioms: Array.isArray(meta.axioms) ? meta.axioms : [],
      refs: Array.isArray(meta.refs) ? meta.refs : [],
      sourceDocument: sourceMeta
        ? { ...sourceMeta, raw_markdown: rawMarkdown }
        : (row.source_hash ? { raw_markdown: rawMarkdown } : null)
    };
  }

  _legacyCommitSnapshot(row) {
    try {
      const snap = JSON.parse(row.snapshot || 'null');
      if (snap?.nodes) return snap;
    } catch { /* fall through */ }
    try {
      const diff = JSON.parse(row.diff || '{}');
      const snap = diff.snapshot || (diff.kind === 'snapshot' ? diff : null);
      if (snap?.nodes) return snap;
    } catch { /* ignore */ }
    return null;
  }

  commitSnapshot(commitId) {
    const row = this.db.prepare('SELECT * FROM commits WHERE id = ?').get(commitId);
    return this.commitSnapshotFromRow(row);
  }

  gcHistoryObjects() {
    return history.gcHistoryObjects(this);
  }

  saveHistorySnapshot(args) {
    return history.saveHistorySnapshot(this, args);
  }

  /** @param {{ docId?: any, nodeId?: any, address?: any, scope?: string, trust?: string, owner?: string }} [args] */
  certifyNodes(args) {
    return history.certifyNodes(this, args);
  }

  computeDiff(prevSnapshot, currentSnapshot) {
    return computeSnapshotDiff(prevSnapshot, currentSnapshot);
  }

  restoreCommit(commitId) {
    return history.restoreCommit(this, commitId);
  }

  /** @param {{ commitId?: any, owner?: string, summary?: any }} [args] */
  revertCommit(args) {
    return history.revertCommit(this, args);
  }

  updateDocAxiomsCollapsed(docId, collapsed) {
    const value = collapsed ? 1 : 0;
    this.db.prepare('UPDATE docs SET axioms_collapsed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(value, docId);
    return this.db.prepare('SELECT * FROM docs WHERE id = ?').get(docId);
  }

  updateDocTreeViewState(docId, state) {
    const value = normalizeTreeViewState(state);
    this.db.prepare('UPDATE docs SET tree_view_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(value, docId);
    return this.db.prepare('SELECT * FROM docs WHERE id = ?').get(docId);
  }

  addAxiom({ docId, content, status = 'pending', nodeTitle = '', nodeNote = '', nodeWidth = null, nodeHeight = null, nodeSizeMode = 'auto' }) {
    return this.withTransaction(() => {
      const next = this.db.prepare(`
        SELECT COALESCE(MAX(
          CASE WHEN label GLOB 'A[0-9]*' THEN CAST(substr(label, 2) AS INTEGER) ELSE 0 END
        ), 0) + 1 AS next_label
        FROM axioms
        WHERE doc_id = ?
      `).get(docId);
      const label = `A${Number(next?.next_label || 1)}`;
      const width = normalizePositiveNumber(nodeWidth);
      const height = normalizePositiveNumber(nodeHeight);
      let sizeMode = normalizeNodeSizeMode(nodeSizeMode);
      if (sizeMode === 'manual' && (width === null || height === null)) {
        sizeMode = 'auto';
      } else if (sizeMode === 'auto') {
        sizeMode = width !== null && height !== null ? 'manual' : 'auto';
      }
      const axiomId = newStableId();
      this.db.prepare(`
        INSERT INTO axioms (id, doc_id, label, content, status, node_title, node_note, node_width, node_height, node_size_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        axiomId,
        docId,
        label,
        typeof content === 'string' ? content : '',
        typeof status === 'string' ? status : 'pending',
        String(nodeTitle || '').trim() || `事实前提 ${label}`,
        String(nodeNote || ''),
        sizeMode === 'manual' ? width : null,
        sizeMode === 'manual' ? height : null,
        sizeMode
      );
      this.touchDoc(docId);
      return this.db.prepare('SELECT * FROM axioms WHERE id = ?').get(axiomId);
    });
  }

  listAxioms(docId) {
    return this.db.prepare(`
      SELECT * FROM axioms
      WHERE doc_id = ?
      ORDER BY ${AXIOM_ORDER_SQL}
    `).all(docId);
  }

  deleteAxiom(axiomId) {
    const axiom = this.db.prepare('SELECT * FROM axioms WHERE id = ?').get(axiomId);
    if (!axiom) return false;
    this.withTransaction(() => {
      this.db.prepare("DELETE FROM refs WHERE source_type = 'axiom' AND source_id = ?").run(axiomId);
      this.db.prepare('DELETE FROM axioms WHERE id = ?').run(axiomId);
      this.touchDoc(axiom.doc_id);
    });
    return true;
  }

  updateAxiom(axiomId, patch) {
    const current = this.db.prepare('SELECT * FROM axioms WHERE id = ?').get(axiomId);
    if (!current) throw new Error(`Axiom not found: ${axiomId}`);
    const hasWidthPatch = hasPatchValue(patch, 'node_width', 'nodeWidth');
    const hasHeightPatch = hasPatchValue(patch, 'node_height', 'nodeHeight');
    const hasSizeModePatch = hasPatchValue(patch, 'node_size_mode', 'nodeSizeMode');
    let nodeWidth = normalizePositiveNumber(patchValue(patch, 'node_width', 'nodeWidth', current.node_width));
    let nodeHeight = normalizePositiveNumber(patchValue(patch, 'node_height', 'nodeHeight', current.node_height));
    let nodeSizeMode = normalizeNodeSizeMode(
      patchValue(patch, 'node_size_mode', 'nodeSizeMode', current.node_size_mode)
    );
    if (!hasSizeModePatch && (hasWidthPatch || hasHeightPatch)) {
      nodeSizeMode = nodeWidth !== null && nodeHeight !== null ? 'manual' : 'auto';
    }
    if (nodeSizeMode === 'auto') {
      nodeWidth = null;
      nodeHeight = null;
    }
    this.db.prepare(`
      UPDATE axioms
      SET content = ?, status = ?, node_title = ?, node_note = ?, node_width = ?, node_height = ?, node_size_mode = ?
      WHERE id = ?
    `).run(
      patch.content ?? current.content,
      patch.status ?? current.status,
      patch.node_title ?? patch.nodeTitle ?? current.node_title ?? '',
      patch.node_note ?? patch.nodeNote ?? current.node_note ?? '',
      nodeWidth,
      nodeHeight,
      nodeSizeMode,
      axiomId
    );
    this.touchDoc(current.doc_id);
    return this.db.prepare('SELECT * FROM axioms WHERE id = ?').get(axiomId);
  }

  moveAxiom({ docId, axiomId, direction }) {
    const axioms = this.listAxioms(docId);
    const index = axioms.findIndex((axiom) => sameStableId(axiom.id, axiomId));
    if (index < 0) throw new Error(`Axiom not found: ${axiomId}`);
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= axioms.length) return false;
    const current = axioms[index];
    const target = axioms[targetIndex];
    this.withTransaction(() => {
      this.db.prepare('UPDATE axioms SET label = ? WHERE id = ?').run(target.label, current.id);
      this.db.prepare('UPDATE axioms SET label = ? WHERE id = ?').run(current.label, target.id);
      this.touchDoc(docId);
    });
    return true;
  }

  getDocFolder(folderId) {
    const id = Number(folderId);
    if (!Number.isInteger(id) || id <= 0) return null;
    return this.db.prepare('SELECT * FROM doc_folders WHERE id = ?').get(id) || null;
  }

  normalizeFolderId(folderId) {
    if (folderId === null || folderId === undefined || folderId === '') return null;
    const id = Number(folderId);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid document folder id: ${folderId}`);
    const folder = this.getDocFolder(id);
    if (!folder) throw new Error(`Document folder not found: ${folderId}`);
    return folder.id;
  }

  nextFolderSortOrder(parentId) {
    const result = this.db.prepare(`
      SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order
      FROM doc_folders
      WHERE parent_id IS ?
    `).get(parentId);
    return Number(result?.next_order || 1);
  }

  nextDocSortOrder(folderId) {
    const result = this.db.prepare(`
      SELECT COALESCE(MAX(doc_sort_order), 0) + 1 AS next_order
      FROM docs
      WHERE folder_id IS ?
    `).get(folderId);
    return Number(result?.next_order || 1);
  }

  isDocFolderDescendant(folderId, ancestorId) {
    let current = this.getDocFolder(folderId);
    while (current) {
      if (current.parent_id === ancestorId) return true;
      current = current.parent_id === null ? null : this.getDocFolder(current.parent_id);
    }
    return false;
  }

  normalizeSiblingOrder(docId, parentId) {
    const siblings = this.db.prepare(`
      SELECT id FROM nodes
      WHERE doc_id = ? AND parent_id IS ?
      ORDER BY sort_order, id
    `).all(docId, parentId);

    siblings.forEach((sibling, index) => {
      this.db.prepare('UPDATE nodes SET sort_order = ? WHERE id = ?').run(index + 1, sibling.id);
    });
  }

  setSiblingOrder(docId, parentId, orderedIds) {
    orderedIds.forEach((id, index) => {
      this.db.prepare(`
        UPDATE nodes
        SET parent_id = ?, sort_order = ?
        WHERE doc_id = ? AND id = ?
      `).run(parentId, index + 1, docId, id);
    });
  }

  touchDoc(docId) {
    this.db.prepare('UPDATE docs SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(docId);
  }

  createSnapshot(docId) {
    const doc = this.db.prepare('SELECT id, meta, axioms_collapsed, tree_view_state FROM docs WHERE id = ?').get(docId) || null;
    const sourceDocument = this.db.prepare('SELECT * FROM source_documents WHERE doc_id = ?').get(docId) || null;
    const nodes = this.db.prepare('SELECT * FROM nodes WHERE doc_id = ? ORDER BY id').all(docId);
    const refs = nodes.length === 0
      ? []
      : this.db.prepare(`
        SELECT * FROM refs
        WHERE (source_type = 'node' AND source_id IN (SELECT id FROM nodes WHERE doc_id = ?))
           OR (target_type = 'node' AND target_id IN (SELECT id FROM nodes WHERE doc_id = ?))
        ORDER BY id
      `).all(docId, docId);

    return {
      doc,
      nodes,
      axioms: this.listAxioms(docId),
      refs,
      sourceDocument
    };
  }

  assertRestorableSnapshot(snapshot) {
    return assertRestorableSnapshotPayload(snapshot);
  }

  // 编辑器易失令牌实现见 ./editor-snapshot-tokens.mjs；此处保留 store 门面方法转调（实例持进程内表）。
  createEditorSnapshotToken(docId) {
    return this.editorSnapshots.create(docId);
  }

  restoreEditorSnapshotToken(args) {
    return this.editorSnapshots.restore(args);
  }

  discardEditorSnapshotTokens(tokenIds = []) {
    return this.editorSnapshots.discard(tokenIds);
  }

  restoreSnapshot(docId, snapshot) {
    const snapshotNodes = this.assertRestorableSnapshot(snapshot);
    this.withTransaction(() => {
      if (snapshot.doc) {
        const hasMeta = Object.prototype.hasOwnProperty.call(snapshot.doc, 'meta');
        const hasAxiomsCollapsed = Object.prototype.hasOwnProperty.call(snapshot.doc, 'axioms_collapsed');
        const hasTreeViewState = Object.prototype.hasOwnProperty.call(snapshot.doc, 'tree_view_state');
        if (hasMeta || hasAxiomsCollapsed || hasTreeViewState) {
          const current = this.db.prepare('SELECT meta, axioms_collapsed, tree_view_state FROM docs WHERE id = ?').get(docId) || {};
          this.db.prepare('UPDATE docs SET meta = ?, axioms_collapsed = ?, tree_view_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(
              hasMeta ? (snapshot.doc.meta || null) : current.meta,
              hasAxiomsCollapsed ? (snapshot.doc.axioms_collapsed ? 1 : 0) : (current.axioms_collapsed ? 1 : 0),
              hasTreeViewState ? normalizeTreeViewState(snapshot.doc.tree_view_state) : (current.tree_view_state || '{}'),
              docId
            );
        }
      }
      if (Object.prototype.hasOwnProperty.call(snapshot, 'sourceDocument')) {
        this.db.prepare('DELETE FROM source_documents WHERE doc_id = ?').run(docId);
        if (snapshot.sourceDocument) {
          this.db.prepare(`
            INSERT INTO source_documents (doc_id, source_type, original_path, raw_markdown, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            docId,
            snapshot.sourceDocument.source_type || 'file',
            snapshot.sourceDocument.original_path || null,
            snapshot.sourceDocument.raw_markdown || '',
            snapshot.sourceDocument.created_at || new Date().toISOString()
          );
        }
      }
      const sourceSpanLinks = this.db.prepare(`
        SELECT id, node_id FROM source_spans
        WHERE doc_id = ? AND node_id IS NOT NULL
      `).all(docId);
      const snapshotNodeIds = new Set(snapshotNodes.map((node) => node.id));

      this.db.prepare(`
        DELETE FROM refs
        WHERE (source_type = 'node' AND source_id IN (SELECT id FROM nodes WHERE doc_id = ?))
           OR (target_type = 'node' AND target_id IN (SELECT id FROM nodes WHERE doc_id = ?))
      `).run(docId, docId);

      this.db.prepare('DELETE FROM axioms WHERE doc_id = ?').run(docId);
      this.db.prepare('DELETE FROM nodes WHERE doc_id = ?').run(docId);

      this.insertSnapshotNodes(snapshotNodes, docId);
      const restoreSourceSpan = this.db.prepare('UPDATE source_spans SET node_id = ? WHERE id = ?');
      for (const link of sourceSpanLinks) {
        if (snapshotNodeIds.has(link.node_id)) restoreSourceSpan.run(link.node_id, link.id);
      }

      const insertAxiom = this.db.prepare(`
        INSERT INTO axioms (id, doc_id, label, content, status, node_title, node_note, node_width, node_height, node_size_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const axiom of snapshot.axioms || []) {
        const width = normalizePositiveNumber(axiom.node_width);
        const height = normalizePositiveNumber(axiom.node_height);
        const sizeMode = normalizeNodeSizeMode(
          axiom.node_size_mode ?? (width !== null && height !== null ? 'manual' : 'auto')
        );
        insertAxiom.run(
          axiom.id,
          axiom.doc_id,
          axiom.label,
          axiom.content,
          axiom.status,
          axiom.node_title || '',
          axiom.node_note || '',
          sizeMode === 'manual' ? width : null,
          sizeMode === 'manual' ? height : null,
          sizeMode
        );
      }

      const insertRef = this.db.prepare(`
        INSERT INTO refs (id, source_type, source_id, target_type, target_id, ref_kind, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const ref of snapshot.refs || []) {
        insertRef.run(ref.id, ref.source_type, ref.source_id, ref.target_type, ref.target_id, ref.ref_kind, ref.note);
      }

      this.removeRootAxiomRefs(docId);
      this.refreshDocAddresses(docId);
      this.touchDoc(docId);
    });
  }

  // docId 由调用方（restore）显式传：对象库重建出的节点不带 doc_id（内容寻址 doc 无关），用目标 doc 盖上。
  // created_at/updated_at 同理不入对象库（非内容）；缺失时取当下，旧形态快照带了就保留。
  insertSnapshotNodes(nodes, docId = null) {
    const nowIso = new Date().toISOString();
    const insertNode = this.db.prepare(`
      INSERT INTO nodes (
        id, doc_id, parent_id, sort_order, node_type, text, node_title, node_note, source_position,
        trust_level, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const runInsert = (node) => insertNode.run(
      node.id,
      docId ?? node.doc_id,
      node.parent_id,
      node.sort_order,
      normalizeNodeType(node.node_type),
      node.text,
      node.node_title || '',
      node.node_note || '',
      normalizeSourcePosition(node.source_position),
      node.trust_level,
      node.created_at ?? nowIso,
      node.updated_at ?? nowIso
    );

    // 拓扑插入（Kahn/BFS）：父必先于子（FK 要求），从根按邻接表下行，一次过 O(N)。
    // 替换原「每轮倒序扫剩余数组找『父已插入』者 + splice」的 O(N²)——深父子链每轮只插一个节点。
    const childrenByParent = new Map();
    const roots = [];
    for (const node of nodes) {
      if (node.parent_id === null || node.parent_id === undefined) {
        roots.push(node);
        continue;
      }
      const key = String(node.parent_id);
      if (!childrenByParent.has(key)) childrenByParent.set(key, []);
      childrenByParent.get(key).push(node);
    }

    const queue = [...roots];
    let head = 0;
    while (head < queue.length) {
      const node = queue[head];
      head += 1;
      runInsert(node);
      const kids = childrenByParent.get(String(node.id));
      if (kids) for (const kid of kids) queue.push(kid);
    }
    // 父不在本批的节点（完整快照不该有）/ 成环节点永不入队 → 计数不符即报，与原「unresolved parents」同语义。
    if (head !== nodes.length) throw new Error('Snapshot contains unresolved node parents');
  }

  withTransaction(fn) {
    if (this.inTransaction) return fn();

    this.inTransaction = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
}
