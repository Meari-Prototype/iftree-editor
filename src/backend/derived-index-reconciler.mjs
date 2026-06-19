import { keywordIndexRowsForAllDocs, keywordIndexRowsForDoc, keywordIndexRowsForNodeIds } from './keyword-index.mjs';
import { KeywordStore } from '../vector/keyword-store.mjs';
import { VectorStore } from '../vector/vector-store.mjs';
import { normalizeStableId } from './db/ids.mjs';
import { normalizeSemanticStatus } from './semantic-status.mjs';
import { computeSubtreeHashes } from '../core/merkle.mjs';

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

  // 持久化语义状态到 docs.meta.semantic（写入维护、读取读列，免每次查 lance 的计算税）。
  // 建/补向量的收口、push/import 落库、启动回填都调它刷新这一列。
  async function refreshDocSemanticMeta(docId) {
    const id = normalizeStableId(docId);
    if (!id) return;
    const store = getStore();
    const row = store.db.prepare('SELECT meta FROM docs WHERE id = ?').get(id);
    if (!row) return;
    const statusMap = await docVectorStatus([id]);
    const semantic = normalizeSemanticStatus(statusMap[id] || {});
    /** @type {Record<string, any>} */
    let meta = {};
    try { meta = row.meta ? JSON.parse(row.meta) : {}; } catch { meta = {}; }
    if (!meta || typeof meta !== 'object') meta = {};
    meta.semantic = semantic;
    store.db.prepare('UPDATE docs SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id);
  }

  // 启动回填：把还没持久化 semantic 的存量文档补上（默认只补 meta.semantic 为 NULL 的，已填的跳过）。
  // 读取侧改读 meta 列后，存量若不回填会显示退化，故后端初始化时后台跑一次。
  async function backfillDocSemanticMeta({ onlyMissing = true } = {}) {
    const store = getStore();
    const rows = onlyMissing
      ? store.db.prepare("SELECT id FROM docs WHERE json_extract(meta, '$.semantic') IS NULL").all()
      : store.db.prepare('SELECT id FROM docs').all();
    let filled = 0;
    for (const row of rows) {
      try { await refreshDocSemanticMeta(row.id); filled += 1; } catch { /* 单 doc 失败不阻断整体回填 */ }
    }
    return { ok: true, filled };
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
        // 写入恒按 id upsert（vector-store 内 mergeInsert）：changed 覆盖旧行、missing 插入新行，
        // 不再分「先删/直接 add」两路，一次写入即可（也不会再产生重复行）。
        if (changedRows.length || missingRows.length) {
          await vectors.upsertNodeVectors([...changedRows, ...missingRows]);
          changedDeleted += changedRows.length;
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
      missingInserted
    };
  }

  // pull 自对账（4-6-1/14-2/15-8-1）：主进程写完 SQL 只发本信号、不传变更集，向量库自查 SQL 对账。
  // 派生索引只读主数据、自算 Merkle 指纹对账自己的向量，不碰主库 content_hash/subtree_hash 列与脏标记
  // （那是版本系统的事，向量库不触发其回写）。subtree_hash top-down 剪枝：未变子树整体跳过，
  // 流式百万节点也只对账变化子树。fillNow=true 当场 embed 待补；false 只删孤儿、返回待补数，
  // 由 completeness 闸拦检索、留待后面补（保存路径不 embed，4-6-1）。
  async function reconcile(docId, options = {}) {
    if (!isVectorModuleEnabled()) return { ok: true, skipped: true, reason: 'vector_disabled' };
    const id = normalizeStableId(docId);
    if (!id) return { ok: false, reason: 'invalid_doc_id' };
    const fillNow = options.fillNow === true;
    const dryRun = options.dryRun === true;
    const store = getStore();
    if (!store.db.prepare('SELECT 1 AS x FROM docs WHERE id = ?').get(id)) {
      return { ok: false, reason: 'doc_not_found', docId: id };
    }
    const vectors = await getVectorStore();

    // 只读拉本 doc 全节点（结构 + 5 内容字段），自算 Merkle 指纹——不触发主库回写。
    const rows = store.db.prepare(
      'SELECT id, parent_id, sort_order, text, node_title, node_note, node_type, trust_level FROM nodes WHERE doc_id = ?'
    ).all(id);
    const sqlHashes = computeSubtreeHashes(rows);

    // 正文非空节点才进向量；同时按邻接表建子表（按 sort_order）。
    const textById = new Map();
    const childrenByParent = new Map();
    for (const row of rows) {
      const key = row.parent_id == null ? '__root__' : String(row.parent_id);
      if (!childrenByParent.has(key)) childrenByParent.set(key, []);
      childrenByParent.get(key).push(row);
      if (String(row.text ?? '').trim() !== '') textById.set(String(row.id), String(row.text));
    }
    for (const list of childrenByParent.values()) {
      list.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
    }

    // top-down 逐层剪枝：正文节点 subtree_hash 匹配 lance → 整子树一致、剪掉不下行；否则下行。
    // 待补判定：无 lance 行=缺失；有行且 content_hash 不符=陈旧。旧表迁移遗留的空 content_hash 行
    // 不当陈旧误判——按存储文本核对：文本一致=向量仍有效（嵌的就是这段文本，只缺哈希，不待补），
    // 文本不符=真陈旧待补。空哈希行不持久回填（lance update 不支持按行不同值的批量写、逐行写会把
    // 表打碎片）：每次按文本核就绪，该 doc 重嵌后自带哈希、即恢复剪枝。结构节点（lance 无行）不剪、只下行一层。
    const pending = [];
    let layer = (childrenByParent.get('__root__') || []).map((row) => String(row.id));
    while (layer.length) {
      const lanceHashes = await vectors.hashesByNodeIds(layer);
      // 只对「有 lance 行但 content_hash 空」的旧行拉存储文本核对；新表无空哈希行 → 零额外查询。
      const legacyIds = layer.filter((id) => { const l = lanceHashes.get(id); return l && !l.contentHash; });
      const legacyText = legacyIds.length ? await vectors.textByNodeIds(legacyIds) : new Map();
      const nextLayer = [];
      for (const nodeId of layer) {
        const sql = sqlHashes.get(nodeId);
        const lance = lanceHashes.get(nodeId);
        if (lance && sql && lance.subtreeHash && lance.subtreeHash === sql.subtreeHash) continue;
        if (textById.has(nodeId)) {
          const sqlText = textById.get(nodeId);
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

    // fillNow：当场 embed 待补并 upsert（带 Merkle 哈希）；否则留给 completeness 闸后补。
    let filled = 0;
    if (pending.length && fillNow && !dryRun) {
      const batchSize = Math.max(1, Math.min(128, Number(getVectorConfig().batchSize) || 16));
      const embedChunk = Math.max(batchSize, 256);
      for (let offset = 0; offset < pending.length; offset += embedChunk) {
        const batch = pending.slice(offset, offset + embedChunk);
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

    if (!dryRun) await refreshDocSemanticMeta(id);
    // ready = 对账后一致：dryRun 看「无待补且无孤儿」；写模式看 pending 是否已解决（fillNow 补全 / 无待补）。
    const ready = dryRun
      ? (pending.length === 0 && orphans.length === 0)
      : (pending.length === 0 || (fillNow && filled === pending.length));
    return { ok: true, docId: id, fillNow, pendingCount: pending.length, orphanCount: orphans.length, filled, deleted, ready };
  }

  // ── 写侧向量维护已收口进 reconcile（pull 自对账，见本文件 reconcile()）：以下原三个函数功能未删除、只是改由 reconcile 统一承担，别误以为这块功能被砍了 ──
  // 1) 原 upsertVectorForNode（节点改正文后即时重嵌单节点）
  //    → node.update 现发 reconcile(fillNow:false)：保存路径不 embed、只标待补（4-6-1），待补由 completeness 闸或显式 vectors 动词补齐。
  // 2) 原 embedStreamNodes（流式 push 只 embed 这批新节点，O(K)、避 ensureDocVectors 的 OOM 墙）
  //    → stream.push + embed:true 现发 reconcile(fillNow:true)：自查 SQL、subtree_hash 剪枝跳已嵌、只嵌本批新增。
  // 3) 原 deleteVectorsForNodes（编辑落主干清受影响节点的陈旧向量，8-3-2-2）
  //    → 现并入 reconcile 的孤儿/陈旧对账：按最终节点集差集删孤儿+陈旧，比按增量列表删更稳、不漏历史遗留。
  // 调用面切换见 handlers/write/{node,doc,history}.mjs 的 vector.reconcile effect。

  async function deleteDocVectors(docId) {
    if (!isVectorModuleEnabled()) return;
    const vectors = await getVectorStore();
    await vectors.deleteDoc(docId);
  }

  // 孤儿向量对账清理（4-6-1：只删、不 embed/重算）：editBranch 落主干走「只清陈旧」，
  // 但按本次增量列表（deletedNodeIds/vectorStaleNodeIds）删可能漏掉历史遗留孤儿或未覆盖
  // 的删除，导致向量行数 > 节点数。这里按最终节点集对账，删掉「向量在、节点已不存在」的
  // 行，确保库中不存孤儿（vectorCount 不再虚高）。纯 id 集合差集 + 删除，无 GPU。
  async function pruneStaleDocVectors(docId) {
    if (!isVectorModuleEnabled()) return { ok: true, skipped: true, reason: 'vector_disabled' };
    const vectors = await getVectorStore();
    const lanceIds = Array.from(await vectors.listDocVectorIds(docId));
    if (lanceIds.length === 0) return { ok: true, docId, pruned: 0 };
    const store = getStore();
    const rows = store.db.prepare('SELECT id FROM nodes WHERE doc_id = ?').all(docId);
    const current = new Set(rows.map((r) => String(r.id)));
    const staleIds = lanceIds.filter((id) => !current.has(String(id)));
    if (staleIds.length === 0) return { ok: true, docId, pruned: 0 };
    const pruned = await vectors.deleteNodeVectors(staleIds);
    await refreshDocSemanticMeta(docId);
    return { ok: true, docId, pruned };
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
      refreshDocSemanticMeta,
      backfillDocSemanticMeta,
      addStreamKeywords,
      isVectorModuleEnabled,
      rebuildKeywordIndexForDoc,
      rebuildKeywordIndexForAllDocs,
      upsertKeywordForNode,
      updateKeywordForNodes,
      deleteKeywordDoc,
      deleteDocVectors,
      pruneStaleDocVectors,
      reconcile
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
    refreshDocSemanticMeta,
    backfillDocSemanticMeta,
    deleteDocVectors,
    pruneStaleDocVectors,
    reconcile,
    vectorSearch,
    readContext,
    writeContext,
    close
  };
}
