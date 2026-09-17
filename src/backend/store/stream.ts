// 增量流式写入与 bulk 会话（L2）。

import { normalizeNodeType } from '../../core/node-model.js';
import { editModeMismatchMessage } from '../shared.js';
import { newStableId } from '../db/ids.js';
import { normalizeSourcePosition } from '../db/normalizers.js';
import type { DocRow, NodeRow } from '../db/schema.js';
import * as document from './document.js';
import * as node from './node.js';

const EDIT_MODES: readonly string[] = Object.freeze(['readonly', 'incremental', 'full']);
const STREAM_PUSH_DEDUPE_MS = 10000;

type RowObject = Record<string, unknown>;
type MaxSortOrderRow = { m: number | null };
type StreamNodeInput = RowObject & { children?: StreamNodeInput[] };
type CreatedStreamNode = { id: string; address: string; children: CreatedStreamNode[] };

export interface StreamStore extends document.DocumentStore, node.NodeStore {
  _streamPushCache: Map<string, { at: number; result: RowObject }> | null;
  _bulkTouchedDocIds: Set<string> | null;
}

export function getDocEditMode(store: StreamStore, docId: unknown) {
    const row = store.db!.prepare('SELECT edit_mode FROM docs WHERE id = ?').get<Pick<DocRow, 'edit_mode'>>(docId);
    return row ? (row.edit_mode || 'full') : null;
  }

export function setDocEditMode(store: StreamStore, docId: unknown, mode: unknown) {
    const normalized = String(mode || '').trim();
    if (!EDIT_MODES.includes(normalized)) {
      throw new Error(`未知编辑模式：${mode}；只能是 ${EDIT_MODES.join(' / ')}`);
    }
    const doc = store.db!.prepare('SELECT id FROM docs WHERE id = ?').get<Pick<DocRow, 'id'>>(docId);
    if (!doc) throw new Error(`Doc not found: ${docId}`);
    // 领域闸（封卷的记忆卷不得改回可写等）：store 只管模式字面合法，是否允许由领域端口裁。
    store.domainPorts.documentPolicy?.beforeSetEditMode(store, docId, normalized);
    store.db!.prepare('UPDATE docs SET edit_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(normalized, docId);
    return store.db!.prepare('SELECT id, title, edit_mode FROM docs WHERE id = ?').get<Pick<DocRow, 'id' | 'title' | 'edit_mode'>>(docId);
  }

export function streamPushFromCache(store: StreamStore, key: unknown) {
    if (!key || !store._streamPushCache) return null;
    const cacheKey = String(key);
    const hit = store._streamPushCache.get(cacheKey);
    if (!hit) return null;
    if (Date.now() - hit.at > STREAM_PUSH_DEDUPE_MS) {
      store._streamPushCache.delete(cacheKey);
      return null;
    }
    return hit.result;
  }

export function rememberStreamPush(store: StreamStore, key: unknown, result: RowObject) {
    if (!key) return;
    if (!store._streamPushCache) store._streamPushCache = new Map();
    const cacheKey = String(key);
    const now = Date.now();
    for (const [k, v] of store._streamPushCache) {
      if (now - v.at > STREAM_PUSH_DEDUPE_MS) store._streamPushCache.delete(k);
    }
    store._streamPushCache.set(cacheKey, { at: now, result });
  }

  // 一条流式节点：调用方按 4-16-7 给齐标准字段；trust_level 必给（4-16-4，不闭眼填），node_type 缺省 TEXT。
  // 流式节点标准字段：trust_level 必给（4-16-4），source_position 可选（配合 stream.attachSource
  // 的源文档层，流式文档同样能做句位对照），其余缺省。
function streamNodeFields(item: StreamNodeInput = {}) {
    // 写动词写入信任恒为不受控（projectneed 18-3：trust 字段下线，标受控只走 human 档 certify）；
    // 不再要求/采纳调用方给的 trust_level；写入恒为不受控。
    return {
      trustLevel: '不受控',
      nodeType: normalizeNodeType(item.node_type ?? item.nodeType ?? 'TEXT'),
      text: typeof item.text === 'string' ? item.text : '',
      nodeTitle: item.node_title ?? item.nodeTitle ?? '',
      nodeNote: item.node_note ?? item.nodeNote ?? '',
      sourcePosition: normalizeSourcePosition(item.source_position ?? item.sourcePosition ?? null)
    };
  }

function insertStreamNode(store: StreamStore, docId: unknown, parentId: unknown, item: StreamNodeInput = {}): Pick<NodeRow, 'id' | 'address'> {
    const f = streamNodeFields(item);
    return node.insertNode(store, { docId, parentId, text: f.text, nodeType: f.nodeType, nodeTitle: f.nodeTitle, nodeNote: f.nodeNote, sourcePosition: f.sourcePosition, trustLevel: f.trustLevel }) as Pick<NodeRow, 'id' | 'address'>;
  }

  // 校验调用方给的 address 是纯追加（连续、不重复、与父自洽，4-16-2）；违反报错带定位，调用方读结构重算重推。
function validateStreamAddresses(items: StreamNodeInput[], parentAddress: string, startOrder: number) {
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
      if (children.length) validateStreamAddresses(children, addr, 0);
    }
  }

  // 单一标准推送入口（4-16-7）：直接 append，不走 edit branch。
  // 首次省略 docId + 给 title => 新建增量编辑文档并挂根下；之后给 docId + parentId(uuid 挂载点) 追加。
  // 调用方给 address => 校验纯追加 + 批量直写（不重排、不刷结构链），地址/深度由 address 决定（4-16-2）；
  // 不给 address => 自动续号兜底（小流友好，O(n)）。去重是调用方责任，系统只按 idempotencyKey 请求级防抖（4-16-5）。
