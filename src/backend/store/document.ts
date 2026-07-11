// 文档与目录的通用持久化（L2）：生命周期、归档位置与文档级设置。

import type Database from 'better-sqlite3';
import { newStableId } from '../db/ids.js';
import { normalizeDocFolderName, normalizeTreeViewState } from '../db/normalizers.js';
import type { DocFolderRow, DocRow } from '../db/schema.js';
import type { StoreDomainPorts } from './domain-port.js';
import * as history from './history.js';

type CountRow = { count: number };
type DocListRow = DocRow & { node_count: number };
export type FolderPatch = { name?: unknown; parentId?: unknown };
export type CreateDocInput = {
  title: string;
  rootText?: unknown;
  meta?: unknown;
  folderId?: unknown;
  skipInitialCommit?: boolean;
};
export type CreatedDoc = { id: string; title: string; rootNodeId: string };

export interface DocumentStore extends history.HistoryStore {
  db: Database | null;
  domainPorts: StoreDomainPorts;
  refreshDocAddresses(docId: unknown): { updated: number };
  withTransaction<T>(fn: () => T): T;
}

function hasEditBranchesTable(store: DocumentStore) {
  try {
    return Boolean(store.db!.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'edit_branches'").get());
  } catch {
    return false;
  }
}

export function listDocs(store: DocumentStore) {
  const shadowFilter = hasEditBranchesTable(store)
    ? `WHERE NOT EXISTS (
      SELECT 1 FROM edit_branches eb
      WHERE eb.shadow_doc_id = d.id AND eb.status = 'active'
        AND eb.shadow_doc_id != eb.base_doc_id
    )`
    : '';
  return store.db!.prepare(`
    SELECT
      d.*,
      (SELECT COUNT(*) FROM nodes n WHERE n.doc_id = d.id) AS node_count
    FROM docs d
    ${shadowFilter}
    ORDER BY d.folder_id IS NOT NULL, d.folder_id, d.doc_sort_order, d.updated_at DESC, d.id DESC
  `).all<DocListRow>();
}

export function listDocFolders(store: DocumentStore) {
  return store.db!.prepare(`
    SELECT * FROM doc_folders
    ORDER BY parent_id IS NOT NULL, parent_id, sort_order, name, id
  `).all<DocFolderRow>();
}

export function getDocFolder(store: DocumentStore, folderId: unknown) {
  const id = Number(folderId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return store.db!.prepare('SELECT * FROM doc_folders WHERE id = ?').get<DocFolderRow>(id) || null;
}

export function normalizeFolderId(store: DocumentStore, folderId: unknown) {
  if (folderId === null || folderId === undefined || folderId === '') return null;
  const id = Number(folderId);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid document folder id: ${folderId}`);
  const folder = getDocFolder(store, id);
  if (!folder) throw new Error(`Document folder not found: ${folderId}`);
  return folder.id;
}

export function nextFolderSortOrder(store: DocumentStore, parentId: unknown) {
  const result = store.db!.prepare(`
    SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order
    FROM doc_folders
    WHERE parent_id IS ?
  `).get<{ next_order: number }>(parentId);
  return Number(result?.next_order || 1);
}

export function nextDocSortOrder(store: DocumentStore, folderId: unknown) {
  const result = store.db!.prepare(`
    SELECT COALESCE(MAX(doc_sort_order), 0) + 1 AS next_order
    FROM docs
    WHERE folder_id IS ?
  `).get<{ next_order: number }>(folderId);
  return Number(result?.next_order || 1);
}

export function isDocFolderDescendant(store: DocumentStore, folderId: unknown, ancestorId: unknown) {
  let current = getDocFolder(store, folderId);
  while (current) {
    if (current.parent_id === ancestorId) return true;
    current = current.parent_id === null ? null : getDocFolder(store, current.parent_id);
  }
  return false;
}

export function createDocFolder(store: DocumentStore, { name, parentId = null }: { name: unknown; parentId?: unknown }) {
  const folderName = normalizeDocFolderName(name);
  const normalizedParentId = normalizeFolderId(store, parentId);
  const sortOrder = nextFolderSortOrder(store, normalizedParentId);
  const result = store.db!.prepare(`
    INSERT INTO doc_folders (parent_id, name, sort_order)
    VALUES (?, ?, ?)
  `).run(normalizedParentId, folderName, sortOrder);
  return store.db!.prepare('SELECT * FROM doc_folders WHERE id = ?').get<DocFolderRow>(Number(result.lastInsertRowid));
}

export function updateDocFolder(store: DocumentStore, folderId: unknown, patch: FolderPatch = {}) {
  const folder = getDocFolder(store, folderId);
  if (!folder) throw new Error(`Document folder not found: ${folderId}`);

  const updates: string[] = [];
  const values: unknown[] = [];
  if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
    updates.push('name = ?');
    values.push(normalizeDocFolderName(patch.name));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'parentId')) {
    const parentId = normalizeFolderId(store, patch.parentId);
    if (parentId === folder.id) throw new Error('Folder cannot be moved into itself');
    if (parentId !== null && isDocFolderDescendant(store, parentId, folder.id)) {
      throw new Error('Folder cannot be moved into its descendant');
    }
    updates.push('parent_id = ?');
    values.push(parentId);
  }
  if (updates.length === 0) return folder;

  updates.push('updated_at = CURRENT_TIMESTAMP');
  store.db!.prepare(`UPDATE doc_folders SET ${updates.join(', ')} WHERE id = ?`).run(...values, folder.id);
  return getDocFolder(store, folder.id);
}

export function deleteDocFolder(store: DocumentStore, folderId: unknown) {
  const folder = getDocFolder(store, folderId);
  if (!folder) return false;
  const childCount = Number(store.db!.prepare('SELECT COUNT(*) AS count FROM doc_folders WHERE parent_id = ?')
    .get<CountRow>(folder.id)?.count);
  const docCount = Number(store.db!.prepare('SELECT COUNT(*) AS count FROM docs WHERE folder_id = ?')
    .get<CountRow>(folder.id)?.count);
  if (childCount > 0 || docCount > 0) throw new Error('Cannot delete a non-empty folder');
  store.db!.prepare('DELETE FROM doc_folders WHERE id = ?').run(folder.id);
  return true;
}

export function moveDocToFolder(store: DocumentStore, { docId, folderId = null }: { docId: unknown; folderId?: unknown }) {
  const doc = store.db!.prepare('SELECT id FROM docs WHERE id = ?').get<Pick<DocRow, 'id'>>(docId);
  if (!doc) return false;
  const normalizedFolderId = normalizeFolderId(store, folderId);
  const sortOrder = nextDocSortOrder(store, normalizedFolderId);
  store.db!.prepare(`
    UPDATE docs
    SET folder_id = ?, doc_sort_order = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(normalizedFolderId, sortOrder, doc.id);
  return true;
}

export function createDoc(store: DocumentStore, {
  title, rootText = title, meta = null, folderId = null, skipInitialCommit = false
}: CreateDocInput): CreatedDoc {
  return store.withTransaction(() => {
    const normalizedFolderId = normalizeFolderId(store, folderId);
    const sortOrder = nextDocSortOrder(store, normalizedFolderId);
    const docId = newStableId();
    const rootNodeId = newStableId();
    store.db!.prepare(`
      INSERT INTO docs (id, title, meta, folder_id, doc_sort_order)
      VALUES (?, ?, ?, ?, ?)
    `).run(docId, title, meta, normalizedFolderId, sortOrder);
    store.db!.prepare(`
      INSERT INTO nodes (id, doc_id, parent_id, sort_order, node_type, text)
      VALUES (?, ?, NULL, 1, 'TEXT', ?)
    `).run(rootNodeId, docId, rootText || title);
    store.db!.prepare(`
      INSERT INTO doc_heads (doc_id, head_commit_id)
      VALUES (?, NULL)
      ON CONFLICT(doc_id) DO NOTHING
    `).run(docId);
    store.refreshDocAddresses(docId);
    if (!skipInitialCommit) {
      history.createCommit(store, {
        docId,
        summary: '初始版本',
        snapshot: history.createSnapshot(store, docId),
        author: 'import'
      });
    }
    return { id: docId, title, rootNodeId };
  });
}

export function deleteDoc(store: DocumentStore, docId: unknown) {
  const doc = store.db!.prepare('SELECT id FROM docs WHERE id = ?').get<Pick<DocRow, 'id'>>(docId);
  if (!doc) return false;
  store.domainPorts.documentPolicy?.beforeDeleteDoc(store, docId);
  store.withTransaction(() => {
    store.db!.prepare('DELETE FROM edit_branches WHERE base_doc_id = ? OR shadow_doc_id = ?').run(docId, docId);
    store.db!.prepare(`
      DELETE FROM refs
      WHERE (source_type = 'node' AND source_id IN (SELECT id FROM nodes WHERE doc_id = ?))
         OR (target_type = 'node' AND target_id IN (SELECT id FROM nodes WHERE doc_id = ?))
    `).run(docId, docId);
    store.db!.prepare('UPDATE nodes SET parent_id = NULL WHERE doc_id = ?').run(docId);
    store.db!.prepare('DELETE FROM docs WHERE id = ?').run(docId);
  });
  return true;
}

export function updateDocAxiomsCollapsed(store: DocumentStore, docId: unknown, collapsed: unknown) {
  const value = collapsed ? 1 : 0;
  store.db!.prepare('UPDATE docs SET axioms_collapsed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(value, docId);
  return store.db!.prepare('SELECT * FROM docs WHERE id = ?').get<DocRow>(docId);
}

export function updateDocTreeViewState(store: DocumentStore, docId: unknown, state: unknown) {
  const value = normalizeTreeViewState(state);
  store.db!.prepare('UPDATE docs SET tree_view_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(value, docId);
  return store.db!.prepare('SELECT * FROM docs WHERE id = ?').get<DocRow>(docId);
}
