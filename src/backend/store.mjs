import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

import { mergeNodeNotes } from '../core/node-notes.mjs';
import { normalizeNodeType } from '../core/node-model.mjs';
import { buildTree, splitSentences } from '../core/tree.mjs';
import { compareNodeAddress, parseJsonObject } from './shared.mjs';
import { AXIOM_ORDER_SQL, TABLES_SQL } from './db/schema.mjs';
import {
  compareStableIds,
  newStableId,
  requireStableId,
  sameStableId
} from './db/ids.mjs';
import {
  addressSortKey,
  areRecordsAddressSorted,
  hasPatchValue,
  mergePdfCharRects,
  normalizeDocFolderName,
  normalizeNodeIdBatch,
  normalizeNodeSizeMode,
  normalizeNullableText,
  normalizePositiveCount,
  normalizePositiveId,
  normalizePositiveNumber,
  normalizeSourcePosition,
  normalizeTreeViewState,
  patchValue,
  recordSentenceIndexes
} from './db/normalizers.mjs';
import {
  assertRestorableSnapshotPayload,
  computeSnapshotDiff
} from './db/snapshot-history.mjs';
import {
  LIBRARY_NAVIGATION_DOC_ID,
  LIBRARY_NAVIGATION_DOC_META,
  LIBRARY_NAVIGATION_DOC_TITLE
} from './virtual-docs.mjs';
import {
  activeEditBranchEntries,
  isSupportedEditBranchEntryKind,
  isTmpId,
  nextTmpId,
  projectEditBranchDoc,
  undoneEditBranchEntries
} from './edit-branch-projection.mjs';

export { normalizePositiveCount, normalizePositiveId, normalizePositiveNumber };

function createLazyEditBranchBaseSnapshot({ owner, baseDocId, shadowDocId, baseCommitId = null }) {
  return {
    kind: 'edit_branch_base',
    storage: 'lazy_diff',
    owner,
    baseDocId,
    shadowDocId,
    baseCommitId,
    createdAt: new Date().toISOString()
  };
}

function createEmptyEditBranchDiff({ owner, baseDocId, shadowDocId }) {
  return {
    kind: 'edit_branch_diff',
    storage: 'lazy_diff',
    owner,
    baseDocId,
    shadowDocId,
    entries: []
  };
}

function hasOwnValue(source, ...keys) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(source || {}, key));
}

function assertNoHumanTagField(source, context = 'node patch') {
  if (hasOwnValue(source, 'human_tag', 'humanTag')) {
    throw new Error(`${context} no longer supports human_tag; set node_type instead`);
  }
}

function mapOldId(map, value) {
  if (value === null || value === undefined || value === '') return value;
  return map.get(String(value)) ?? value;
}

function mapMaybeTmp(map, value) {
  if (isTmpId(value)) return value;
  return mapOldId(map, value);
}

function rewriteTreeViewStateIds(value, maps) {
  const state = typeof value === 'string' ? JSON.parse(value || '{}') : (value || {});
  const rewriteList = (items) => (Array.isArray(items)
    ? items.map((item) => mapOldId(maps.nodeIds, item)).filter(Boolean)
    : []);
  return JSON.stringify({
    ...state,
    collapsedNodeIds: rewriteList(state.collapsedNodeIds),
    expandedNodeIds: rewriteList(state.expandedNodeIds),
    outlineCollapsedNodeIds: rewriteList(state.outlineCollapsedNodeIds)
  });
}

function rewriteSnapshotIds(snapshot, maps) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const next = { ...snapshot };
  if (next.doc) {
    next.doc = {
      ...next.doc,
      id: mapOldId(maps.docIds, next.doc.id),
      tree_view_state: rewriteTreeViewStateIds(next.doc.tree_view_state, maps)
    };
  }
  if (next.sourceDocument) {
    next.sourceDocument = {
      ...next.sourceDocument,
      doc_id: mapOldId(maps.docIds, next.sourceDocument.doc_id)
    };
  }
  if (Array.isArray(next.nodes)) {
    next.nodes = next.nodes.map((node) => ({
      ...node,
      id: mapOldId(maps.nodeIds, node.id),
      doc_id: mapOldId(maps.docIds, node.doc_id),
      parent_id: node.parent_id === null || node.parent_id === undefined
        ? null
        : mapOldId(maps.nodeIds, node.parent_id)
    }));
  }
  if (Array.isArray(next.axioms)) {
    next.axioms = next.axioms.map((axiom) => ({
      ...axiom,
      id: mapOldId(maps.axiomIds, axiom.id),
      doc_id: mapOldId(maps.docIds, axiom.doc_id)
    }));
  }
  if (Array.isArray(next.refs)) {
    next.refs = next.refs.map((ref) => ({
      ...ref,
      id: mapOldId(maps.refIds, ref.id),
      source_id: ref.source_type === 'axiom'
        ? mapOldId(maps.axiomIds, ref.source_id)
        : mapOldId(maps.nodeIds, ref.source_id),
      target_id: ref.target_type === 'axiom'
        ? mapOldId(maps.axiomIds, ref.target_id)
        : mapOldId(maps.nodeIds, ref.target_id)
    }));
  }
  return next;
}

function rewriteEditBranchEntryIds(entry, maps) {
  if (!entry || typeof entry !== 'object') return entry;
  const next = { ...entry };
  switch (entry.kind) {
    case 'node.update':
      next.node_id = mapMaybeTmp(maps.nodeIds, entry.node_id);
      break;
    case 'node.insert':
      next.parent_ref = mapMaybeTmp(maps.nodeIds, entry.parent_ref);
      next.after_ref = mapMaybeTmp(maps.nodeIds, entry.after_ref);
      break;
    case 'node.delete':
    case 'node.move':
    case 'node.promote':
      next.target_ref = mapMaybeTmp(maps.nodeIds, entry.target_ref);
      break;
    case 'node.split':
      next.target_ref = mapMaybeTmp(maps.nodeIds, entry.target_ref);
      if (Array.isArray(entry.paragraph_splits)) {
        next.paragraph_splits = entry.paragraph_splits.map((split) => ({
          ...split,
          paragraph_node_id: mapMaybeTmp(maps.nodeIds, split.paragraph_node_id)
        }));
      }
      break;
    case 'node.mergeInto':
      next.source_ref = mapMaybeTmp(maps.nodeIds, entry.source_ref);
      next.target_ref = mapMaybeTmp(maps.nodeIds, entry.target_ref);
      break;
    case 'node.mergePrevious':
      next.source_ref = mapMaybeTmp(maps.nodeIds, entry.source_ref);
      next.target_ref = mapMaybeTmp(maps.nodeIds, entry.target_ref);
      break;
    case 'node.reparent':
      next.node_ref = mapMaybeTmp(maps.nodeIds, entry.node_ref);
      next.new_parent_ref = mapMaybeTmp(maps.nodeIds, entry.new_parent_ref);
      break;
    case 'node.moveBefore':
    case 'node.moveAfter':
      next.node_ref = mapMaybeTmp(maps.nodeIds, entry.node_ref);
      next.target_ref = mapMaybeTmp(maps.nodeIds, entry.target_ref);
      break;
    case 'axiom.update':
    case 'axiom.delete':
    case 'axiom.move':
      next.axiom_ref = mapMaybeTmp(maps.axiomIds, entry.axiom_ref);
      break;
    case 'ref.addNodeToNode':
      next.source_ref = mapMaybeTmp(maps.nodeIds, entry.source_ref);
      next.target_ref = mapMaybeTmp(maps.nodeIds, entry.target_ref);
      break;
    case 'ref.addAxiomToNode':
      next.node_ref = mapMaybeTmp(maps.nodeIds, entry.node_ref);
      next.axiom_ref = mapMaybeTmp(maps.axiomIds, entry.axiom_ref);
      break;
    case 'ref.delete':
      next.ref_ref = mapMaybeTmp(maps.refIds, entry.ref_ref);
      break;
    case 'entity.create':
      next.fields = {
        ...(entry.fields || {}),
        doc_id: mapOldId(maps.docIds, entry.fields?.doc_id)
      };
      break;
    case 'entity.update':
    case 'entity.delete':
      next.entity_ref = mapMaybeTmp(maps.entityIds, entry.entity_ref);
      break;
    case 'entity.link':
    case 'entity.unlink':
      next.source_ref = mapMaybeTmp(maps.entityIds, entry.source_ref);
      next.target_ref = mapMaybeTmp(maps.entityIds, entry.target_ref);
      break;
    case 'entity.bindNode':
    case 'entity.ignoreNode':
    case 'entity.clearNodeBinding':
      next.entity_ref = mapMaybeTmp(maps.entityIds, entry.entity_ref);
      next.node_id = mapMaybeTmp(maps.nodeIds, entry.node_id);
      break;
    default:
      break;
  }
  return next;
}

function rewritePersistedJsonIds(value, maps) {
  if (!value) return value;
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return value;
  }
  if (!parsed || typeof parsed !== 'object') return value;
  const next = { ...parsed };
  if (next.docId !== undefined) next.docId = mapOldId(maps.docIds, next.docId);
  if (next.baseDocId !== undefined) next.baseDocId = mapOldId(maps.docIds, next.baseDocId);
  if (next.shadowDocId !== undefined) next.shadowDocId = mapOldId(maps.docIds, next.shadowDocId);
  if (next.snapshot) next.snapshot = rewriteSnapshotIds(next.snapshot, maps);
  if (next.kind === 'snapshot' && Array.isArray(next.nodes)) return JSON.stringify(rewriteSnapshotIds(next, maps));
  if (Array.isArray(next.entries)) {
    next.entries = next.entries.map((entry) => {
      const rewritten = rewriteEditBranchEntryIds(entry, maps);
      if (rewritten.node_id !== undefined) rewritten.node_id = mapMaybeTmp(maps.nodeIds, rewritten.node_id);
      return rewritten;
    });
  }
  return JSON.stringify(next);
}

function nodeRowWithClientAliases(row) {
  if (!row) return row;
  return {
    ...row,
    docId: row.doc_id,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    nodeType: row.node_type,
    title: row.node_title || '',
    nodeTitle: row.node_title || '',
    note: row.node_note || '',
    nodeNote: row.node_note || '',
    trustLevel: row.trust_level ?? null,
    sourcePosition: row.source_position ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null
  };
}

const EDIT_BRANCH_DIFF_NODE_FIELDS = [
  'text',
  'node_title',
  'node_note',
  'node_type',
  'trust_level',
  'source_position',
  'parent_id',
  'sort_order'
];

function normalizeDiffFieldValue(row, field) {
  if (!row) return null;
  if (field === 'parent_id') {
    return row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id);
  }
  if (field === 'sort_order') return Number(row.sort_order) || 0;
  if (field === 'source_position') {
    return row.source_position === null || row.source_position === undefined ? null : Number(row.source_position);
  }
  return row[field] === null || row[field] === undefined ? '' : String(row[field]);
}

function editBranchChangedNodeFields(left, right) {
  if (!left || !right) return [];
  return EDIT_BRANCH_DIFF_NODE_FIELDS.filter((field) => (
    normalizeDiffFieldValue(left, field) !== normalizeDiffFieldValue(right, field)
  ));
}

function editBranchDiffNode(row) {
  if (!row) return null;
  const node = nodeRowWithClientAliases(row);
  return {
    ...node,
    childCount: Math.max(0, Number(row.child_count) || 0)
  };
}

function parentAddressForDiff(address) {
  const parts = String(address || '').split('-').filter(Boolean);
  parts.pop();
  return parts.join('-');
}

function diffDepthForAddress(address) {
  return Math.max(1, String(address || '').split('-').filter(Boolean).length || 1);
}

function flattenDiffTreeItem(item) {
  const rows = [{ ...item.row }];
  for (const child of item.children) rows.push(...flattenDiffTreeItem(child));
  return rows;
}

function diffHiddenNodeCount(items) {
  return items.reduce((sum, item) => sum + flattenDiffTreeItem(item).length, 0);
}

