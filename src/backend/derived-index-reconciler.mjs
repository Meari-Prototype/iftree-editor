import { keywordIndexRowsForAllDocs, keywordIndexRowsForDoc } from './keyword-index.mjs';
import { KeywordStore } from '../vector/keyword-store.mjs';
import { VectorStore } from '../vector/vector-store.mjs';
import { normalizeStableId } from './db/ids.mjs';

function resolveValue(value, fallback = null) {
  return typeof value === 'function' ? value() : (value ?? fallback);
}

function positiveIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => normalizeStableId(value))
    .filter(Boolean))];
}

export function createDerivedIndexReconciler(options = {}) {
  let keywordStore = null;
  let vectorStore = null;

  function vectorDbPath() {
    const value = String(resolveValue(options.vectorDbPath, '') || '').trim();
    if (!value) throw new Error('derived index reconciler requires vectorDbPath');
    return value;
  }

  function getStore() {
    const store = resolveValue(options.getStore);
    if (!store?.db) throw new Error('derived index reconciler requires an initialized store');
    return store;
  }

  function getVectorConfig() {
    return resolveValue(options.getVectorConfig, {}) || {};
  }

  function isVectorModuleEnabled() {
    return options.isVectorModuleEnabled?.() === true;
  }

  function assertVectorModuleEnabled() {
    if (!isVectorModuleEnabled()) throw new Error(options.vectorDisabledMessage || '向量模块已由用户禁用');
  }

  async function getKeywordStore() {
    if (!keywordStore) {
      keywordStore = new KeywordStore(vectorDbPath());
      await keywordStore.init();
    }
    return keywordStore;
  }

  async function ensureKeywordIndexRows(rows = []) {
    const keywords = await getKeywordStore();
    await keywords.ensureRows(rows);
  }

  async function rebuildKeywordIndexForDoc(docId) {
    const keywords = await getKeywordStore();
    await keywords.replaceRows(keywordIndexRowsForDoc(getStore(), docId));
  }

  async function rebuildKeywordIndexForAllDocs() {
    const keywords = await getKeywordStore();
    await keywords.replaceRows(keywordIndexRowsForAllDocs(getStore()));
  }

  async function upsertKeywordForNode(node) {
    const keywords = await getKeywordStore();
    await keywords.upsertNode(node);
  }

  async function deleteKeywordDoc(docId) {
    const keywords = await getKeywordStore();
    await keywords.deleteDoc(docId);
  }

  async function keywordSearch({ terms = [], docId = null } = {}) {
    const keywords = await getKeywordStore();
    return keywords.search({ terms, docId });
  }

  async function getVectorStore() {
    assertVectorModuleEnabled();
    if (!vectorStore) {
      vectorStore = new VectorStore(vectorDbPath(), { dimensions: getVectorConfig().dimensions });
      await vectorStore.init();
    }
    return vectorStore;
  }

  async function resetVectorStoreTable(dimensions = getVectorConfig().dimensions) {
    if (vectorStore) {
      vectorStore.close();
      vectorStore = null;
    }
    const vectors = new VectorStore(vectorDbPath(), { dimensions, reset: true });
    await vectors.init();
    vectors.close();
  }

  async function requireDocVectorIndex(docId) {
    const vectors = await getVectorStore();
    const count = Math.max(0, Number(await vectors.countDocVectors(docId)) || 0);
    const nodeCount = Math.max(0, Number(getStore().db.prepare('SELECT COUNT(*) AS count FROM nodes WHERE doc_id = ?').get(docId)?.count) || 0);
    if (count <= 0 || (nodeCount > 0 && count < nodeCount)) {
      throw new Error('向量索引未准备好：交互查询不会现场生成整篇文档向量，请先离线生成索引。');
    }
    return count;
  }

  async function docVectorStatus(docIds = []) {
    const ids = positiveIds(docIds);
    const result = {};
    if (!isVectorModuleEnabled()) {
      for (const id of ids) result[id] = { enabled: false, vectorCount: 0, reason: 'vector_disabled' };
      return result;
    }
    try {
      const vectors = await getVectorStore();
      const nodeCountStmt = getStore().db.prepare('SELECT COUNT(*) AS count FROM nodes WHERE doc_id = ?');
      for (const id of ids) {
        const vectorCount = Math.max(0, Number(await vectors.countDocVectors(id)) || 0);
        const nodeCount = Math.max(0, Number(nodeCountStmt.get(id)?.count) || 0);
        result[id] = { enabled: true, available: nodeCount > 0 && vectorCount >= nodeCount, vectorCount, nodeCount };
      }
    } catch (error) {
      for (const id of ids) {
        result[id] = { enabled: false, vectorCount: 0, reason: error?.message || 'vector_unavailable' };
      }
    }
    return result;
  }

  async function embedTexts(texts) {
    if (typeof options.embedTexts !== 'function') throw new Error('derived index reconciler requires embedTexts for vector operations');
    return options.embedTexts(texts);
  }

  async function ensureDocVectors(docId, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    if (!isVectorModuleEnabled()) {
      return { ok: true, skipped: true, reason: 'vector_disabled' };
    }
    const loaded = getStore().getDoc(docId);
    if (!loaded) return { ok: false, reason: 'doc_not_found', docId };
    const vectors = await getVectorStore();
    const nodes = loaded.nodes || [];
    const vectorCountBefore = Math.max(0, Number(await vectors.countDocVectors(docId)) || 0);
    const existingRows = await vectors.listDocVectorRows(docId, {
      limit: Math.max(nodes.length, vectorCountBefore) + 1
    });
    const currentTextById = new Map(nodes
      .map((node) => [String(node.id), String(node.text || '')])
      .filter(([id]) => id));
    const existingTextById = new Map(existingRows.map((row) => [row.id, row.text]));
    const staleIds = existingRows
      .map((row) => row.id)
      .filter((id) => !currentTextById.has(id));
    const changedIds = existingRows
      .map((row) => row.id)
      .filter((id) => currentTextById.has(id) && existingTextById.get(id) !== currentTextById.get(id));
    onProgress?.({
      stage: 'scan',
      docId,
      nodeCount: nodes.length,
      vectorCountBefore,
      staleCount: staleIds.length,
      changedCount: changedIds.length
    });
    const staleDeleteIds = [...new Set(staleIds)];
    const changedDeleteIds = [...new Set(changedIds)];
    const deletedIds = [...new Set([...staleDeleteIds, ...changedDeleteIds])];
    const deleted = await vectors.deleteNodeVectors(deletedIds);
    const staleDeleted = staleDeleteIds.length;
    const changedDeleted = changedDeleteIds.length;
    if (deleted > 0) onProgress?.({ stage: 'cleanup', docId, staleDeleted, changedDeleted });

    const reusableIds = new Set();
    for (const [id, text] of existingTextById.entries()) {
      if (currentTextById.has(id) && currentTextById.get(id) === text) reusableIds.add(id);
    }

    const missing = nodes.filter((node) => !reusableIds.has(String(node.id)));
    const batchSize = Math.max(1, Math.min(128, Number(getVectorConfig().batchSize) || 16));
    let inserted = 0;
    onProgress?.({ stage: 'missing', docId, missingCount: missing.length, batchSize });
    for (let offset = 0; offset < missing.length; offset += batchSize) {
      const batch = missing.slice(offset, offset + batchSize);
      onProgress?.({ stage: 'batch_start', docId, offset, batchSize: batch.length, completed: inserted, total: missing.length });
      const embeddings = await embedTexts(batch.map((node) => node.text));
      await vectors.upsertNodeVectors(batch.map((node, index) => ({
        nodeId: node.id,
        docId,
        text: node.text,
        vector: embeddings[index]
      })), { deleteExisting: false });
      inserted += batch.length;
      onProgress?.({ stage: 'batch_done', docId, completed: inserted, total: missing.length });
    }
    const vectorCountAfter = Math.max(0, Number(await vectors.countDocVectors(docId)) || 0);
    onProgress?.({ stage: 'done', docId, vectorCountAfter, missingInserted: inserted });
    return {
      ok: true,
      docId,
      nodeCount: nodes.length,
      vectorCountBefore,
      vectorCountAfter,
      existingCurrent: reusableIds.size,
      staleDeleted,
      changedDeleted,
      missingInserted: inserted
    };
  }

  async function upsertVectorForNode(node) {
    if (!isVectorModuleEnabled()) return;
    const vectors = await getVectorStore();
    const [vector] = await embedTexts([node.text]);
    await vectors.upsertNodeVector({
      nodeId: node.id,
      docId: node.doc_id,
      text: node.text,
      vector
    });
  }

  async function deleteDocVectors(docId) {
    if (!isVectorModuleEnabled()) return;
    const vectors = await getVectorStore();
    await vectors.deleteDoc(docId);
  }

  async function vectorSearch({ docId = null, query, limit = 20 } = {}) {
    assertVectorModuleEnabled();
    const scopedDocId = normalizeStableId(docId, null);
    if (scopedDocId) await requireDocVectorIndex(scopedDocId);
    const [vector] = await embedTexts([query]);
    const vectors = await getVectorStore();
    return vectors.search({
      docId: scopedDocId,
      vector,
      limit: limit || 20
    });
  }

  function readContext() {
    return {
      docVectorStatus,
      ensureKeywordIndexRows,
      keywordSearch,
      vectorSearch
    };
  }

  function writeContext() {
    return {
      ensureDocVectors,
      upsertVectorForNode,
      rebuildKeywordIndexForDoc,
      rebuildKeywordIndexForAllDocs,
      upsertKeywordForNode,
      deleteKeywordDoc,
      deleteDocVectors
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
    rebuildKeywordIndexForAllDocs,
    upsertKeywordForNode,
    deleteKeywordDoc,
    keywordSearch,
    resetVectorStoreTable,
    requireDocVectorIndex,
    docVectorStatus,
    ensureDocVectors,
    upsertVectorForNode,
    deleteDocVectors,
    vectorSearch,
    readContext,
    writeContext,
    close
  };
}