export function pushStreamNodes(store: StreamStore, {
    docId = null,
    title = null,
    parentId = null,
    nodes = [],
    idempotencyKey = null
  }: {
    docId?: unknown;
    title?: unknown;
    parentId?: unknown;
    nodes?: unknown;  // 调用方常传 unknown[]（payload.nodes），函数内部 Array.isArray + 逐项 normalize
    idempotencyKey?: unknown;
  } = {}) {
    const list = Array.isArray(nodes) ? nodes : [];
    if (list.length === 0) throw new Error('stream.push 需要至少一个节点');

    const cached = streamPushFromCache(store, idempotencyKey);
    if (cached) return { ...cached, deduped: true };

    const result = store.withTransaction(() => {
      let targetDocId = docId;
      let createdDoc = null;
      if (targetDocId === null || targetDocId === undefined || targetDocId === '') {
        const docTitle = String(title || '').trim();
        if (!docTitle) throw new Error('首次流式写入需要 title 以新建文档');
        createdDoc = document.createDoc(store, { title: docTitle });
        setDocEditMode(store, createdDoc.id, 'incremental');
        targetDocId = createdDoc.id;
      } else {
        const mode = getDocEditMode(store, targetDocId);
        if (mode === null) throw new Error(`Doc not found: ${targetDocId}`);
        if (mode !== 'incremental') {
          throw new Error(editModeMismatchMessage({ docId: targetDocId, current: mode, required: 'incremental', intent: '流式写入 push' }));
        }
        store.domainPorts.documentPolicy?.beforeStreamPush(store, targetDocId, list);
      }

      const rootId = createdDoc
        ? createdDoc.rootNodeId
        : store.db!.prepare('SELECT id FROM nodes WHERE doc_id = ? AND parent_id IS NULL').get<Pick<NodeRow, 'id'>>(targetDocId)?.id;
      const mountId = parentId ?? rootId;
      const mount = store.db!.prepare('SELECT id, address FROM nodes WHERE id = ? AND doc_id = ?').get<Pick<NodeRow, 'id' | 'address'>>(mountId, targetDocId);
      if (!mount) throw new Error(`挂载点 ${mountId} 不在文档 ${targetDocId} 中`);

      const useAddresses = list.some((item) => item && item.address != null);
      let createdCount = 0;
      let created;

      if (useAddresses) {
        const maxRow = store.db!.prepare('SELECT MAX(sort_order) AS m FROM nodes WHERE doc_id = ? AND parent_id = ?').get<MaxSortOrderRow>(targetDocId, mountId);
        validateStreamAddresses(list, String(mount.address || ''), Number(maxRow?.m) || 0);
        const insert = store.db!.prepare(`
          INSERT INTO nodes (id, doc_id, parent_id, sort_order, depth, address, node_type, text, node_title, node_note, source_position, trust_level)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const writeTree = (items: StreamNodeInput[], parentDbId: unknown): CreatedStreamNode[] => items.map((item) => {
          const f = streamNodeFields(item);
          const addr = String(item.address).trim();
          const order = Number(addr.slice(addr.lastIndexOf('-') + 1));
          const id = newStableId();
          insert.run(id, targetDocId, parentDbId, order, addr.split('-').length, addr, f.nodeType, f.text, f.nodeTitle || '', f.nodeNote || '', f.sourcePosition, f.trustLevel);
          createdCount += 1;
          const children = Array.isArray(item.children) ? item.children : [];
          return { id, address: addr, children: children.length ? writeTree(children, id) : [] };
        });
        created = writeTree(list, mountId);
        store.touchDoc(targetDocId);
      } else {
        const insertTree = (items: StreamNodeInput[], parent: unknown): CreatedStreamNode[] => items.map((item) => {
          const node = insertStreamNode(store, targetDocId, parent, item);
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

    if (store._bulkTouchedDocIds && result.docId != null) store._bulkTouchedDocIds.add(String(result.docId));
    rememberStreamPush(store, idempotencyKey, result);
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
export function beginBulkImport(store: StreamStore) {
    store.db!.pragma('synchronous = OFF');
    store.db!.pragma('temp_store = MEMORY');
    store.db!.pragma('cache_size = -1048576');
    store.db!.pragma('mmap_size = 1073741824');
    // 记下本批 bulk 写过哪些文档（主库自己的写元信息）：endBulkImport 返回给调用方，
    // 供其触发一次派生索引维护（bulk 期间不逐批维护，避免 O(N²)）。主库不碰派生索引本身。
    store._bulkTouchedDocIds = new Set();
    return {
      ok: true,
      pragmas: { synchronous: 'OFF', journal_mode: 'WAL', cache_size: '1GB', mmap_size: '1GB' }
    };
  }

export function endBulkImport(store: StreamStore) {
    // 不再重建索引（begin 不再 drop，索引全程在线，base schema 也已保证其存在）。
    // 先恢复安全写入再 checkpoint(TRUNCATE)：把批导膨胀的 -wal 押回主库并截断，且本次 checkpoint 落盘有 fsync。
    store.db!.pragma('synchronous = NORMAL');
    store.db!.pragma('wal_checkpoint(TRUNCATE)');
    const touchedDocIds = store._bulkTouchedDocIds ? [...store._bulkTouchedDocIds] : [];
    store._bulkTouchedDocIds = null;
    return {
      ok: true,
      touchedDocIds,
      restoredPragmas: { synchronous: 'NORMAL', journal_mode: 'WAL' },
      checkpoint: 'TRUNCATE'
    };
  }

  // 是否在 bulk 导入会话中：写分发收尾据此判断流式 push 是逐条当场维护（非 bulk）还是
  // 累积留 bulkEnd 统一维护（bulk 中），避免每批整篇重建 BM25 退化成 O(N²)。
export function hasActiveBulkImport(store: StreamStore) {
    return store._bulkTouchedDocIds != null;
  }