function buildEditBranchDiffRows(baseNodes = [], projectedNodes = []) {
  const leftByAddress = new Map();
  const rightByAddress = new Map();
  for (const node of baseNodes) {
    if (node?.address) leftByAddress.set(String(node.address), node);
  }
  for (const node of projectedNodes) {
    if (node?.address) rightByAddress.set(String(node.address), node);
  }

  const addresses = [...new Set([...leftByAddress.keys(), ...rightByAddress.keys()])]
    .sort((left, right) => compareNodeAddress({ address: left }, { address: right }));
  const itemsByAddress = new Map();
  const stats = {
    added: 0,
    deleted: 0,
    modified: 0,
    unchanged: 0,
    collapsed: 0,
    visibleRows: 0,
    totalRows: 0
  };

  for (const address of addresses) {
    const left = leftByAddress.get(address) || null;
    const right = rightByAddress.get(address) || null;
    const changedFields = editBranchChangedNodeFields(left, right);
    const status = !left && right
      ? 'added'
      : left && !right
        ? 'deleted'
        : changedFields.length > 0
          ? 'modified'
          : 'unchanged';
    stats[status] += 1;
    stats.totalRows += 1;
    itemsByAddress.set(address, {
      row: {
        kind: 'node',
        key: `node:${address}`,
        address,
        depth: Number(left?.depth ?? right?.depth) || diffDepthForAddress(address),
        status,
        changedFields,
        left: editBranchDiffNode(left),
        right: editBranchDiffNode(right)
      },
      children: [],
      hasChangedDescendant: false
    });
  }

  const roots = [];
  for (const item of itemsByAddress.values()) {
    const parent = itemsByAddress.get(parentAddressForDiff(item.row.address));
    if (parent) parent.children.push(item);
    else roots.push(item);
  }

  function markChangedDescendants(item) {
    let hasChangedDescendant = false;
    for (const child of item.children) {
      const childChanged = markChangedDescendants(child);
      hasChangedDescendant = hasChangedDescendant || childChanged;
    }
    item.hasChangedDescendant = hasChangedDescendant;
    return item.row.status !== 'unchanged' || hasChangedDescendant;
  }

  for (const root of roots) markChangedDescendants(root);

  function collapsedRowFor(items) {
    const hiddenRows = items.flatMap(flattenDiffTreeItem);
    const first = hiddenRows[0];
    const last = hiddenRows[hiddenRows.length - 1];
    return {
      kind: 'collapsed',
      key: `collapsed:${first?.address || ''}:${last?.address || ''}`,
      address: first?.address || '',
      depth: first?.depth || 1,
      status: 'collapsed',
      hiddenCount: hiddenRows.length,
      hiddenRows
    };
  }

  function renderItems(items) {
    const rows = [];
    let pending = [];
    const flushPending = () => {
      if (pending.length === 0) return;
      const row = collapsedRowFor(pending);
      stats.collapsed += row.hiddenCount;
      rows.push(row);
      pending = [];
    };

    for (const item of items) {
      const canCollapse = item.row.depth > 1
        && item.row.status === 'unchanged'
        && !item.hasChangedDescendant;
      if (canCollapse) {
        pending.push(item);
        continue;
      }
      flushPending();
      rows.push({ ...item.row });
      rows.push(...renderItems(item.children));
    }
    flushPending();
    return rows;
  }

  const rows = renderItems(roots);
  stats.visibleRows = rows.length;
  stats.unchangedCollapsed = stats.collapsed;
  stats.hiddenRows = Math.max(0, diffHiddenNodeCount(roots) - rows.filter((row) => row.kind === 'node').length);
  return { rows, stats };
}

function isGeneratedImportParagraphTitle(value) {
  return /^段\d+\s*[·・]\s*\d+句$/u.test(String(value || '').trim());
}

