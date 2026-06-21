import { listMemoryVolumeAnchors, selectOrphanedMemoryVolumes } from './volumes.mjs';

// 记忆卷校验扫除（projectneed 15-10-4）：清除「实体锚已被人工删除」的卷（脱锚即非法残留）。
// 删除走正规链路：先删 source 行解锚（deleteDoc 守卫据此放行），再 deleteDoc 连带清 SQLite
// （refs/nodes/source 行）；LanceDB 派生索引不在此碰，留给自检/reconcile 对齐。
// 解锚与删卷非同一事务，但可重入：中途中断留下的「无 source 行」卷下轮扫描仍按脱锚清除。
// anchorExists / deleteDoc 由 host 注入——host 用 lstat 不解引用判锚路径本身在不在、用正规删除入口删卷；
// memory 只负责「挑脱锚卷 + 解锚 + 委托删除」的语义，隔离文件系统与删除实现、便于单测。
/**
 * @param {*} store
 * @param {{ anchorExists?: Function, deleteDoc?: Function, dryRun?: boolean }} [opts]
 */
export async function purgeOrphanedMemoryVolumes(store, { anchorExists, deleteDoc, dryRun = false } = {}) {
  if (typeof anchorExists !== 'function') throw new Error('purgeOrphanedMemoryVolumes requires anchorExists');
  if (typeof deleteDoc !== 'function') throw new Error('purgeOrphanedMemoryVolumes requires deleteDoc');
  const volumes = listMemoryVolumeAnchors(store);
  const orphaned = selectOrphanedMemoryVolumes(volumes, anchorExists);
  const purged = [];
  for (const volume of orphaned) {
    if (!dryRun) {
      store.db.prepare('DELETE FROM source_documents WHERE doc_id = ?').run(volume.docId);
      await deleteDoc({ docId: volume.docId });
    }
    purged.push(volume);
  }
  return { ok: true, action: 'memory.purgeOrphaned', dryRun, scanned: volumes.length, purgedCount: purged.length, purged };
}
