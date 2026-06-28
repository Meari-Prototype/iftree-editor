import { listMemoryVolumeAnchors, selectOrphanedMemoryVolumes } from './volumes.js';

// 记忆卷校验扫除（projectneed 15-10-4）：清除「实体锚已被人工删除」的卷（脱锚即非法残留）。
// 删除走正规链路：先删 source 行解锚（deleteDoc 守卫据此放行），再 deleteDoc 连带清 SQLite
// （refs/nodes/source 行）；LanceDB 派生索引不在此碰，留给自检/reconcile 对齐。
// 解锚与删卷非同一事务，但可重入：中途中断留下的「无 source 行」卷下轮扫描仍按脱锚清除。
// anchorExists / deleteDoc 由 host 注入——host 用 lstat 不解引用判锚路径本身在不在、用正规删除入口删卷；
// memory 只负责「挑脱锚卷 + 解锚 + 委托删除」的语义，隔离文件系统与删除实现、便于单测。
interface MemoryMaintenanceStore {
  db: {
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
    };
  };
}

interface MemoryVolumeAnchor {
  docId: string;
  anchorPath?: string | null;
  [key: string]: unknown;
}

interface PurgeOrphanedMemoryVolumesOptions {
  anchorExists?: (path: string) => boolean;
  deleteDoc?: (payload: { docId: string }) => unknown | Promise<unknown>;
  dryRun?: boolean;
}

const listMemoryVolumeAnchorsTyped = listMemoryVolumeAnchors as unknown as (
  store: MemoryMaintenanceStore
) => MemoryVolumeAnchor[];
const selectOrphanedMemoryVolumesTyped = selectOrphanedMemoryVolumes as unknown as (
  volumes: MemoryVolumeAnchor[],
  anchorExists: (path: string) => boolean
) => MemoryVolumeAnchor[];

export async function purgeOrphanedMemoryVolumes(
  store: MemoryMaintenanceStore,
  { anchorExists, deleteDoc, dryRun = false }: PurgeOrphanedMemoryVolumesOptions = {}
) {
  if (typeof anchorExists !== 'function') throw new Error('purgeOrphanedMemoryVolumes requires anchorExists');
  if (typeof deleteDoc !== 'function') throw new Error('purgeOrphanedMemoryVolumes requires deleteDoc');
  const volumes = listMemoryVolumeAnchorsTyped(store);
  const orphaned = selectOrphanedMemoryVolumesTyped(volumes, anchorExists);
  const purged: MemoryVolumeAnchor[] = [];
  for (const volume of orphaned) {
    if (!dryRun) {
      store.db!.prepare('DELETE FROM source_documents WHERE doc_id = ?').run(volume.docId);
      await deleteDoc({ docId: volume.docId });
    }
    purged.push(volume);
  }
  return { ok: true, action: 'memory.purgeOrphaned', dryRun, scanned: volumes.length, purgedCount: purged.length, purged };
}
