import { keywordIndexRowsForAllDocs, keywordIndexRowsForDoc, keywordIndexRowsForNodeIds } from './keyword-index.mjs';
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

  // 增量同步（projectneed 4-6-2）：分支合并落主干时只动本次受影响节点的索引行，不整篇重建。
  // 先删后加幂等：upsert 行与被删节点行一并先删，再批量 add upsert 行的新内容。
  async function updateKeywordForNodes(docId, upsertNodeIds = [], deleteNodeIds = []) {
    const upserts = positiveIds(upsertNodeIds);
    const deletes = positiveIds(deleteNodeIds);
    if (upserts.length === 0 && deletes.length === 0) {
      return { ok: true, docId, upserted: 0, deleted: 0 };
    }
    const keywords = await getKeywordStore();
    await keywords.deleteNodes([...upserts, ...deletes]);
    const rows = upserts.length ? keywordIndexRowsForNodeIds(getStore(), docId, upserts) : [];
    if (rows.length) await keywords.addRows(rows);
    return { ok: true, docId, upserted: rows.length, deleted: deletes.length };
  }

  async function rebuildKeywordIndexForAllDocs() {
    const keywords = await getKeywordStore();
    await keywords.replaceRows(keywordIndexRowsForAllDocs(getStore()));
  }

  async function upsertKeywordForNode(node) {
    const keywords = await getKeywordStore();
    await keywords.upsertNode(node);
  }

  // 流式增量关键字入库（projectneed 4-16）：只 add 这批刚写入节点的 FTS 行（O(K)），
  // LanceDB FTS 即时可搜；不 delete 整 doc、不全量重建。
  async function addStreamKeywords(docId, nodes = []) {
    const list = Array.isArray(nodes) ? nodes.filter((node) => node && node.id != null) : [];
    if (list.length === 0) return { ok: true, docId, added: 0 };
    const keywords = await getKeywordStore();
    await keywords.addRows(list.map((node) => ({
      id: node.id,
      doc_id: docId,
      address: node.address,
      node_title: node.node_title ?? node.nodeTitle ?? '',
      text: node.text ?? '',
      node_note: node.node_note ?? node.nodeNote ?? '',
      updated_at: node.updated_at ?? ''
    })));
    return { ok: true, docId, added: list.length };
  }

  // 分批补建某 doc 的关键字索引：delete + 按 id 游标分批拉 SQL 行 add，绝不全量进 JS 内存。
  async function rebuildDocKeywordIncremental(keywords, docId) {
    await keywords.deleteDoc(docId);
    const stmt = getStore().db.prepare(`
      SELECT id, doc_id, address, node_title, text, node_note, updated_at
      FROM nodes WHERE doc_id = ? AND id > ? ORDER BY id LIMIT ?
    `);
    const BATCH = 5000;
    let lastId = '';
    for (;;) {
      const rows = stmt.all(docId, lastId, BATCH);
      if (rows.length === 0) break;
      await keywords.addRows(rows);
      lastId = rows[rows.length - 1].id;
      if (rows.length < BATCH) break;
    }
  }

  // 查询时确保关键字索引就绪：入库已增量维护，这里只用计数比对判断是否缺失，
  // 缺失才分批补建（一次），绝不每次查询全量重建（projectneed 4-16）。
  async function ensureKeywordIndexReady(payload = {}) {
    const store = getStore();
    const keywords = await getKeywordStore();
    const allDocs = payload.allDocs === true || payload.all_docs === true || payload.scope === 'all';
    let docIds;
    if (allDocs) {
      docIds = store.db.prepare('SELECT id FROM docs').all().map((row) => String(row.id));
    } else {
      const docId = normalizeStableId(payload.scopeDocId ?? payload.scope_doc_id ?? payload.docId ?? payload.doc_id, null);
      docIds = docId ? [docId] : [];
    }
    for (const docId of docIds) {
      const sqlCount = Number(store.db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE doc_id = ?').get(docId)?.c) || 0;
      if (sqlCount === 0) continue;
      const kwCount = Math.max(0, Number(await keywords.countDocRows(docId)) || 0);
      if (kwCount >= sqlCount) continue;
      await rebuildDocKeywordIncremental(keywords, docId);
    }
  }

  async function deleteKeywordDoc(docId) {
    const keywords = await getKeywordStore();
    await keywords.deleteDoc(docId);
  }

  /** @param {{ terms?: any[], docId?: any, limit?: number }} [opts] */
  async function keywordSearch({ terms = [], docId = null, limit } = {}) {
    const keywords = await getKeywordStore();
    return keywords.search({ terms, docId, limit });
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

  // 检索就绪 = 完整性（projectneed 14-2）：缺失/陈旧/残留任一存在都不开放语义检索——
  // 带着陈旧向量返回相似度结果是错误输出，不是降级输出。
  async function requireDocVectorIndex(docId) {
    const integrity = await scanDocVectorIntegrity(docId);
    const broken = integrity.missingCount + integrity.changedCount + integrity.staleIds.length;
    if (integrity.nodeCount === 0 || broken > 0) {
      throw new Error(
        `向量索引未就绪（缺失 ${integrity.missingCount}、正文已变更 ${integrity.changedCount}、残留 ${integrity.staleIds.length}）：`
        + '语义检索不开放，交互查询不会现场生成整篇文档向量，请先运行完整性检验（向量补建）补齐；'
        + '期间可改用关键词检索与结构定位。'
      );
    }
    return integrity.existingCurrent;
  }

  // 批量状态（library_index 等列表场景）：行数快筛只是就绪的必要条件，便宜不诚实——
  // 正文一致性由检索入口 requireDocVectorIndex 与完整性检验把关（14-2）。
  async function docVectorStatus(docIds = []) {
    const ids = positiveIds(docIds);
    const result = {};
    if (!isVectorModuleEnabled()) {
      for (const id of ids) result[id] = { enabled: false, vectorCount: 0, reason: 'vector_disabled' };
      return result;
    }
    try {
      const vectors = await getVectorStore();
      const nodeCountStmt = getStore().db.prepare("SELECT COUNT(*) AS count FROM nodes WHERE doc_id = ? AND TRIM(text) <> ''");
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

  // 完整性扫描内核（projectneed 15-8-1 / 14-2）：向量有效性绑 node id + 节点自有正文。
  // LanceDB 行存有 embed 时所见正文，与 SQL 当前正文直接比对——无状态、不靠脏标记：
  //   SQL 有、Lance 无           → missing（缺失）
  //   两边有、正文不一致         → changed（陈旧）
  //   Lance 有、SQL 无或正文已空 → stale（残留）
  // SQL 侧按 id 游标分批、Lance 侧只全取 id 集合（不带正文），正文按批比对，
  // 不把整 doc 两侧正文同时拉进 JS 内存。只扫正文非空节点：结构/标题节点不进向量。
  async function scanDocVectorIntegrity(docId, { onMissing = null, onChanged = null, onBatchEnd = null } = {}) {
    const store = getStore();
    const vectors = await getVectorStore();
    const lanceIds = new Set(await vectors.listDocVectorIds(docId));
    const vectorCountBefore = lanceIds.size;
    const SCAN = 1000;
    const stmt = store.db.prepare("SELECT id, text FROM nodes WHERE doc_id = ? AND TRIM(text) <> '' AND id > ? ORDER BY id LIMIT ?");
    let lastId = '';
    let nodeCount = 0;
    let existingCurrent = 0;
    let missingCount = 0;
    let changedCount = 0;
    const seen = new Set();
    for (;;) {
      const rows = stmt.all(docId, lastId, SCAN);
      if (rows.length === 0) break;
      nodeCount += rows.length;
      const presentIds = [];
      for (const row of rows) {
        const id = String(row.id);
        seen.add(id);
        if (lanceIds.has(id)) presentIds.push(id);
      }
      const lanceText = presentIds.length ? await vectors.textByNodeIds(presentIds) : new Map();
      for (const row of rows) {
        const id = String(row.id);
        const current = String(row.text ?? '');
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
  async function ensureDocVectors(docId, options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    if (!isVectorModuleEnabled()) {
      return { ok: true, skipped: true, reason: 'vector_disabled' };
    }
    const store = getStore();
    const exists = store.db.prepare('SELECT 1 AS x FROM docs WHERE id = ?').get(docId);
    if (!exists) return { ok: false, reason: 'doc_not_found', docId };
    const vectors = await getVectorStore();
    // embedChunk 只决定「一次交给 embedTexts 多少条」；真正的 GPU 批次由各后端内部再切
    // （本地 transformers 按 config.batchSize，远程 ollama/llama.cpp 按 IFTREE_EMBED_BATCH）。
    // 取较大值，避免把远程后端也压成 config.batchSize（DirectML 偏好 16，远程偏好 64+）。
    const batchSize = Math.max(1, Math.min(128, Number(getVectorConfig().batchSize) || 16));
    const embedChunk = Math.max(batchSize, 256);
    let missingInserted = 0;
    let changedDeleted = 0;
    let scannedSoFar = 0;
    const pendingMissing = [];
    const pendingChanged = [];
    // 攒满 embedChunk 才 embed：embed 批大小与 SQL 扫描批解耦；内存峰值 = 单个 embed 批。
    const flushEmbed = async (force = false) => {
      while (
        pendingMissing.length + pendingChanged.length >= embedChunk
        || (force && pendingMissing.length + pendingChanged.length > 0)
      ) {
        const batch = [];
        while (batch.length < embedChunk && (pendingChanged.length || pendingMissing.length)) {
          if (pendingChanged.length) batch.push({ ...pendingChanged.shift(), changed: true });
          else batch.push({ ...pendingMissing.shift(), changed: false });
        }
        const embeddings = await embedTexts(batch.map((item) => item.text));
        const changedRows = [];
        const missingRows = [];
        batch.forEach((item, index) => {
          const row = { nodeId: item.id, docId, text: item.text, vector: embeddings[index] };
          (item.changed ? changedRows : missingRows).push(row);
        });
        // 变更节点须先删旧行（upsert 默认逐行删）；缺失节点确证无旧行，直接 add 省逐行删。
        if (changedRows.length) {
          await vectors.upsertNodeVectors(changedRows, { deleteExisting: true });
          changedDeleted += changedRows.length;
        }
        if (missingRows.length) {
          await vectors.upsertNodeVectors(missingRows, { deleteExisting: false });
          missingInserted += missingRows.length;
        }
        onProgress?.({ stage: 'batch_done', docId, scanned: scannedSoFar, missingInserted, changedDeleted });
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
    onProgress?.({
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
    onProgress?.({
      stage: 'done',
      docId,
      scanned: integrity.nodeCount,
      vectorCountAfter,
      missingInserted,
      changedDeleted,
      staleDeleted
    });
    return {
      ok: true,
      docId,
      nodeCount: integrity.nodeCount,
      vectorCountBefore: integrity.vectorCountBefore,
      vectorCountAfter,
      existingCurrent: integrity.existingCurrent,
      staleDeleted,
      changedDeleted,
      missingInserted
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

  // 流式增量向量（projectneed 4-16）：只 embed 调用方传入的这批刚写入节点（O(K)），
  // 绝不 getDoc 全量（避开 ensureDocVectors 的 OOM 墙）。upsert 幂等 → 失败后同一批可直接重补（断点续传）。
  // 向量配置不可用时 getVectorStore() 内部 assert 抛错，不静默跳过。
  async function embedStreamNodes(docId, nodes = []) {
    // 只 embed 正文非空节点：结构/标题节点不进向量（与 ensureDocVectors 一致）。
    const list = Array.isArray(nodes)
      ? nodes.filter((node) => node && node.id != null && String(node.text ?? '').trim() !== '')
      : [];
    if (list.length === 0) return { ok: true, docId, embedded: 0 };
    const vectors = await getVectorStore();
    const batchSize = Math.max(1, Math.min(128, Number(getVectorConfig().batchSize) || 16));
    const embedChunk = Math.max(batchSize, 256);
    let embedded = 0;
    for (let offset = 0; offset < list.length; offset += embedChunk) {
      const batch = list.slice(offset, offset + embedChunk);
      const embeddings = await embedTexts(batch.map((node) => String(node.text ?? '')));
      await vectors.upsertNodeVectors(batch.map((node, index) => ({
        nodeId: node.id,
        docId,
        text: String(node.text ?? ''),
        vector: embeddings[index]
      })), { deleteExisting: false });
      embedded += batch.length;
    }
    return { ok: true, docId, embedded };
  }

  async function deleteDocVectors(docId) {
    if (!isVectorModuleEnabled()) return;
    const vectors = await getVectorStore();
    await vectors.deleteDoc(docId);
  }

  // 编辑落主干的附赠状态处理（8-3-2-2）：受影响节点的旧向量行连带删除——完整性只会
  // 被编辑破坏，就地清陈旧，库中不存陈旧行；删除是派生索引维护、不触碰 embedding
  // （4-6-1），补齐归完整性检验。未建向量的文档删除是 no-op。
  async function deleteVectorsForNodes(docId, nodeIds = []) {
    if (!isVectorModuleEnabled()) return { ok: true, skipped: true, reason: 'vector_disabled' };
    const ids = positiveIds(nodeIds);
    if (ids.length === 0) return { ok: true, docId, deleted: 0 };
    const vectors = await getVectorStore();
    const deleted = await vectors.deleteNodeVectors(ids);
    return { ok: true, docId, deleted };
  }

  /** @param {{ docId?: any, query?: string, limit?: number }} [payload] */
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
      ensureKeywordIndexReady,
      keywordSearch,
      vectorSearch
    };
  }

  function writeContext() {
    return {
      ensureDocVectors,
      upsertVectorForNode,
      embedStreamNodes,
      addStreamKeywords,
      isVectorModuleEnabled,
      rebuildKeywordIndexForDoc,
      rebuildKeywordIndexForAllDocs,
      upsertKeywordForNode,
      updateKeywordForNodes,
      deleteKeywordDoc,
      deleteDocVectors,
      deleteVectorsForNodes
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
    updateKeywordForNodes,
    keywordSearch,
    resetVectorStoreTable,
    requireDocVectorIndex,
    docVectorStatus,
    ensureDocVectors,
    upsertVectorForNode,
    deleteDocVectors,
    deleteVectorsForNodes,
    vectorSearch,
    readContext,
    writeContext,
    close
  };
}