export class IftreeStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.inTransaction = false;
    this.editorSnapshotTokens = new Map();
    this.editorSnapshotSeq = 1;
  }

  init(options = {}) {
    const readonly = options.readonly === true;
    if (!readonly) mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath, readonly ? { readonly: true, fileMustExist: true } : undefined);
    if (readonly) {
      this.db.pragma('query_only = ON');
      return;
    }
    this.db.pragma('journal_mode = PERSIST');
    this.db.exec(TABLES_SQL);
    this.migrateData();
  }

  migrateData() {
    this.ensureColumn('docs','folder_id', 'INTEGER');
    this.ensureColumn('docs','doc_sort_order', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('docs','axioms_collapsed', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('docs','tree_view_state', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('nodes','node_title', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('nodes','node_note', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('nodes','source_position', 'REAL');
    this.ensureColumn('save_history', 'commit_id', 'TEXT');
    this.foldHumanTagIntoNodeType();
    this.dropColumnIfExists('nodes', 'human_tag');
    this.normalizeExistingNodeTypes();
    this.migrateUuidIdentity();
    this.ensureEditBranchesAllowSharedShadowDoc();
    this.ensureVirtualDocs();
    this.clearGeneratedImportNodeFields();
    const addressColumnsChanged = this.ensureNodeStructureColumns();
    this.ensureColumn('axioms','node_title', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('axioms','node_note', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('axioms','node_width', 'REAL');
    this.ensureColumn('axioms','node_height', 'REAL');
    this.ensureColumn('axioms','node_size_mode', "TEXT NOT NULL DEFAULT 'auto'");
    this.normalizeExistingSizeModes('axioms');
    this.ensureNodeStructureIndexes();
    if (addressColumnsChanged || this.hasMissingNodeAddresses()) this.refreshAllAddresses();
    this.removeRootAxiomRefs();
    this.normalizeExistingDocFolderNames();
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

  ensureEditBranchesAllowSharedShadowDoc() {
    if (!this.hasTable('edit_branches')) return;
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'edit_branches'").get();
    if (!/\bshadow_doc_id\b[^,\n]*\bUNIQUE\b/i.test(String(row?.sql || ''))) return;
    this.db.pragma('foreign_keys = OFF');
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        DROP TABLE IF EXISTS edit_branches_multi;
        CREATE TABLE edit_branches_multi (
          id INTEGER PRIMARY KEY,
          base_doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
          shadow_doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
          owner TEXT NOT NULL DEFAULT 'human',
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          base_snapshot TEXT NOT NULL,
          diff TEXT NOT NULL DEFAULT '{}'
        );
      `);
      this.db.prepare(`
        INSERT INTO edit_branches_multi (id, base_doc_id, shadow_doc_id, owner, status, created_at, updated_at, base_snapshot, diff)
        SELECT id, base_doc_id, shadow_doc_id, owner, status, created_at, updated_at, base_snapshot, diff
        FROM edit_branches
      `).run();
      this.db.exec(`
        DROP TABLE edit_branches;
        ALTER TABLE edit_branches_multi RENAME TO edit_branches;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_edit_branches_base_owner_active
        ON edit_branches(base_doc_id, owner)
        WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS idx_edit_branches_shadow_status
        ON edit_branches(shadow_doc_id, status);
      `);
    });
    try {
      migrate();
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
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

  foldHumanTagIntoNodeType() {
    if (!this.hasColumn('nodes', 'human_tag')) return;
    this.db.exec(`
      UPDATE nodes
      SET node_type = 'HUMAN_BLOCK'
      WHERE human_tag = '人工-阻塞';

      UPDATE nodes
      SET node_type = 'HUMAN_SUMMARY'
      WHERE human_tag = '人工-汇总';
    `);
  }

  normalizeExistingNodeTypes() {
    if (!this.hasTable('nodes')) return;
    const rows = this.db.prepare('SELECT id, node_type FROM nodes').all();
    const update = this.db.prepare('UPDATE nodes SET node_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    for (const row of rows) {
      const normalized = normalizeNodeType(row.node_type);
      if (normalized !== row.node_type) update.run(normalized, row.id);
    }
  }

  needsUuidIdentityMigration() {
    if (!this.hasTable('docs')) return false;
    return this.columnType('docs', 'id') !== 'TEXT'
      || this.columnType('nodes', 'id') !== 'TEXT'
      || this.columnType('axioms', 'id') !== 'TEXT'
      || this.columnType('refs', 'id') !== 'TEXT'
      || this.columnType('entities', 'id') !== 'TEXT';
  }

  selectAllIfTable(table) {
    try {
      if (!this.hasTable(table)) return [];
      return this.db.prepare(`SELECT * FROM ${table}`).all();
    } catch {
      return [];
    }
  }

  makeUuidMap(rows) {
    return new Map(rows.map((row) => [String(row.id), newStableId()]));
  }

  migrateUuidIdentity() {
    if (!this.needsUuidIdentityMigration()) {
      this.seedCommitHeadsFromSaveHistory();
      return;
    }

    const docs = this.selectAllIfTable('docs');
    const nodes = this.selectAllIfTable('nodes');
    const axioms = this.selectAllIfTable('axioms');
    const refs = this.selectAllIfTable('refs');
    const sourceDocuments = this.selectAllIfTable('source_documents');
    const sourceSpans = this.selectAllIfTable('source_spans');
    const sourcePdfPages = this.selectAllIfTable('source_pdf_pages');
    const sourcePdfChars = this.selectAllIfTable('source_pdf_chars');
    const saveHistory = this.selectAllIfTable('save_history');
    const editBranches = this.selectAllIfTable('edit_branches');
    const entities = this.selectAllIfTable('entities');
    const entityLinks = this.selectAllIfTable('entity_links');
    const entityNodeBindings = this.selectAllIfTable('entity_node_bindings');

    const maps = {
      docIds: this.makeUuidMap(docs),
      nodeIds: this.makeUuidMap(nodes),
      axiomIds: this.makeUuidMap(axioms),
      refIds: this.makeUuidMap(refs),
      entityIds: this.makeUuidMap(entities)
    };

    const rewriteDiff = (value) => rewritePersistedJsonIds(value, maps);
    const rewriteState = (value) => {
      try {
        return rewriteTreeViewStateIds(value, maps);
      } catch {
        return '{}';
      }
    };

    this.db.pragma('foreign_keys = OFF');
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        DROP TABLE IF EXISTS docs_uuid;
        DROP TABLE IF EXISTS nodes_uuid;
        DROP TABLE IF EXISTS axioms_uuid;
        DROP TABLE IF EXISTS refs_uuid;
        DROP TABLE IF EXISTS source_documents_uuid;
        DROP TABLE IF EXISTS source_spans_uuid;
        DROP TABLE IF EXISTS source_pdf_pages_uuid;
        DROP TABLE IF EXISTS source_pdf_chars_uuid;
        DROP TABLE IF EXISTS save_history_uuid;
        DROP TABLE IF EXISTS edit_branches_uuid;
        DROP TABLE IF EXISTS entities_uuid;
        DROP TABLE IF EXISTS entity_links_uuid;
        DROP TABLE IF EXISTS entity_node_bindings_uuid;

        CREATE TABLE docs_uuid (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          meta TEXT,
          folder_id INTEGER REFERENCES doc_folders(id) ON DELETE SET NULL,
          doc_sort_order INTEGER NOT NULL DEFAULT 0,
          axioms_collapsed INTEGER NOT NULL DEFAULT 0,
          tree_view_state TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE nodes_uuid (
          id TEXT PRIMARY KEY,
          doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
          parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
          sort_order INTEGER NOT NULL,
          depth INTEGER NOT NULL DEFAULT 1,
          address TEXT NOT NULL DEFAULT '',
          node_type TEXT NOT NULL DEFAULT 'TEXT' CHECK(node_type IN ('TEXT', 'IF', 'THEN', 'ELSE', 'LOOP', 'FOREACH', 'BREAK', 'CONTINUE', 'ERROR', 'HUMAN_BLOCK', 'HUMAN_SUMMARY')),
          text TEXT NOT NULL DEFAULT '',
          node_title TEXT NOT NULL DEFAULT '',
          node_note TEXT NOT NULL DEFAULT '',
          source_position REAL,
          trust_level TEXT CHECK(trust_level IN ('受控', '不受控') OR trust_level IS NULL),
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE axioms_uuid (
          id TEXT PRIMARY KEY,
          doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          node_title TEXT NOT NULL DEFAULT '',
          node_note TEXT NOT NULL DEFAULT '',
          node_width REAL,
          node_height REAL,
          node_size_mode TEXT NOT NULL DEFAULT 'auto'
        );

        CREATE TABLE refs_uuid (
          id TEXT PRIMARY KEY,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          ref_kind TEXT NOT NULL,
          note TEXT
        );

        CREATE TABLE source_documents_uuid (
          doc_id TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
          source_type TEXT NOT NULL DEFAULT 'md',
          original_path TEXT,
          raw_markdown TEXT NOT NULL DEFAULT '',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE source_spans_uuid (
          id INTEGER PRIMARY KEY,
          doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
          node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
          sentence_index INTEGER NOT NULL,
          start_offset INTEGER NOT NULL,
          end_offset INTEGER NOT NULL,
          text TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE source_pdf_pages_uuid (
          id INTEGER PRIMARY KEY,
          doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
          page_number INTEGER NOT NULL,
          width REAL NOT NULL,
          height REAL NOT NULL
        );

        CREATE TABLE source_pdf_chars_uuid (
          id INTEGER PRIMARY KEY,
          doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
          char_offset INTEGER NOT NULL,
          page_number INTEGER NOT NULL,
          x0 REAL NOT NULL,
          y0 REAL NOT NULL,
          x1 REAL NOT NULL,
          y1 REAL NOT NULL,
          char_text TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE save_history_uuid (
          id INTEGER PRIMARY KEY,
          doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
          commit_id TEXT REFERENCES commits(id) ON DELETE SET NULL,
          saved_at TEXT DEFAULT CURRENT_TIMESTAMP,
          summary TEXT,
          diff TEXT
        );

        CREATE TABLE edit_branches_uuid (
          id INTEGER PRIMARY KEY,
          base_doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
          shadow_doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
          owner TEXT NOT NULL DEFAULT 'human',
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          base_snapshot TEXT NOT NULL,
          diff TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE entities_uuid (
          id TEXT PRIMARY KEY,
          doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
          literal TEXT NOT NULL,
          normalized_literal TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(doc_id, normalized_literal)
        );

        CREATE TABLE entity_links_uuid (
          id INTEGER PRIMARY KEY,
          kind TEXT NOT NULL CHECK(kind IN ('synonym', 'related')),
          entity_a_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          entity_b_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(entity_a_id, entity_b_id),
          CHECK(entity_a_id <> entity_b_id)
        );

        CREATE TABLE entity_node_bindings_uuid (
          id INTEGER PRIMARY KEY,
          entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK(status IN ('bound', 'ignored')),
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(entity_id, node_id)
        );
      `);

      const insertDoc = this.db.prepare(`
        INSERT INTO docs_uuid (id, title, created_at, updated_at, meta, folder_id, doc_sort_order, axioms_collapsed, tree_view_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of docs) {
        insertDoc.run(
          mapOldId(maps.docIds, row.id),
          row.title,
          row.created_at,
          row.updated_at,
          row.meta ?? null,
          row.folder_id ?? null,
          Number(row.doc_sort_order) || 0,
          row.axioms_collapsed ? 1 : 0,
          rewriteState(row.tree_view_state)
        );
      }

      const insertNode = this.db.prepare(`
        INSERT INTO nodes_uuid (
          id, doc_id, parent_id, sort_order, depth, address, node_type, text, node_title, node_note,
          source_position, trust_level, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of nodes) {
        insertNode.run(
          mapOldId(maps.nodeIds, row.id),
          mapOldId(maps.docIds, row.doc_id),
          row.parent_id === null || row.parent_id === undefined ? null : mapOldId(maps.nodeIds, row.parent_id),
          Number(row.sort_order) || 1,
          Number(row.depth) || 1,
          row.address || '',
          normalizeNodeType(row.node_type),
          row.text || '',
          row.node_title || '',
          row.node_note || '',
          normalizeSourcePosition(row.source_position),
          row.trust_level ?? null,
          row.created_at,
          row.updated_at
        );
      }

      const insertAxiom = this.db.prepare(`
        INSERT INTO axioms_uuid (id, doc_id, label, content, status, node_title, node_note, node_width, node_height, node_size_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of axioms) {
        insertAxiom.run(
          mapOldId(maps.axiomIds, row.id),
          mapOldId(maps.docIds, row.doc_id),
          row.label,
          row.content,
          row.status || 'pending',
          row.node_title || '',
          row.node_note || '',
          normalizePositiveNumber(row.node_width),
          normalizePositiveNumber(row.node_height),
          normalizeNodeSizeMode(row.node_size_mode)
        );
      }

      const insertRef = this.db.prepare(`
        INSERT INTO refs_uuid (id, source_type, source_id, target_type, target_id, ref_kind, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of refs) {
        insertRef.run(
          mapOldId(maps.refIds, row.id),
          row.source_type,
          row.source_type === 'axiom' ? mapOldId(maps.axiomIds, row.source_id) : mapOldId(maps.nodeIds, row.source_id),
          row.target_type,
          row.target_type === 'axiom' ? mapOldId(maps.axiomIds, row.target_id) : mapOldId(maps.nodeIds, row.target_id),
          row.ref_kind,
          row.note ?? null
        );
      }

      const insertSourceDocument = this.db.prepare(`
        INSERT INTO source_documents_uuid (doc_id, source_type, original_path, raw_markdown, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of sourceDocuments) {
        insertSourceDocument.run(
          mapOldId(maps.docIds, row.doc_id),
          row.source_type || 'md',
          row.original_path ?? null,
          row.raw_markdown || '',
          row.created_at
        );
      }

      const insertSpan = this.db.prepare(`
        INSERT INTO source_spans_uuid (id, doc_id, node_id, sentence_index, start_offset, end_offset, text)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of sourceSpans) {
        insertSpan.run(
          row.id,
          mapOldId(maps.docIds, row.doc_id),
          row.node_id === null || row.node_id === undefined ? null : mapOldId(maps.nodeIds, row.node_id),
          Number(row.sentence_index) || 1,
          Number(row.start_offset) || 0,
          Number(row.end_offset) || 0,
          row.text || ''
        );
      }

      const insertPage = this.db.prepare(`
        INSERT INTO source_pdf_pages_uuid (id, doc_id, page_number, width, height)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of sourcePdfPages) {
        insertPage.run(row.id, mapOldId(maps.docIds, row.doc_id), row.page_number, row.width, row.height);
      }

      const insertChar = this.db.prepare(`
        INSERT INTO source_pdf_chars_uuid (id, doc_id, char_offset, page_number, x0, y0, x1, y1, char_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of sourcePdfChars) {
        insertChar.run(
          row.id,
          mapOldId(maps.docIds, row.doc_id),
          row.char_offset,
          row.page_number,
          row.x0,
          row.y0,
          row.x1,
          row.y1,
          row.char_text || ''
        );
      }

      const insertHistory = this.db.prepare(`
        INSERT INTO save_history_uuid (id, doc_id, commit_id, saved_at, summary, diff)
        VALUES (?, ?, NULL, ?, ?, ?)
      `);
      for (const row of saveHistory) {
        insertHistory.run(
          row.id,
          mapOldId(maps.docIds, row.doc_id),
          row.saved_at,
          row.summary ?? null,
          rewriteDiff(row.diff)
        );
      }

      const insertBranch = this.db.prepare(`
        INSERT INTO edit_branches_uuid (id, base_doc_id, shadow_doc_id, owner, status, created_at, updated_at, base_snapshot, diff)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of editBranches) {
        insertBranch.run(
          row.id,
          mapOldId(maps.docIds, row.base_doc_id),
          mapOldId(maps.docIds, row.shadow_doc_id),
          row.owner || 'human',
          row.status || 'active',
          row.created_at,
          row.updated_at,
          rewriteDiff(row.base_snapshot),
          rewriteDiff(row.diff)
        );
      }

      const insertEntity = this.db.prepare(`
        INSERT INTO entities_uuid (id, doc_id, literal, normalized_literal, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const row of entities) {
        insertEntity.run(
          mapOldId(maps.entityIds, row.id),
          mapOldId(maps.docIds, row.doc_id),
          row.literal,
          row.normalized_literal,
          row.created_at,
          row.updated_at
        );
      }

      const insertEntityLink = this.db.prepare(`
        INSERT INTO entity_links_uuid (id, kind, entity_a_id, entity_b_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const row of entityLinks) {
        insertEntityLink.run(
          row.id,
          row.kind,
          mapOldId(maps.entityIds, row.entity_a_id),
          mapOldId(maps.entityIds, row.entity_b_id),
          row.created_at,
          row.updated_at
        );
      }

      const insertBinding = this.db.prepare(`
        INSERT INTO entity_node_bindings_uuid (id, entity_id, node_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const row of entityNodeBindings) {
        insertBinding.run(
          row.id,
          mapOldId(maps.entityIds, row.entity_id),
          mapOldId(maps.nodeIds, row.node_id),
          row.status,
          row.created_at,
          row.updated_at
        );
      }

      this.db.exec(`
        DROP TABLE IF EXISTS entity_node_bindings;
        DROP TABLE IF EXISTS entity_links;
        DROP TABLE IF EXISTS entities;
        DROP TABLE IF EXISTS edit_branches;
        DROP TABLE IF EXISTS save_history;
        DROP TABLE IF EXISTS source_pdf_chars;
        DROP TABLE IF EXISTS source_pdf_pages;
        DROP TABLE IF EXISTS source_spans;
        DROP TABLE IF EXISTS source_documents;
        DROP TABLE IF EXISTS refs;
        DROP TABLE IF EXISTS axioms;
        DROP TABLE IF EXISTS nodes;
        DROP TABLE IF EXISTS docs;

        ALTER TABLE docs_uuid RENAME TO docs;
        ALTER TABLE nodes_uuid RENAME TO nodes;
        ALTER TABLE axioms_uuid RENAME TO axioms;
        ALTER TABLE refs_uuid RENAME TO refs;
        ALTER TABLE source_documents_uuid RENAME TO source_documents;
        ALTER TABLE source_spans_uuid RENAME TO source_spans;
        ALTER TABLE source_pdf_pages_uuid RENAME TO source_pdf_pages;
        ALTER TABLE source_pdf_chars_uuid RENAME TO source_pdf_chars;
        ALTER TABLE save_history_uuid RENAME TO save_history;
        ALTER TABLE edit_branches_uuid RENAME TO edit_branches;
        ALTER TABLE entities_uuid RENAME TO entities;
        ALTER TABLE entity_links_uuid RENAME TO entity_links;
        ALTER TABLE entity_node_bindings_uuid RENAME TO entity_node_bindings;
      `);
    });

    try {
      migrate();
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
    this.db.exec(TABLES_SQL);
    this.seedCommitHeadsFromSaveHistory();
  }

  seedCommitHeadsFromSaveHistory() {
    if (!this.hasTable('commits') || !this.hasTable('doc_heads') || !this.hasTable('save_history')) return;
    const historyRows = this.db.prepare(`
      SELECT id, doc_id, commit_id, saved_at, summary, diff
      FROM save_history
      WHERE commit_id IS NULL OR commit_id = ''
      ORDER BY doc_id, saved_at, id
    `).all();
    const headByDoc = new Map(this.db.prepare('SELECT doc_id, head_commit_id FROM doc_heads').all()
      .map((row) => [String(row.doc_id), row.head_commit_id || null]));
    const insertCommit = this.db.prepare(`
      INSERT INTO commits (id, doc_id, parent_commit_id, committed_at, summary, diff, snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const updateHistory = this.db.prepare('UPDATE save_history SET commit_id = ? WHERE id = ?');
    const upsertHead = this.db.prepare(`
      INSERT INTO doc_heads (doc_id, head_commit_id, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(doc_id) DO UPDATE SET
        head_commit_id = excluded.head_commit_id,
        updated_at = CURRENT_TIMESTAMP
    `);

    this.withTransaction(() => {
      for (const row of historyRows) {
        const payload = (() => {
          try { return JSON.parse(row.diff || '{}'); } catch { return {}; }
        })();
        const snapshot = payload.snapshot || (payload.kind === 'snapshot' ? payload : {});
        const docKey = String(row.doc_id);
        const commitId = newStableId();
        insertCommit.run(
          commitId,
          row.doc_id,
          headByDoc.get(docKey) || null,
          row.saved_at,
          row.summary ?? null,
          row.diff || '{}',
          JSON.stringify(snapshot)
        );
        updateHistory.run(commitId, row.id);
        headByDoc.set(docKey, commitId);
      }

      const docs = this.db.prepare('SELECT id FROM docs ORDER BY id').all();
      for (const doc of docs) {
        upsertHead.run(doc.id, headByDoc.get(String(doc.id)) || null);
      }
    });
  }

  normalizeExistingDocFolderNames() {
    try {
      const folders = this.db.prepare('SELECT id, name FROM doc_folders').all();
      const update = this.db.prepare('UPDATE doc_folders SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      for (const folder of folders) {
        const normalized = normalizeDocFolderName(folder.name);
        if (normalized !== folder.name) update.run(normalized, folder.id);
      }
    } catch { /* table may not exist yet */ }
  }

  normalizeExistingSizeModes(table) {
    try {
      this.db.exec(`
        UPDATE ${table}
        SET node_size_mode = 'auto'
        WHERE node_size_mode IS NULL
          OR node_size_mode = ''
          OR node_size_mode NOT IN ('auto', 'manual')
      `);
    } catch { /* table may not exist yet */ }
  }

  clearGeneratedImportNodeFields() {
    try {
      const rows = this.db.prepare(`
        SELECT id, node_title
        FROM nodes
        WHERE node_title IS NOT NULL
          AND node_title != ''
      `).all();
      const ids = rows
        .filter((row) => isGeneratedImportParagraphTitle(row.node_title))
        .map((row) => normalizePositiveId(row.id))
        .filter(Boolean);
      if (ids.length === 0) return;
      const clearTitle = this.db.prepare("UPDATE nodes SET node_title = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?");
      this.withTransaction(() => {
        for (const id of ids) clearTitle.run(id);
      });
    } catch { /* table may not exist yet */ }
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

  ensureNodeStructureColumns() {
    const addedDepth = this.ensureColumn('nodes', 'depth', 'INTEGER NOT NULL DEFAULT 1');
    const addedAddress = this.ensureColumn('nodes', 'address', "TEXT NOT NULL DEFAULT ''");
    return Boolean(addedDepth || addedAddress);
  }

  ensureNodeStructureIndexes() {
    try {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_doc_depth ON nodes(doc_id, depth);
        CREATE INDEX IF NOT EXISTS idx_nodes_doc_address ON nodes(doc_id, address);
        CREATE INDEX IF NOT EXISTS idx_nodes_doc_source_position ON nodes(doc_id, source_position, id);
      `);
    } catch { /* table may not exist yet */ }
  }

  hasMissingNodeAddresses() {
    try {
      const row = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM nodes
        WHERE address IS NULL OR address = '' OR depth IS NULL OR depth < 1
      `).get();
      return Number(row?.count || 0) > 0;
    } catch {
      return false;
    }
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

  refreshNodeStructureMetadataChains() {
    return { updated: 0, nodes: 0 };
  }

  refreshNodeStructureMetadataChain() {
    return { updated: 0, nodes: 0 };
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
    const shadowFilter = this.hasEditBranchesTable()
      ? `WHERE NOT EXISTS (
        SELECT 1 FROM edit_branches eb
        WHERE eb.shadow_doc_id = d.id AND eb.status = 'active'
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

  createDoc({ title, rootText = title, meta = null, folderId = null }) {
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
      this.refreshNodeStructureMetadataChain(rootNodeId);

      return { id: docId, title, rootNodeId };
    });
  }

  deleteDoc(docId) {
    const doc = this.db.prepare('SELECT id FROM docs WHERE id = ?').get(docId);
    if (!doc) return false;

    this.withTransaction(() => {
      this.db.prepare('DELETE FROM edit_branches WHERE base_doc_id = ? OR shadow_doc_id = ?').run(docId, docId);
      this.db.prepare(`
        DELETE FROM refs
        WHERE (source_type = 'node' AND source_id IN (SELECT id FROM nodes WHERE doc_id = ?))
           OR (target_type = 'node' AND target_id IN (SELECT id FROM nodes WHERE doc_id = ?))
      `).run(docId, docId);
      this.db.prepare('DELETE FROM docs WHERE id = ?').run(docId);
    });

    return true;
  }

  normalizeEditBranchOwner(owner = 'human') {
    const value = String(owner || '').trim();
    return value || 'human';
  }

  activeEditBranchForBaseDoc(docId, owner = 'human') {
    if (!this.hasEditBranchesTable()) return null;
    return this.db.prepare(`
      SELECT * FROM edit_branches
      WHERE base_doc_id = ? AND owner = ? AND status = 'active'
      ORDER BY id DESC
      LIMIT 1
    `).get(normalizePositiveId(docId), this.normalizeEditBranchOwner(owner)) || null;
  }

  activeEditBranchForShadowDoc(docId) {
    if (!this.hasEditBranchesTable()) return null;
    return this.db.prepare(`
      SELECT * FROM edit_branches
      WHERE shadow_doc_id = ? AND status = 'active'
      ORDER BY id DESC
      LIMIT 1
    `).get(normalizePositiveId(docId)) || null;
  }

  activeEditBranchForDoc(docId, owner = null) {
    const shadow = this.activeEditBranchForShadowDoc(docId);
    if (shadow) {
      if (!owner || shadow.owner === this.normalizeEditBranchOwner(owner)) return shadow;
      return this.activeEditBranchForBaseDoc(shadow.base_doc_id, owner);
    }
    if (!owner) return null;
    return this.activeEditBranchForBaseDoc(docId, owner);
  }

  listActiveEditBranches(owner = null) {
    if (!this.hasEditBranchesTable()) return [];
    const normalizedOwner = owner ? this.normalizeEditBranchOwner(owner) : null;
    const where = normalizedOwner ? 'WHERE eb.status = \'active\' AND eb.owner = ?' : 'WHERE eb.status = \'active\'';
    const params = normalizedOwner ? [normalizedOwner] : [];
    return this.db.prepare(`
      SELECT eb.*,
        base.title AS base_title,
        shadow.title AS shadow_title,
        (SELECT COUNT(*) FROM nodes n WHERE n.doc_id = eb.base_doc_id) AS node_count
      FROM edit_branches eb
      LEFT JOIN docs base ON base.id = eb.base_doc_id
      LEFT JOIN docs shadow ON shadow.id = eb.shadow_doc_id
      ${where}
      ORDER BY eb.updated_at DESC, eb.id DESC
    `).all(...params);
  }

  docIdForMutationPayload(payload = {}) {
    const direct = normalizePositiveId(payload.docId ?? payload.doc_id ?? payload.baseDocId ?? payload.base_doc_id);
    if (direct !== null) return direct;
    const nodeId = normalizePositiveId(
      payload.nodeId
        ?? payload.node_id
        ?? payload.parentId
        ?? payload.parent_id
        ?? payload.sourceNodeId
        ?? payload.source_node_id
        ?? payload.targetNodeId
        ?? payload.target_node_id
    );
    if (nodeId !== null) {
      const node = this.db.prepare('SELECT doc_id FROM nodes WHERE id = ?').get(nodeId);
      if (node) return node.doc_id;
    }
    const axiomId = normalizePositiveId(payload.axiomId ?? payload.axiom_id);
    if (axiomId !== null) {
      const axiom = this.db.prepare('SELECT doc_id FROM axioms WHERE id = ?').get(axiomId);
      if (axiom) return axiom.doc_id;
    }
    const entityId = normalizePositiveId(
      payload.entityId
        ?? payload.entity_id
        ?? payload.sourceEntityId
        ?? payload.source_entity_id
        ?? payload.targetEntityId
        ?? payload.target_entity_id
        ?? payload.entityAId
        ?? payload.entity_a_id
        ?? payload.entityBId
        ?? payload.entity_b_id
        ?? (Array.isArray(payload.entityIds) ? payload.entityIds[0] : null)
        ?? (Array.isArray(payload.entity_ids) ? payload.entity_ids[0] : null)
    );
    if (entityId !== null) {
      const entity = this.db.prepare('SELECT doc_id FROM entities WHERE id = ?').get(entityId);
      if (entity) return entity.doc_id;
    }
    const refId = normalizePositiveId(payload.refId ?? payload.ref_id);
    if (refId !== null) {
      const ref = this.db.prepare('SELECT * FROM refs WHERE id = ?').get(refId);
      if (ref?.source_type === 'node') {
        const node = this.db.prepare('SELECT doc_id FROM nodes WHERE id = ?').get(ref.source_id);
        if (node) return node.doc_id;
      }
      if (ref?.target_type === 'node') {
        const node = this.db.prepare('SELECT doc_id FROM nodes WHERE id = ?').get(ref.target_id);
        if (node) return node.doc_id;
      }
      if (ref?.source_type === 'axiom') {
        const axiom = this.db.prepare('SELECT doc_id FROM axioms WHERE id = ?').get(ref.source_id);
        if (axiom) return axiom.doc_id;
      }
      if (ref?.target_type === 'axiom') {
        const axiom = this.db.prepare('SELECT doc_id FROM axioms WHERE id = ?').get(ref.target_id);
        if (axiom) return axiom.doc_id;
      }
    }
    return null;
  }

  nodePatchForEditBranch(current, patch = {}) {
    assertNoHumanTagField(patch, 'node.update patch');
    const next = {};
    if (hasOwnValue(patch, 'text')) next.text = patch.text ?? '';
    if (hasOwnValue(patch, 'node_title', 'nodeTitle')) next.node_title = patch.node_title ?? patch.nodeTitle ?? '';
    if (hasOwnValue(patch, 'node_note', 'nodeNote')) next.node_note = patch.node_note ?? patch.nodeNote ?? '';
    if (hasOwnValue(patch, 'source_position', 'sourcePosition')) {
      next.source_position = normalizeSourcePosition(
        patchValue(patch, 'source_position', 'sourcePosition', current.source_position)
      );
    }
    if (hasOwnValue(patch, 'node_type', 'nodeType')) {
      next.node_type = normalizeNodeType(patchValue(patch, 'node_type', 'nodeType', current.node_type));
    }
    if (hasOwnValue(patch, 'trust_level', 'trustLevel')) {
      next.trust_level = normalizeNullableText(patchValue(patch, 'trust_level', 'trustLevel', current.trust_level));
    }
    return next;
  }

  _appendEditBranchEntry(branch, entry) {
    if (!isSupportedEditBranchEntryKind(entry?.kind)) {
      throw new Error(`Unsupported edit branch entry kind: ${entry?.kind || ''}`);
    }
    const diff = JSON.parse(branch.diff || '{}');
    const entries = activeEditBranchEntries(diff.entries);
    const updatedAt = new Date().toISOString();
    entries.push({ ...entry, status: 'active', createdAt: entry.createdAt || updatedAt });
    const nextDiff = {
      ...diff,
      kind: 'edit_branch_diff',
      storage: 'lazy_diff',
      owner: branch.owner,
      baseDocId: branch.base_doc_id,
      shadowDocId: branch.shadow_doc_id,
      updatedAt,
      entries
    };
    this.db.prepare(`
      UPDATE edit_branches
      SET diff = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(nextDiff), branch.id);
    return this.db.prepare('SELECT * FROM edit_branches WHERE id = ?').get(branch.id);
  }

  editBranchHistoryState(branch) {
    const diff = JSON.parse(branch?.diff || '{}');
    const entries = Array.isArray(diff.entries) ? diff.entries : [];
    const activeEntries = activeEditBranchEntries(entries);
    const undoneEntries = undoneEditBranchEntries(entries);
    return {
      undoDepth: activeEntries.length,
      redoDepth: undoneEntries.length,
      hasUndo: activeEntries.length > 0,
      hasRedo: undoneEntries.length > 0
    };
  }

  getEditBranchDiffView({ branchId = null, shadowDocId = null, baseDocId = null, owner = 'human' } = {}) {
    const branch = this.findEditBranch({ branchId, shadowDocId, baseDocId, owner });
    if (!branch) throw new Error('Edit branch not found');
    const docId = normalizePositiveId(branch.base_doc_id);
    if (!docId) throw new Error('Edit branch base doc not found');
    const baseDoc = this.db.prepare('SELECT id, title FROM docs WHERE id = ?').get(docId);
    if (!baseDoc) throw new Error('Edit branch base doc not found');
    const baseNodes = this.db.prepare(`
      SELECT * FROM nodes WHERE doc_id = ?
      ORDER BY parent_id IS NOT NULL, parent_id, sort_order, id
    `).all(docId);
    const baseAxioms = this.listAxioms(docId);
    const baseRefs = this._fetchBaseRefsForDoc(docId);
    const diff = JSON.parse(branch.diff || '{}');
    const baseSnapshot = JSON.parse(branch.base_snapshot || '{}');
    const head = this.db.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?').get(docId);
    const entries = Array.isArray(diff.entries) ? diff.entries : [];
    const activeEntries = activeEditBranchEntries(entries);
    const projected = projectEditBranchDoc({
      docId,
      nodes: baseNodes,
      axioms: baseAxioms,
      refs: baseRefs
    }, activeEntries);
    const { rows, stats } = buildEditBranchDiffRows(baseNodes, projected.nodes);
    const historyState = this.editBranchHistoryState(branch);

    return {
      kind: 'editBranch.diffView',
      branch: { ...branch },
      baseDoc: { ...baseDoc },
      mergeBase: {
        baseCommitId: baseSnapshot.baseCommitId || null,
        previousBaseCommitId: baseSnapshot.previousBaseCommitId || null,
        currentHeadCommitId: head?.head_commit_id || null,
        isFastForward: (baseSnapshot.baseCommitId || null) === (head?.head_commit_id || null)
      },
      projectedDoc: {
        id: branch.shadow_doc_id,
        baseDocId: branch.base_doc_id,
        title: baseDoc.title
      },
      stats: {
        ...stats,
        activeEntryCount: activeEntries.length,
        undoneEntryCount: undoneEditBranchEntries(entries).length,
        undoDepth: historyState.undoDepth,
        redoDepth: historyState.redoDepth
      },
      rows
    };
  }

  _replaceEditBranchDiff(branch, diff) {
    const updatedAt = new Date().toISOString();
    const nextDiff = {
      ...diff,
      kind: 'edit_branch_diff',
      storage: 'lazy_diff',
      owner: branch.owner,
      baseDocId: branch.base_doc_id,
      shadowDocId: branch.shadow_doc_id,
      updatedAt
    };
    this.db.prepare(`
      UPDATE edit_branches
      SET diff = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(nextDiff), branch.id);
    return this.db.prepare('SELECT * FROM edit_branches WHERE id = ?').get(branch.id);
  }

  undoEditBranchEntry({ branchId = null, shadowDocId = null, baseDocId = null, owner = 'human' } = {}) {
    const branch = this.findEditBranch({ branchId, shadowDocId, baseDocId, owner });
    if (!branch) throw new Error('Edit branch not found');
    const diff = JSON.parse(branch.diff || '{}');
    const entries = Array.isArray(diff.entries) ? [...diff.entries] : [];
    const index = entries.findLastIndex((entry) => activeEditBranchEntries([entry]).length === 1);
    if (index < 0) {
      return { changed: false, branch, ...this.editBranchHistoryState(branch) };
    }
    const updatedAt = new Date().toISOString();
    entries[index] = { ...entries[index], status: 'undone', undoneAt: updatedAt };
    const freshBranch = this._replaceEditBranchDiff(branch, { ...diff, entries });
    return { changed: true, branch: freshBranch, ...this.editBranchHistoryState(freshBranch) };
  }

  redoEditBranchEntry({ branchId = null, shadowDocId = null, baseDocId = null, owner = 'human' } = {}) {
    const branch = this.findEditBranch({ branchId, shadowDocId, baseDocId, owner });
    if (!branch) throw new Error('Edit branch not found');
    const diff = JSON.parse(branch.diff || '{}');
    const entries = Array.isArray(diff.entries) ? [...diff.entries] : [];
    let index = -1;
    let latest = '';
    for (let i = 0; i < entries.length; i += 1) {
      if (activeEditBranchEntries([entries[i]]).length > 0) continue;
      const marker = String(entries[i].undoneAt || entries[i].createdAt || i);
      if (index < 0 || marker >= latest) {
        index = i;
        latest = marker;
      }
    }
    if (index < 0) {
      return { changed: false, branch, ...this.editBranchHistoryState(branch) };
    }
    const restored = { ...entries[index], status: 'active' };
    delete restored.undoneAt;
    entries[index] = restored;
    const freshBranch = this._replaceEditBranchDiff(branch, { ...diff, entries });
    return { changed: true, branch: freshBranch, ...this.editBranchHistoryState(freshBranch) };
  }

  // Fetch the doc-scoped refs (both endpoints in either nodes or axioms of the
  // doc). Shared between getDoc and _projectedDocForBranch so the lazy diff
  // projection always sees the same set of ref rows that the read path does.
  _fetchBaseRefsForDoc(docId) {
    return this.db.prepare(`
      SELECT refs.* FROM refs
      LEFT JOIN nodes source_nodes ON refs.source_type = 'node' AND refs.source_id = source_nodes.id
      LEFT JOIN nodes target_nodes ON refs.target_type = 'node' AND refs.target_id = target_nodes.id
      LEFT JOIN axioms source_axioms ON refs.source_type = 'axiom' AND refs.source_id = source_axioms.id
      LEFT JOIN axioms target_axioms ON refs.target_type = 'axiom' AND refs.target_id = target_axioms.id
      WHERE (refs.source_type = 'node' AND source_nodes.doc_id = ?)
         OR (refs.target_type = 'node' AND target_nodes.doc_id = ?)
         OR (refs.source_type = 'axiom' AND source_axioms.doc_id = ?)
         OR (refs.target_type = 'axiom' AND target_axioms.doc_id = ?)
      ORDER BY refs.id
    `).all(docId, docId, docId, docId);
  }

  // Read the doc with all entries from `branch` already projected on top of the
  // base tables. Returns the projection state (nodes/axioms/refs maps) — the
  // caller can use it to derive `node`, `axiom`, or `ref` views to hand back
  // to the front-end after a stage operation.
  _projectedDocForBranch(branch) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const baseNodes = this.db.prepare(`
      SELECT * FROM nodes WHERE doc_id = ?
      ORDER BY parent_id IS NOT NULL, parent_id, sort_order, id
    `).all(docId);
    const baseAxioms = this.listAxioms(docId);
    const baseRefs = this._fetchBaseRefsForDoc(docId);
    const diff = JSON.parse(branch.diff || '{}');
    const entries = Array.isArray(diff.entries) ? diff.entries : [];
    return projectEditBranchDoc({ docId, nodes: baseNodes, axioms: baseAxioms, refs: baseRefs }, entries);
  }

  _findProjectedNode(state, ref) {
    if (ref === null || ref === undefined) return null;
    if (isTmpId(ref)) return state.nodes.find((node) => node.id === ref) || null;
    return state.nodes.find((node) => sameStableId(node.id, ref)) || null;
  }

  _findProjectedAxiom(state, ref) {
    if (ref === null || ref === undefined) return null;
    if (isTmpId(ref)) return state.axioms.find((axiom) => axiom.id === ref) || null;
    return state.axioms.find((axiom) => sameStableId(axiom.id, ref)) || null;
  }

  stageEditBranchNodeUpdate(branch, payload = {}) {
    const nodeRef = payload.nodeId ?? payload.node_id;
    if (nodeRef === null || nodeRef === undefined) throw new Error('node.update requires nodeId');
    const before = this._projectedDocForBranch(branch);
    const currentNode = this._findProjectedNode(before, nodeRef);
    if (!currentNode) throw new Error(`Node not found in edit branch: ${nodeRef}`);
    const requestedPatch = this.nodePatchForEditBranch(currentNode, payload.patch || {});
    const patch = {};
    const fields = [];
    for (const [field, value] of Object.entries(requestedPatch)) {
      const oldValue = currentNode[field] ?? null;
      const nextValue = value ?? null;
      if (oldValue === nextValue) continue;
      patch[field] = value;
      fields.push({ field, old: oldValue, new: nextValue });
    }
    if (fields.length === 0) {
      return { branch, changed: false, node: nodeRowWithClientAliases(currentNode) };
    }
    const freshBranch = this._appendEditBranchEntry(branch, {
      kind: 'node.update',
      action: 'patch',
      node_id: currentNode.id,
      address: currentNode.address || '',
      patch,
      fields
    });
    const after = this._projectedDocForBranch(freshBranch);
    const projectedNode = this._findProjectedNode(after, currentNode.id) || currentNode;
    return { branch: freshBranch, changed: true, node: nodeRowWithClientAliases(projectedNode) };
  }

  stageEditBranchNodeInsert(branch, payload = {}) {
    assertNoHumanTagField(payload, 'node.insert payload');
    const docId = normalizePositiveId(branch.base_doc_id);
    const parentRef = payload.parentId ?? payload.parent_id ?? null;
    if (parentRef === null || parentRef === undefined) throw new Error('node.insert requires parentId');
    const tmpId = nextTmpId('node');
    const fields = {
      text: typeof payload.text === 'string' ? payload.text : '',
      node_type: normalizeNodeType(payload.nodeType ?? payload.node_type ?? 'TEXT'),
      node_title: payload.nodeTitle ?? payload.node_title ?? '',
      node_note: payload.nodeNote ?? payload.node_note ?? '',
      source_position: normalizeSourcePosition(payload.sourcePosition ?? payload.source_position ?? null),
      trust_level: normalizeNullableText(payload.trustLevel ?? payload.trust_level ?? null)
    };
    const freshBranch = this._appendEditBranchEntry(branch, {
      kind: 'node.insert',
      tmp_id: tmpId,
      parent_ref: parentRef,
      after_ref: payload.afterNodeId ?? payload.after_node_id ?? null,
      fields
    });
    const after = this._projectedDocForBranch(freshBranch);
    const inserted = this._findProjectedNode(after, tmpId);
    return {
      branch: freshBranch,
      changed: true,
      docId,
      node: inserted ? nodeRowWithClientAliases(inserted) : null,
      insertedNodeId: tmpId
    };
  }

  stageEditBranchNodeDelete(branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    if (ref === null || ref === undefined) throw new Error('node.delete requires nodeId');
    const before = this._projectedDocForBranch(branch);
    const target = this._findProjectedNode(before, ref);
    if (!target) throw new Error(`Node not found in edit branch: ${ref}`);
    if (target.parent_id === null || target.parent_id === undefined) {
      throw new Error('Cannot delete document root node');
    }
    const freshBranch = this._appendEditBranchEntry(branch, {
      kind: 'node.delete',
      target_ref: target.id,
      address: target.address || ''
    });
    return { branch: freshBranch, changed: true, docId };
  }

  stageEditBranchNodeMove(branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    if (ref === null || ref === undefined) throw new Error('node.move requires nodeId');
    const direction = payload.direction === 'up' ? 'up' : 'down';
    const freshBranch = this._appendEditBranchEntry(branch, {
      kind: 'node.move',
      target_ref: ref,
      direction
    });
    return { branch: freshBranch, changed: true, docId };
  }

  stageEditBranchNodePromote(branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    if (ref === null || ref === undefined) throw new Error('node.promote requires nodeId');
    const freshBranch = this._appendEditBranchEntry(branch, {
      kind: 'node.promote',
      target_ref: ref
    });
    return { branch: freshBranch, changed: true, docId };
  }

  stageEditBranchNodeSplit(branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    if (ref === null || ref === undefined) throw new Error('node.split requires nodeId');
    const before = this._projectedDocForBranch(branch);
    const target = this._findProjectedNode(before, ref);
    if (!target) throw new Error(`Node not found in edit branch: ${ref}`);

    // Source-paragraph mode: when target's subtree (in the real base table)
    // has childless paragraph nodes with source_spans, mirror what
    // splitNodeIntoChildren -> splitSourceParagraphsIntoSentenceChildren would
    // do. Only base node ids can carry source_spans; pending-insert tmp nodes
    // never do.
    if (!isTmpId(target.id)) {
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
      `).all(target.id);
      const baseChildCount = this.db.prepare('SELECT COUNT(*) AS count FROM nodes WHERE parent_id = ?');
      const spansStmt = this.db.prepare('SELECT * FROM source_spans WHERE node_id = ? ORDER BY sentence_index, id');
      const paragraphSplits = [];
      for (const candidate of candidates) {
        // skip if base or projection already gave this paragraph children
        if ((baseChildCount.get(candidate.id)?.count || 0) > 0) continue;
        const projectedChildren = before.nodes.filter((n) => sameStableId(n.parent_id, candidate.id));
        if (projectedChildren.length > 0) continue;
        const spans = spansStmt.all(candidate.id);
        if (spans.length === 0) continue;
        paragraphSplits.push({
          paragraph_node_id: candidate.id,
          spans: spans.map((span) => ({
            text: span.text || '',
            sentence_index: span.sentence_index ?? null,
            tmp_id: nextTmpId('node')
          }))
        });
      }
      if (paragraphSplits.length > 0) {
        const freshBranch = this._appendEditBranchEntry(branch, {
          kind: 'node.split',
          target_ref: target.id,
          strategy: 'source_paragraphs',
          paragraph_splits: paragraphSplits
        });
        return { branch: freshBranch, changed: true, docId };
      }
    }

    const sentences = splitSentences(target.text || '');
    if (sentences.length < 2) {
      return { branch, changed: false, docId };
    }
    const newIds = sentences.slice(1).map(() => nextTmpId('node'));
    const freshBranch = this._appendEditBranchEntry(branch, {
      kind: 'node.split',
      target_ref: target.id,
      strategy: 'split_sentences',
      sentences,
      new_node_ids: newIds
    });
    return { branch: freshBranch, changed: true, docId };
  }

  stageEditBranchNodeMergeInto(branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const sourceRef = payload.nodeId ?? payload.node_id;
    const targetRef = payload.targetNodeId ?? payload.target_node_id;
    if (sourceRef === null || sourceRef === undefined) throw new Error('node.mergeInto requires nodeId');
    if (targetRef === null || targetRef === undefined) throw new Error('node.mergeInto requires targetNodeId');
    const freshBranch = this._appendEditBranchEntry(branch, {
      kind: 'node.mergeInto',
      source_ref: sourceRef,
      target_ref: targetRef
    });
    return { branch: freshBranch, changed: true, docId };
  }

  stageEditBranchNodeReparent(branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    const newParentRef = payload.newParentId ?? payload.new_parent_id;
    if (ref === null || ref === undefined) throw new Error('node.reparent requires nodeId');
    if (newParentRef === null || newParentRef === undefined) throw new Error('node.reparent requires newParentId');
    const freshBranch = this._appendEditBranchEntry(branch, {
      kind: 'node.reparent',
      node_ref: ref,
      new_parent_ref: newParentRef
    });
    return { branch: freshBranch, changed: true, docId };
  }

  stageEditBranchNodeMoveAfter(branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    const targetRef = payload.targetNodeId ?? payload.target_node_id;
    if (ref === null || ref === undefined) throw new Error('node.moveAfter requires nodeId');
    if (targetRef === null || targetRef === undefined) throw new Error('node.moveAfter requires targetNodeId');
    const freshBranch = this._appendEditBranchEntry(branch, {
      kind: 'node.moveAfter',
      node_ref: ref,
      target_ref: targetRef
    });
    return { branch: freshBranch, changed: true, docId };
  }

  stageEditBranchAxiomAdd(branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const tmpId = nextTmpId('axiom');
    const fields = {
      content: typeof payload.content === 'string' ? payload.content : '',
      status: typeof payload.status === 'string' ? payload.status : 'pending',
      node_title: payload.nodeTitle ?? payload.node_title ?? '',
      node_note: payload.nodeNote ?? payload.node_note ?? ''
    };
    const freshBranch = this._appendEditBranchEntry(branch, {
      kind: 'axiom.add',
      tmp_id: tmpId,
      fields
    });
    const after = this._projectedDocForBranch(freshBranch);
    const axiom = this._findProjectedAxiom(after, tmpId);
    return { branch: freshBranch, changed: true, docId, axiom: axiom ? { ...axiom } : null, insertedAxiomId: tmpId };
  }

  stageEditBranchAxiomUpdate(branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.axiomId ?? payload.axiom_id;
    if (ref === null || ref === undefined) throw new Error('axiom.update requires axiomId');
    const rawPatch = payload.patch || payload;
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(rawPatch, 'content')) patch.content = rawPatch.content;
    if (Object.prototype.hasOwnProperty.call(rawPatch, 'status')) patch.status = rawPatch.status;
    if (Object.prototype.hasOwnProperty.call(rawPatch, 'node_title') || Object.prototype.hasOwnProperty.call(rawPatch, 'nodeTitle')) {
      patch.node_title = rawPatch.node_title ?? rawPatch.nodeTitle ?? '';
    }
    if (Object.prototype.hasOwnProperty.call(rawPatch, 'node_note') || Object.prototype.hasOwnProperty.call(rawPatch, 'nodeNote')) {
      patch.node_note = rawPatch.node_note ?? rawPatch.nodeNote ?? '';
    }
    const freshBranch = this._appendEditBranchEntry(branch, {
      kind: 'axiom.update',
      axiom_ref: ref,
      patch
    });
    const after = this._projectedDocForBranch(freshBranch);
    const axiom = this._findProjectedAxiom(after, ref);
    return { branch: freshBranch, changed: true, docId, axiom: axiom ? { ...axiom } : null };
  }

  stageEditBranchAxiomDelete(branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.axiomId ?? payload.axiom_id;
    if (ref === null || ref === undefined) throw new Error('axiom.delete requires axiomId');
    const freshBranch = this._appendEditBranchEntry(branch, {
      kind: 'axiom.delete',
      axiom_ref: ref
    });
    return { branch: freshBranch, changed: true, docId };
  }

  stageEditBranchAxiomMove(branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.axiomId ?? payload.axiom_id;
    if (ref === null || ref === undefined) throw new Error('axiom.move requires axiomId');
    const direction = payload.direction === 'up' ? 'up' : 'down';
    const freshBranch = this._appendEditBranchEntry(branch, {
      kind: 'axiom.move',
      axiom_ref: ref,
      direction
    });
    return { branch: freshBranch, changed: true, docId };
  }

  stageEditBranchRefAddAxiomToNode(branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const nodeRef = payload.nodeId ?? payload.node_id;
    const axiomRef = payload.axiomId ?? payload.axiom_id;
    if (nodeRef === null || nodeRef === undefined) throw new Error('ref.addAxiomToNode requires nodeId');
    if (axiomRef === null || axiomRef === undefined) throw new Error('ref.addAxiomToNode requires axiomId');
    const tmpId = nextTmpId('ref');
    const freshBranch = this._appendEditBranchEntry(branch, {
      kind: 'ref.addAxiomToNode',
      tmp_id: tmpId,
      node_ref: nodeRef,
      axiom_ref: axiomRef,
      note: payload.note ?? null
    });
    return { branch: freshBranch, changed: true, docId, insertedRefId: tmpId };
  }

  stageEditBranchRefAddNodeToNode(branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const sourceRef = payload.sourceNodeId ?? payload.source_node_id ?? payload.nodeId ?? payload.node_id;
    const targetRef = payload.targetNodeId ?? payload.target_node_id;
    const refKind = String(payload.refKind ?? payload.ref_kind ?? payload.kind ?? '').trim();
    if (sourceRef === null || sourceRef === undefined) throw new Error('ref.addNodeToNode requires sourceNodeId');
    if (targetRef === null || targetRef === undefined) throw new Error('ref.addNodeToNode requires targetNodeId');
    if (!refKind) throw new Error('ref.addNodeToNode requires refKind');
    const tmpId = nextTmpId('ref');
    const freshBranch = this._appendEditBranchEntry(branch, {
      kind: 'ref.addNodeToNode',
      tmp_id: tmpId,
      source_ref: sourceRef,
      target_ref: targetRef,
      ref_kind: refKind,
      note: payload.note ?? null
    });
    return { branch: freshBranch, changed: true, docId, insertedRefId: tmpId };
  }

  stageEditBranchRefDelete(branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.refId ?? payload.ref_id;
    if (ref === null || ref === undefined) throw new Error('ref.delete requires refId');
    const freshBranch = this._appendEditBranchEntry(branch, {
      kind: 'ref.delete',
      ref_ref: ref
    });
    return { branch: freshBranch, changed: true, docId };
  }

  applyEditBranchDiffEntries(branch, diff = {}) {
    const entries = activeEditBranchEntries(diff.entries);
    const baseDocId = normalizePositiveId(branch.base_doc_id);
    const nodeIdByTmp = new Map();
    const axiomIdByTmp = new Map();
    const refIdByTmp = new Map();
    const entityIdByTmp = new Map();
    const resolveNodeId = (ref) => {
      if (ref === null || ref === undefined) return null;
      if (isTmpId(ref)) {
        const real = nodeIdByTmp.get(ref);
        if (!real) throw new Error(`apply: unresolved tmp node id ${ref}`);
        return real;
      }
      const id = normalizePositiveId(ref);
      if (!id) throw new Error(`apply: invalid node id ${ref}`);
      return id;
    };
    const resolveAxiomId = (ref) => {
      if (ref === null || ref === undefined) return null;
      if (isTmpId(ref)) {
        const real = axiomIdByTmp.get(ref);
        if (!real) throw new Error(`apply: unresolved tmp axiom id ${ref}`);
        return real;
      }
      const id = normalizePositiveId(ref);
      if (!id) throw new Error(`apply: invalid axiom id ${ref}`);
      return id;
    };
    const resolveRefId = (ref) => {
      if (ref === null || ref === undefined) return null;
      if (isTmpId(ref)) {
        const real = refIdByTmp.get(ref);
        if (!real) throw new Error(`apply: unresolved tmp ref id ${ref}`);
        return real;
      }
      const id = normalizePositiveId(ref);
      if (!id) throw new Error(`apply: invalid ref id ${ref}`);
      return id;
    };
    const resolveEntityId = (ref) => {
      if (ref === null || ref === undefined) return null;
      if (isTmpId(ref)) {
        const real = entityIdByTmp.get(ref);
        if (!real) throw new Error(`apply: unresolved tmp entity id ${ref}`);
        return real;
      }
      const id = normalizePositiveId(ref);
      if (!id) throw new Error(`apply: invalid entity id ${ref}`);
      return id;
    };
    const normalizeEntityKeyForApply = (value = '') => String(value || '').trim().toLocaleLowerCase();
    const orderedEntityPairForApply = (left, right) => {
      const leftId = resolveEntityId(left);
      const rightId = resolveEntityId(right);
      if (!leftId || !rightId || sameStableId(leftId, rightId)) throw new Error('apply: entity link requires two different entity ids');
      return compareStableIds(leftId, rightId) <= 0 ? [leftId, rightId] : [rightId, leftId];
    };

    for (const entry of entries) {
      if (!isSupportedEditBranchEntryKind(entry?.kind)) {
        throw new Error(`Unsupported edit branch diff entry: ${entry?.kind || ''}`);
      }
      switch (entry.kind) {
        case 'node.update': {
          const nodeId = resolveNodeId(entry.node_id);
          this.updateNode(nodeId, entry.patch || {});
          break;
        }
        case 'node.insert': {
          const fields = entry.fields || {};
          const inserted = this.insertNode({
            docId: baseDocId,
            parentId: resolveNodeId(entry.parent_ref),
            afterNodeId: entry.after_ref ? resolveNodeId(entry.after_ref) : null,
            text: fields.text ?? '',
            nodeType: fields.node_type ?? fields.nodeType ?? 'TEXT',
            nodeTitle: fields.node_title ?? fields.nodeTitle ?? '',
            nodeNote: fields.node_note ?? fields.nodeNote ?? '',
            sourcePosition: fields.source_position ?? null
          });
          if (entry.tmp_id) nodeIdByTmp.set(entry.tmp_id, inserted.id);
          break;
        }
        case 'node.delete': {
          this.deleteNodeSubtree(resolveNodeId(entry.target_ref));
          break;
        }
        case 'node.move': {
          this.moveNode(resolveNodeId(entry.target_ref), entry.direction === 'up' ? 'up' : 'down');
          break;
        }
        case 'node.promote': {
          this.promoteNode(resolveNodeId(entry.target_ref));
          break;
        }
        case 'node.split': {
          const targetId = resolveNodeId(entry.target_ref);
          const subtreeIds = this.db.prepare(`
            WITH RECURSIVE subtree(id) AS (
              SELECT id FROM nodes WHERE id = ?
              UNION ALL
              SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
            )
            SELECT id FROM subtree
          `);
          const beforeIds = new Set(subtreeIds.all(targetId).map((row) => String(row.id)));
          this.splitNodeIntoChildren(targetId);
          // Build tmp_id -> real id mapping so later entries that reference
          // the freshly-split children resolve correctly.
          if (entry.strategy === 'source_paragraphs' && Array.isArray(entry.paragraph_splits)) {
            for (const split of entry.paragraph_splits) {
              const realParagraphId = resolveNodeId(split.paragraph_node_id);
              const realChildren = this.db.prepare(`
                SELECT id FROM nodes WHERE parent_id = ?
                ORDER BY sort_order, id
              `).all(realParagraphId);
              const newChildren = realChildren.filter((row) => !beforeIds.has(String(row.id)));
              const spans = Array.isArray(split.spans) ? split.spans : [];
              spans.forEach((span, position) => {
                const row = newChildren[position];
                if (span?.tmp_id && row) nodeIdByTmp.set(span.tmp_id, row.id);
              });
            }
          } else if (entry.strategy === 'split_sentences' && Array.isArray(entry.new_node_ids)) {
            const realChildren = this.db.prepare(`
              SELECT id FROM nodes WHERE parent_id = ?
              ORDER BY sort_order, id
            `).all(targetId);
            const newChildren = realChildren.filter((row) => !beforeIds.has(String(row.id)));
            entry.new_node_ids.forEach((tmpId, position) => {
              const row = newChildren[position];
              if (tmpId && row) nodeIdByTmp.set(tmpId, row.id);
            });
          }
          break;
        }
        case 'node.mergeInto': {
          this.mergeNodeIntoTarget({
            nodeId: resolveNodeId(entry.source_ref),
            targetNodeId: resolveNodeId(entry.target_ref)
          });
          break;
        }
        case 'node.mergePrevious': {
          this.mergeNodeIntoPreviousSibling(resolveNodeId(entry.source_ref ?? entry.target_ref));
          break;
        }
        case 'node.reparent': {
          this.moveNodeToParent({
            nodeId: resolveNodeId(entry.node_ref),
            newParentId: resolveNodeId(entry.new_parent_ref)
          });
          break;
        }
        case 'node.moveBefore': {
          this.moveNodeBeforeSibling({
            nodeId: resolveNodeId(entry.node_ref),
            targetNodeId: resolveNodeId(entry.target_ref)
          });
          break;
        }
        case 'node.moveAfter': {
          this.moveNodeAfterSibling({
            nodeId: resolveNodeId(entry.node_ref),
            targetNodeId: resolveNodeId(entry.target_ref)
          });
          break;
        }
        case 'axiom.add': {
          const fields = entry.fields || {};
          const created = this.addAxiom({
            docId: baseDocId,
            content: fields.content ?? '',
            status: fields.status ?? 'pending',
            nodeTitle: fields.node_title ?? '',
            nodeNote: fields.node_note ?? ''
          });
          if (entry.tmp_id) axiomIdByTmp.set(entry.tmp_id, created.id);
          break;
        }
        case 'axiom.update': {
          this.updateAxiom(resolveAxiomId(entry.axiom_ref), entry.patch || {});
          break;
        }
        case 'axiom.delete': {
          this.deleteAxiom(resolveAxiomId(entry.axiom_ref));
          break;
        }
        case 'axiom.move': {
          this.moveAxiom({
            docId: baseDocId,
            axiomId: resolveAxiomId(entry.axiom_ref),
            direction: entry.direction === 'up' ? 'up' : 'down'
          });
          break;
        }
        case 'ref.addAxiomToNode': {
          const created = this.addAxiomRefToNode({
            docId: baseDocId,
            nodeId: resolveNodeId(entry.node_ref),
            axiomId: resolveAxiomId(entry.axiom_ref),
            note: entry.note ?? null
          });
          if (entry.tmp_id) refIdByTmp.set(entry.tmp_id, created.id);
          break;
        }
        case 'ref.addNodeToNode': {
          const created = this.addNodeRefToNode({
            docId: baseDocId,
            sourceNodeId: resolveNodeId(entry.source_ref),
            targetNodeId: resolveNodeId(entry.target_ref),
            refKind: entry.ref_kind,
            note: entry.note ?? null
          });
          if (entry.tmp_id) refIdByTmp.set(entry.tmp_id, created.id);
          break;
        }
        case 'ref.delete': {
          this.deleteRef(resolveRefId(entry.ref_ref));
          break;
        }
        case 'entity.create': {
          const fields = entry.fields || {};
          const docId = normalizePositiveId(fields.doc_id || baseDocId);
          const literal = String(fields.literal || '').trim();
          const key = normalizeEntityKeyForApply(fields.normalized_literal || literal);
          if (!literal || !key || !docId) throw new Error('apply: invalid entity.create entry');
          let row = this.db.prepare('SELECT id FROM entities WHERE doc_id = ? AND normalized_literal = ?').get(docId, key);
          if (row) {
            this.db.prepare('UPDATE entities SET literal = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(literal, row.id);
          } else {
            this.db.prepare(`
              INSERT INTO entities (id, doc_id, literal, normalized_literal)
              VALUES (?, ?, ?, ?)
            `).run(newStableId(), docId, literal, key);
            row = this.db.prepare('SELECT id FROM entities WHERE doc_id = ? AND normalized_literal = ?').get(docId, key);
          }
          if (entry.tmp_id) entityIdByTmp.set(entry.tmp_id, row.id);
          break;
        }
        case 'entity.update': {
          const entityId = resolveEntityId(entry.entity_ref);
          const literal = String(entry.literal || '').trim();
          const key = normalizeEntityKeyForApply(entry.normalized_literal || literal);
          if (!literal || !key) throw new Error('apply: invalid entity.update entry');
          this.db.prepare(`
            UPDATE entities
            SET literal = ?,
              normalized_literal = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(literal, key, entityId);
          break;
        }
        case 'entity.delete': {
          this.db.prepare('DELETE FROM entities WHERE id = ?').run(resolveEntityId(entry.entity_ref));
          break;
        }
        case 'entity.link': {
          const [leftId, rightId] = orderedEntityPairForApply(entry.source_ref, entry.target_ref);
          const kind = entry.link_kind === 'synonym' ? 'synonym' : entry.link_kind === 'related' ? 'related' : '';
          if (!kind) throw new Error('apply: invalid entity.link kind');
          const existing = this.db.prepare(`
            SELECT id FROM entity_links
            WHERE entity_a_id = ? AND entity_b_id = ?
          `).get(leftId, rightId);
          if (existing) {
            this.db.prepare(`
              UPDATE entity_links
              SET kind = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(kind, existing.id);
          } else {
            this.db.prepare(`
              INSERT INTO entity_links (kind, entity_a_id, entity_b_id)
              VALUES (?, ?, ?)
            `).run(kind, leftId, rightId);
          }
          break;
        }
        case 'entity.unlink': {
          const [leftId, rightId] = orderedEntityPairForApply(entry.source_ref, entry.target_ref);
          if (entry.link_kind) {
            this.db.prepare(`
              DELETE FROM entity_links
              WHERE entity_a_id = ? AND entity_b_id = ? AND kind = ?
            `).run(leftId, rightId, entry.link_kind);
          } else {
            this.db.prepare(`
              DELETE FROM entity_links
              WHERE entity_a_id = ? AND entity_b_id = ?
            `).run(leftId, rightId);
          }
          break;
        }
        case 'entity.bindNode':
        case 'entity.ignoreNode': {
          const entityId = resolveEntityId(entry.entity_ref);
          const nodeId = resolveNodeId(entry.node_id);
          const status = entry.kind === 'entity.bindNode' ? 'bound' : 'ignored';
          this.db.prepare(`
            INSERT INTO entity_node_bindings (entity_id, node_id, status)
            VALUES (?, ?, ?)
            ON CONFLICT(entity_id, node_id) DO UPDATE SET
              status = excluded.status,
              updated_at = CURRENT_TIMESTAMP
          `).run(entityId, nodeId, status);
          break;
        }
        case 'entity.clearNodeBinding': {
          this.db.prepare(`
            DELETE FROM entity_node_bindings
            WHERE entity_id = ? AND node_id = ?
          `).run(resolveEntityId(entry.entity_ref), resolveNodeId(entry.node_id));
          break;
        }
        default:
          throw new Error(`Unhandled edit branch diff entry kind: ${entry.kind}`);
      }
    }
  }

  beginEditBranch(docId, owner = 'human') {
    const normalizedDocId = normalizePositiveId(docId);
    const normalizedOwner = this.normalizeEditBranchOwner(owner);
    if (!normalizedDocId) throw new Error('beginEditBranch requires docId');

    const shadowExisting = this.activeEditBranchForShadowDoc(normalizedDocId);
    if (shadowExisting && shadowExisting.owner === normalizedOwner) return shadowExisting;
    const existing = this.activeEditBranchForBaseDoc(normalizedDocId, normalizedOwner);
    if (existing && existing.owner === normalizedOwner) return existing;

    const head = this.db.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?').get(normalizedDocId);
    const baseSnapshot = createLazyEditBranchBaseSnapshot({
      owner: normalizedOwner,
      baseDocId: normalizedDocId,
      shadowDocId: normalizedDocId,
      baseCommitId: head?.head_commit_id || null
    });
    const diff = createEmptyEditBranchDiff({
      owner: normalizedOwner,
      baseDocId: normalizedDocId,
      shadowDocId: normalizedDocId
    });
    const result = this.db.prepare(`
      INSERT INTO edit_branches (base_doc_id, shadow_doc_id, owner, base_snapshot, diff)
      VALUES (?, ?, ?, ?, ?)
    `).run(normalizedDocId, normalizedDocId, normalizedOwner, JSON.stringify(baseSnapshot), JSON.stringify(diff));
    return this.db.prepare('SELECT * FROM edit_branches WHERE id = ?').get(Number(result.lastInsertRowid));
  }

  findEditBranch({ branchId = null, shadowDocId = null, baseDocId = null, owner = 'human' } = {}) {
    const normalizedOwner = owner == null ? null : this.normalizeEditBranchOwner(owner);
    const acceptOwner = (branch) => (
      branch && (!normalizedOwner || branch.owner === normalizedOwner) ? branch : null
    );
    if (branchId) {
      return acceptOwner(this.db.prepare("SELECT * FROM edit_branches WHERE id = ? AND status = 'active'").get(Number(branchId))) || null;
    }
    if (shadowDocId) return acceptOwner(this.activeEditBranchForShadowDoc(shadowDocId));
    if (baseDocId) return this.activeEditBranchForBaseDoc(baseDocId, normalizedOwner || 'human');
    return null;
  }

  rebaseEditBranch({ branchId = null, shadowDocId = null, baseDocId = null, owner = 'human' } = {}) {
    const branch = this.findEditBranch({ branchId, shadowDocId, baseDocId, owner });
    if (!branch) throw new Error('Edit branch not found');
    const head = this.db.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?').get(branch.base_doc_id);
    const previousBaseSnapshot = JSON.parse(branch.base_snapshot || '{}');
    const now = new Date().toISOString();
    const baseSnapshot = {
      ...createLazyEditBranchBaseSnapshot({
        owner: branch.owner,
        baseDocId: branch.base_doc_id,
        shadowDocId: branch.shadow_doc_id,
        baseCommitId: head?.head_commit_id || null
      }),
      rebasedAt: now,
      previousBaseCommitId: previousBaseSnapshot.baseCommitId || null
    };
    this.db.prepare(`
      UPDATE edit_branches
      SET base_snapshot = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(baseSnapshot), branch.id);
    const freshBranch = this.db.prepare('SELECT * FROM edit_branches WHERE id = ?').get(branch.id);
    return {
      changed: true,
      branch: freshBranch,
      baseCommitId: baseSnapshot.baseCommitId,
      ...this.editBranchHistoryState(freshBranch)
    };
  }

  cherryPickEditBranchEntries({
    sourceHistoryId = null,
    sourceBranchId = null,
    targetBranchId = null,
    targetBaseDocId = null,
    targetOwner = 'human',
    entryId = null,
    entryIndex = null
  } = {}) {
    const source = this._cherryPickSource({ sourceHistoryId, sourceBranchId });
    const selectedEntries = this._selectCherryPickEntries(source.entries, { entryId, entryIndex });
    if (selectedEntries.length === 0) throw new Error('cherry-pick found no entries');
    const targetBranch = targetBranchId
      ? this.findEditBranch({ branchId: targetBranchId, owner: null })
      : this.beginEditBranch(targetBaseDocId || source.docId, targetOwner);
    if (!targetBranch) throw new Error('Target edit branch not found');
    if (!sameStableId(targetBranch.base_doc_id, source.docId)) {
      throw new Error('cherry-pick source and target must belong to the same document');
    }
    let branch = targetBranch;
    const picked = [];
    for (const entry of selectedEntries) {
      const copy = this._copyCherryPickEntry(entry, source);
      branch = this._appendEditBranchEntry(branch, copy);
      picked.push(copy);
    }
    return {
      changed: picked.length > 0,
      baseDocId: branch.base_doc_id,
      branchId: branch.id,
      owner: branch.owner,
      pickedCount: picked.length,
      branch,
      picked
    };
  }

  _cherryPickSource({ sourceHistoryId = null, sourceBranchId = null } = {}) {
    if (sourceBranchId) {
      const branch = this.findEditBranch({ branchId: sourceBranchId, owner: null });
      if (!branch) throw new Error(`Source edit branch not found: ${sourceBranchId}`);
      const diff = JSON.parse(branch.diff || '{}');
      return {
        kind: 'branch',
        id: branch.id,
        docId: branch.base_doc_id,
        entries: activeEditBranchEntries(diff.entries)
      };
    }
    if (sourceHistoryId) {
      const history = this.db.prepare('SELECT * FROM save_history WHERE id = ?').get(sourceHistoryId);
      if (!history) throw new Error(`History entry not found: ${sourceHistoryId}`);
      const diff = JSON.parse(history.diff || '{}');
      const entries = activeEditBranchEntries(diff.entries);
      if (entries.length === 0 && Array.isArray(diff.entries) && diff.entries.length > 0) {
        throw new Error('cherry-pick history entry does not contain edit-branch entries');
      }
      return {
        kind: 'history',
        id: history.id,
        docId: history.doc_id,
        entries
      };
    }
    throw new Error('cherry-pick requires sourceHistoryId or sourceBranchId');
  }

  _selectCherryPickEntries(entries = [], { entryId = null, entryIndex = null } = {}) {
    if (entryId !== null && entryId !== undefined && entryId !== '') {
      const text = String(entryId);
      return entries.filter((entry) => (
        String(entry.id ?? entry.entryId ?? entry.createdAt ?? '') === text
      ));
    }
    if (entryIndex !== null && entryIndex !== undefined && entryIndex !== '') {
      const index = Number(entryIndex);
      if (!Number.isInteger(index) || index < 0) throw new Error('cherry-pick entryIndex must be a zero-based integer');
      return entries[index] ? [entries[index]] : [];
    }
    return entries;
  }

  _copyCherryPickEntry(entry = {}, source = {}) {
    const { status: _status, undoneAt: _undoneAt, ...rest } = entry;
    return {
      ...rest,
      createdAt: new Date().toISOString(),
      cherryPickedFrom: {
        kind: source.kind,
        id: source.id,
        entryCreatedAt: entry.createdAt || null
      }
    };
  }

  saveEditBranch({ branchId = null, shadowDocId = null, baseDocId = null, owner = 'human', summary = '保存编辑分支' } = {}) {
    const branch = this.findEditBranch({ branchId, shadowDocId, baseDocId, owner });
    if (!branch) throw new Error('Edit branch not found');
    const rawPayload = JSON.parse(branch.diff || '{}');
    const entries = activeEditBranchEntries(rawPayload.entries);
    const payload = { ...rawPayload, entries };
    const hasEffectiveDiff = entries.length > 0;

    return this.withTransaction(() => {
      if (hasEffectiveDiff) {
        this.applyEditBranchDiffEntries(branch, payload);
        const currentSnapshot = this.createSnapshot(branch.base_doc_id);
        const commitPayload = {
          ...payload,
          kind: 'diff',
          savedFromEditBranch: true,
          snapshot: currentSnapshot
        };
        const commit = this.createCommit({
          docId: branch.base_doc_id,
          summary,
          diff: commitPayload,
          snapshot: currentSnapshot
        });
        this.db.prepare(`
          INSERT INTO save_history (doc_id, commit_id, summary, diff)
          VALUES (?, ?, ?, ?)
        `).run(branch.base_doc_id, commit.id, summary, JSON.stringify(commitPayload));
      }

      this.db.prepare('DELETE FROM edit_branches WHERE id = ?').run(branch.id);
      if (hasEffectiveDiff) this.touchDoc(branch.base_doc_id);

      return {
        changed: hasEffectiveDiff,
        baseDocId: branch.base_doc_id,
        branchId: branch.id,
        owner: branch.owner,
        history: hasEffectiveDiff
          ? this.db.prepare(`
            SELECT id, doc_id, commit_id, saved_at, summary
            FROM save_history
            WHERE doc_id = ?
            ORDER BY id DESC
            LIMIT 1
          `).get(branch.base_doc_id)
          : null
      };
    });
  }

  discardEditBranch({ branchId = null, shadowDocId = null, baseDocId = null, owner = 'human' } = {}) {
    const branch = this.findEditBranch({ branchId, shadowDocId, baseDocId, owner });
    if (!branch) return false;
    // Lazy mode: base tables are never modified during the edit session, so
    // discarding the branch simply drops the staged entries.
    this.db.prepare('DELETE FROM edit_branches WHERE id = ?').run(branch.id);
    return true;
  }

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
        meta: JSON.stringify({ sourcePath, importedAt: new Date().toISOString() })
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
      this.refreshNodeStructureMetadataChain(chapter.id);

      return { ...doc, importedNodeIds, importedNodeIdsByRecordIndex };
    });
  }

  createDocFromStructuredRecords({ title, sourcePath, records }) {
    return this.withTransaction(() => {
      const doc = this.createDoc({
        title,
        rootText: title,
        meta: JSON.stringify({ sourcePath, importedAt: new Date().toISOString(), structured: true })
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
    const activeBranch = this.activeEditBranchForBaseDoc(docId, 'human')
      || this.activeEditBranchForBaseDoc(docId, 'llm');
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

  getSubtreeTextWindow({ docId, nodeId, offset = 0, limit = 1000, charLimit = 0 } = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    const normalizedNodeId = normalizePositiveId(nodeId);
    if (normalizedDocId === null || normalizedNodeId === null) {
      return { rows: [], offset: 0, nextOffset: 0, limit: 0, hasMore: false, totalTextChars: null, totalLineCount: null };
    }
    const root = this.db.prepare(`
      SELECT id, address, source_position
      FROM nodes
      WHERE doc_id = ? AND id = ?
    `).get(normalizedDocId, normalizedNodeId);
    const rootAddress = String(root?.address || '').trim();
    if (!root || !rootAddress) {
      return { rows: [], offset: 0, nextOffset: 0, limit: 0, hasMore: false, totalTextChars: null, totalLineCount: null };
    }
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const safeLimit = Math.min(1000, Math.max(1, Math.floor(Number(limit) || 1000)));
    const safeCharLimit = Math.max(1, Math.floor(Number(charLimit) || 1));
    const prefix = `${rootAddress}-%`;
    const orderBySource = Number.isFinite(Number(root.source_position));
    const rows = this.db.prepare(`
      WITH selected_nodes AS (
        SELECT *
        FROM nodes
        WHERE doc_id = ?
          AND (address = ? OR address LIKE ?)
        ORDER BY ${orderBySource
          ? `id = ${normalizedNodeId} DESC, source_position IS NULL, source_position, id`
          : `id = ${normalizedNodeId} DESC, id`}
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
        ? `selected_nodes.id = ${normalizedNodeId} DESC, selected_nodes.source_position IS NULL, selected_nodes.source_position, selected_nodes.id`
        : `selected_nodes.id = ${normalizedNodeId} DESC, selected_nodes.id`}
    `).all(normalizedDocId, rootAddress, prefix, safeLimit + 1, safeOffset, normalizedDocId);
    const pageRows = rows.slice(0, safeLimit);
    return {
      rows: pageRows,
      offset: safeOffset,
      nextOffset: safeOffset + pageRows.length,
      limit: safeLimit,
      charLimit: safeCharLimit,
      textChars: pageRows.reduce((sum, row) => sum + String(row.node_title || '').length + String(row.text || '').length + String(row.node_note || '').length, 0),
      hasMore: rows.length > pageRows.length,
      totalTextChars: null,
      totalLineCount: null
    };
  }

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

  getSourceWindow({ docId, nodeId = null, startOffset = null, limit = 80000, before = 12000, spansLimit = 8000 } = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    if (!normalizedDocId) return null;

    const source = this.db.prepare(`
      SELECT doc_id, source_type, original_path, created_at, LENGTH(raw_markdown) AS raw_length
      FROM source_documents
      WHERE doc_id = ?
    `).get(normalizedDocId);
    if (!source) return null;

    const totalLength = Math.max(0, Number(source.raw_length) || 0);
    const safeLimit = Math.min(160000, Math.max(4000, Math.floor(Number(limit) || 80000)));
    const safeBefore = Math.min(safeLimit - 1, Math.max(0, Math.floor(Number(before) || 0)));
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
    const windowStart = Math.max(0, Math.min(anchor - safeBefore, Math.max(0, totalLength - safeLimit)));
    const windowEnd = Math.min(totalLength, windowStart + safeLimit);
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

  getPdfHighlightRects(docId, startOffset, endOffset) {
    const start = Number(startOffset);
    const end = Number(endOffset);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    const chars = this.db.prepare(`
      SELECT page_number, x0, y0, x1, y1
      FROM source_pdf_chars
      WHERE doc_id = ?
        AND char_offset >= ?
        AND char_offset < ?
      ORDER BY page_number, char_offset
    `).all(docId, start, end);
    return mergePdfCharRects(chars);
  }

  getPdfSpanHitRects(docId) {
    const normalizedDocId = requireStableId(docId, 'docId');
    const spans = this.db.prepare(`
      SELECT id, node_id, sentence_index, start_offset, end_offset
      FROM source_spans
      WHERE doc_id = ?
      ORDER BY start_offset, end_offset, sentence_index, id
    `).all(normalizedDocId);
    if (spans.length === 0) return [];
    const chars = this.db.prepare(`
      SELECT char_offset, page_number, x0, y0, x1, y1
      FROM source_pdf_chars
      WHERE doc_id = ?
      ORDER BY char_offset
    `).all(normalizedDocId);
    const rows = [];
    const lowerBoundCharOffset = (target) => {
      let left = 0;
      let right = chars.length;
      while (left < right) {
        const middle = Math.floor((left + right) / 2);
        if (Number(chars[middle].char_offset) < target) left = middle + 1;
        else right = middle;
      }
      return left;
    };
    for (const span of spans) {
      const start = Number(span.start_offset);
      const end = Number(span.end_offset);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const spanChars = [];
      let cursor = lowerBoundCharOffset(start);
      while (cursor < chars.length && Number(chars[cursor].char_offset) < end) {
        spanChars.push(chars[cursor]);
        cursor += 1;
      }
      for (const rect of mergePdfCharRects(spanChars)) {
        rows.push({
          span_id: span.id,
          node_id: span.node_id,
          sentence_index: span.sentence_index,
          start_offset: span.start_offset,
          end_offset: span.end_offset,
          ...rect
        });
      }
    }
    return rows;
  }

  insertNode({ docId, parentId, text = '', nodeType = 'TEXT', nodeTitle = '', nodeNote = '', sourcePosition = null, afterNodeId = null }) {
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
      INSERT INTO nodes (id, doc_id, parent_id, sort_order, node_type, text, node_title, node_note, source_position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(nodeId, docId, parentId, insertOrder, normalizedNodeType, text, nodeTitle || '', nodeNote || '', normalizeSourcePosition(sourcePosition));

    this.refreshAddressScopes(docId, [parentId]);
    this.refreshNodeStructureMetadataChain(nodeId);
    this.touchDoc(docId);
    if (parentId !== null) this.clearMergedSizeCacheForNodeAndAncestors(parentId);
    return this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
  }

  updateNode(nodeId, patch) {
    assertNoHumanTagField(patch, 'updateNode patch');
    const current = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    if (!current) throw new Error(`Node not found: ${nodeId}`);
    const hasContentSizePatch = ['text', 'node_title', 'nodeTitle', 'node_note', 'nodeNote', 'node_type', 'nodeType']
      .some((key) => Object.prototype.hasOwnProperty.call(patch || {}, key));

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
    if (hasContentSizePatch) {
      this.refreshNodeStructureMetadataChain(nodeId);
    }
    return this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
  }

  deleteNodeSubtree(nodeId) {
    const node = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    if (!node) return false;
    if (node.parent_id === null) throw new Error('Cannot delete document root node');

    this.withTransaction(() => {
      this.clearMergedSizeCacheForNodeAndAncestors(node.parent_id);
      this.db.prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
      this.normalizeSiblingOrder(node.doc_id, node.parent_id);
      this.refreshAddressScopes(node.doc_id, [node.parent_id]);
      this.refreshNodeStructureMetadataChain(node.parent_id);
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
      this.clearMergedSizeCacheForNodeAndAncestors(node.parent_id);
      this.refreshAddressScopes(node.doc_id, [node.parent_id]);
      this.refreshNodeStructureMetadataChain(node.parent_id);
      this.touchDoc(node.doc_id);
    });
    return true;
  }

  splitNodeIntoChildren(nodeId) {
    const node = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    if (this.splitSourceParagraphsIntoSentenceChildren(node)) return true;

    const sentences = splitSentences(node.text);
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
      this.clearMergedSizeCacheForNodeAndAncestors(nodeId);
      this.refreshAddressScopes(node.doc_id, [nodeId]);
      this.refreshNodeStructureMetadataChain(nodeId);
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
      this.clearMergedSizeCacheForNodeAndAncestors(rootNode.id);
      this.refreshAddressScopes(rootNode.doc_id, targetRows.map((target) => target.node.id));
      this.refreshNodeStructureMetadataChains(targetRows.map((target) => target.node.id));
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
      this.db.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
      this.normalizeSiblingOrder(node.doc_id, node.parent_id);
      this.normalizeSiblingOrder(node.doc_id, previous.id);
      this.clearMergedSizeCacheForNodeAndAncestors(previous.id);
      this.clearMergedSizeCacheForNodeAndAncestors(node.parent_id);
      this.refreshAddressScopes(node.doc_id, [node.parent_id, previous.id]);
      this.refreshNodeStructureMetadataChains([previous.id, node.parent_id]);
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
      this.db.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
      this.normalizeSiblingOrder(node.doc_id, oldParentId);
      this.normalizeSiblingOrder(node.doc_id, target.id);
      this.clearMergedSizeCacheForNodeAndAncestors(target.id);
      this.clearMergedSizeCacheForNodeAndAncestors(oldParentId);
      this.refreshAddressScopes(node.doc_id, [oldParentId, target.id]);
      this.refreshNodeStructureMetadataChains([target.id, oldParentId]);
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
      this.clearMergedSizeCacheForNodeAndAncestors(parent.id);
      this.clearMergedSizeCacheForNodeAndAncestors(parent.parent_id);
      this.refreshAddressScopes(node.doc_id, [parent.id, parent.parent_id]);
      this.refreshNodeStructureMetadataChains([node.id, parent.id, parent.parent_id]);
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
      this.clearMergedSizeCacheForNodeAndAncestors(oldParentId);
      this.clearMergedSizeCacheForNodeAndAncestors(newParent.id);
      this.refreshAddressScopes(node.doc_id, [oldParentId, newParent.id]);
      this.refreshNodeStructureMetadataChains([node.id, oldParentId, newParent.id]);
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
      this.clearMergedSizeCacheForNodeAndAncestors(node.parent_id);
      this.clearMergedSizeCacheForNodeAndAncestors(target.parent_id);
      this.refreshAddressScopes(node.doc_id, [node.parent_id, target.parent_id]);
      this.refreshNodeStructureMetadataChains([node.id, node.parent_id, target.parent_id]);
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
      this.clearMergedSizeCacheForNodeAndAncestors(oldParentId);
      this.clearMergedSizeCacheForNodeAndAncestors(target.parent_id);
      this.refreshAddressScopes(node.doc_id, [oldParentId, target.parent_id]);
      this.refreshNodeStructureMetadataChains([node.id, oldParentId, target.parent_id]);
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
    const byParent = new Map();
    for (const row of rows) {
      const key = row.parent_id === null || row.parent_id === undefined ? '' : String(row.parent_id);
      const siblings = byParent.get(key) || [];
      siblings.push(row);
      byParent.set(key, siblings);
    }
    const firstLine = (value = '') => String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
    const headingText = (node = {}) => firstLine(node.node_title) || firstLine(node.text) || String(node.address || node.id || '').trim();
    const lines = [`# ${firstLine(doc.title) || `doc ${normalizedDocId}`}`];
    const emitNode = (node) => {
      const children = byParent.get(String(node.id)) || [];
      const heading = headingText(node);
      const level = Math.max(2, Math.min(6, Number(node.depth) || 2));
      if (heading) lines.push('', `${'#'.repeat(level)} ${heading}`);
      const body = String(node.text || '').trim();
      if (body && body !== heading) lines.push('', body);
      const note = String(node.node_note || '').trim();
      if (note) lines.push('', note);
      for (const child of children) emitNode(child);
    };
    const roots = byParent.get('') || [];
    if (roots.length === 0) return `${lines.join('\n').trimEnd()}\n`;
    const primaryRoot = roots[0];
    const rootChildren = byParent.get(String(primaryRoot.id)) || [];
    const rootBody = String(primaryRoot.text || '').trim();
    const rootHeading = headingText(primaryRoot);
    if (rootBody && rootBody !== rootHeading) lines.push('', rootBody);
    const startNodes = rootChildren.length ? rootChildren : roots;
    for (const child of startNodes) emitNode(child);
    return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
  }

  listHistory(docId) {
    return this.db.prepare(`
      SELECT id, doc_id, commit_id, saved_at, summary
      FROM save_history
      WHERE doc_id = ?
      ORDER BY saved_at DESC, id DESC
    `).all(docId);
  }

  createCommit({ docId, summary = null, diff = {}, snapshot = {}, committedAt = null }) {
    const normalizedDocId = requireStableId(docId, 'commit docId');
    const head = this.db.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?').get(normalizedDocId);
    const commitId = newStableId();
    this.db.prepare(`
      INSERT INTO commits (id, doc_id, parent_commit_id, committed_at, summary, diff, snapshot)
      VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?)
    `).run(
      commitId,
      normalizedDocId,
      head?.head_commit_id || null,
      committedAt,
      summary,
      typeof diff === 'string' ? diff : JSON.stringify(diff || {}),
      typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot || {})
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

  saveHistorySnapshot({ docId, summary = '保存版本' }) {
    return this.withTransaction(() => {
      const currentSnapshot = this.createSnapshot(docId);

      const lastSave = this.db.prepare(`
        SELECT diff FROM save_history
        WHERE doc_id = ?
        ORDER BY id DESC LIMIT 1
      `).get(docId);

      const entries = [];
      if (lastSave) {
        try {
          const prev = JSON.parse(lastSave.diff || '{}');
          const prevSnapshot = prev.snapshot || (prev.kind === 'snapshot' ? prev : null);
          if (prevSnapshot?.nodes) {
            entries.push(...this.computeDiff(prevSnapshot, currentSnapshot));
          }
        } catch { /* ignore parse errors, treat as first save */ }
      }

      const payload = {
        kind: 'diff',
        entries,
        snapshot: currentSnapshot
      };
      const commit = this.createCommit({
        docId,
        summary,
        diff: payload,
        snapshot: currentSnapshot
      });
      const result = this.db.prepare(`
        INSERT INTO save_history (doc_id, summary, diff)
        VALUES (?, ?, ?)
      `).run(docId, summary, JSON.stringify(payload));
      this.db.prepare('UPDATE save_history SET commit_id = ? WHERE id = ?').run(commit.id, Number(result.lastInsertRowid));
      return this.db.prepare('SELECT id, doc_id, commit_id, saved_at, summary FROM save_history WHERE id = ?')
        .get(Number(result.lastInsertRowid));
    });
  }

  computeDiff(prevSnapshot, currentSnapshot) {
    return computeSnapshotDiff(prevSnapshot, currentSnapshot);
  }

  restoreHistory(historyId) {
    const history = this.db.prepare('SELECT * FROM save_history WHERE id = ?').get(historyId);
    if (!history) throw new Error(`History entry not found: ${historyId}`);

    const payload = JSON.parse(history.diff || '{}');
    const snapshot = payload.snapshot || (payload.kind === 'snapshot' ? payload : null);
    if (!snapshot?.nodes) {
      throw new Error(`History entry is not restorable: ${historyId}`);
    }

    this.restoreSnapshot(history.doc_id, snapshot);
    return true;
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

  createEditorSnapshotToken(docId) {
    const normalizedDocId = normalizePositiveId(docId);
    if (!normalizedDocId) {
      throw new Error('editor history requires docId');
    }
    const snapshot = this.createSnapshot(normalizedDocId);
    this.assertRestorableSnapshot(snapshot);
    const tokenId = `editor-${this.editorSnapshotSeq++}`;
    this.editorSnapshotTokens.set(tokenId, {
      docId: normalizedDocId,
      snapshot
    });
    return { id: tokenId, docId: normalizedDocId };
  }

  restoreEditorSnapshotToken({ docId, tokenId }) {
    const normalizedDocId = normalizePositiveId(docId);
    const normalizedTokenId = String(tokenId || '');
    const entry = this.editorSnapshotTokens.get(normalizedTokenId);
    if (!entry) throw new Error('Editor history token not found');
    if (!sameStableId(entry.docId, normalizedDocId)) throw new Error('Editor history token belongs to another document');

    const redoToken = this.createEditorSnapshotToken(normalizedDocId);
    this.restoreSnapshot(normalizedDocId, entry.snapshot);
    this.editorSnapshotTokens.delete(normalizedTokenId);
    return redoToken;
  }

  discardEditorSnapshotTokens(tokenIds = []) {
    const ids = Array.isArray(tokenIds) ? tokenIds : [tokenIds];
    let deleted = 0;
    for (const tokenId of ids) {
      if (this.editorSnapshotTokens.delete(String(tokenId || ''))) deleted += 1;
    }
    return deleted;
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

      this.insertSnapshotNodes(snapshotNodes);
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

  insertSnapshotNodes(nodes) {
    const remaining = [...nodes];
    const inserted = new Set();
    const insertNode = this.db.prepare(`
      INSERT INTO nodes (
        id, doc_id, parent_id, sort_order, node_type, text, node_title, node_note, source_position,
        trust_level, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    while (remaining.length > 0) {
      const before = remaining.length;
      for (let index = remaining.length - 1; index >= 0; index -= 1) {
        const node = remaining[index];
        if (node.parent_id !== null && !inserted.has(node.parent_id)) continue;
        insertNode.run(
          node.id,
          node.doc_id,
          node.parent_id,
          node.sort_order,
          normalizeNodeType(node.node_type),
          node.text,
          node.node_title || '',
          node.node_note || '',
          normalizeSourcePosition(node.source_position),
          node.trust_level,
          node.created_at,
          node.updated_at
        );
        inserted.add(node.id);
        remaining.splice(index, 1);
      }
      if (remaining.length === before) throw new Error('Snapshot contains unresolved node parents');
    }
  }

  clearLineStatsForNode(_nodeId) {
    // line_count / line_width_sum columns have been removed — no-op
  }

  clearMergedSizeCacheForNodeAndAncestors(_nodeId) {
    // node_merged_width / node_merged_height / subtree_line_count / subtree_line_width_sum columns have been removed — no-op
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
