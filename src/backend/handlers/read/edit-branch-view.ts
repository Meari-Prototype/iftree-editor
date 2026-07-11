// L4 分支差异视图：组合 projection、diff 与 entities 三个 L3 域。

import { normalizePositiveId } from '../../db/normalizers.js';
import type { AxiomRow, EditBranchRow, RefRow } from '../../db/schema.js';
import { activeEditBranchEntries, undoneEditBranchEntries } from '../../projection/edit-branch-projection.js';
import type { EditBranchEntry, ProjectionNode } from '../../store/edit-branch-contract.js';
import { buildEditBranchDiffRows, buildAxiomDiffRows } from '../../diff/diff-view.js';
import { buildEntityEditBranchDiffEntries } from '../../entities/write.js';
import type { IftreeStore } from '../../store/index.js';

type RowObject = Record<string, unknown>;
type EditBranchStore = IftreeStore;
type EditBranchPayload = RowObject;
type EditBranchDiff = RowObject & { entries?: EditBranchEntry[] };
type BranchLookupPayload = { branchId?: unknown; shadowDocId?: unknown; baseDocId?: unknown; owner?: unknown };
type TitleRow = { id: string; title: string };
type HeadRow = { head_commit_id: string | null };
type HistoryState = { undoDepth: number; redoDepth: number };
type BaseDocInputs = { nodes: ProjectionNode[]; axioms: AxiomRow[]; refs: RefRow[] };

function rowObject(row: object): RowObject {
  return { ...row };
}

export function getEditBranchDiffView(store: EditBranchStore, { branchId = null, shadowDocId = null, baseDocId = null, owner = 'human', changedOnly = false, includeEntities = false }: EditBranchPayload = {}) {
    const branch = store.findEditBranch({ branchId, shadowDocId, baseDocId, owner } as BranchLookupPayload) as EditBranchRow | null;
    if (!branch) throw new Error('Edit branch not found');
    const docId = normalizePositiveId(branch.base_doc_id);
    if (!docId) throw new Error('Edit branch base doc not found');
    const baseDoc = store.db!.prepare('SELECT id, title FROM docs WHERE id = ?').get<TitleRow>(docId);
    if (!baseDoc) throw new Error('Edit branch base doc not found');
    const { nodes: baseNodes, axioms: baseAxioms, refs: baseRefs }: BaseDocInputs = store.editBranchBaseInputs(docId);
    const diff = JSON.parse(branch.diff || '{}') as EditBranchDiff;
    const baseSnapshot = JSON.parse(branch.base_snapshot || '{}') as RowObject;
    const head = store.db!.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?').get<HeadRow>(docId);
    const entries = Array.isArray(diff.entries) ? diff.entries : [];
    const active = activeEditBranchEntries(entries) as EditBranchEntry[];
    const projected = store.requireEditBranchPort().projectEditBranchDoc({
      docId,
      nodes: baseNodes,
      axioms: baseAxioms,
      refs: baseRefs
    }, active);
    const baseHashes = store.ensureNodeHashes(docId);
    const { rows, stats } = buildEditBranchDiffRows(
      baseNodes.map(rowObject),
      projected.nodes.map(rowObject),
      baseHashes
    );
    // 公理（事实前提）差异行排最前——树视图里它们也画在正文树之外。
    const axiomDiff = buildAxiomDiffRows(baseAxioms.map(rowObject), projected.axioms.map(rowObject));
    stats.added += axiomDiff.stats.added;
    stats.deleted += axiomDiff.stats.deleted;
    stats.modified += axiomDiff.stats.modified;
    stats.totalRows += axiomDiff.rows.length;
    stats.visibleRows += axiomDiff.rows.length;
    const historyState = store.editBranchHistoryState(branch) as HistoryState;

    // 公理改动行排最前（树视图里它们画在正文树之外），再接正文 diff 行。
    let outRows = [...axiomDiff.rows, ...rows];
    if (changedOnly) {
      // 只返改动行（agent/MCP/db 外壳消费路径，projectneed 18-1）：丢掉未改动上下文行与
      // 折叠占位行（含其 hiddenRows 全文），只留 added/deleted/modified。GUI 对比弹窗不传
      // changedOnly，仍拿完整折叠/展开结构。
      outRows = outRows.filter((row) => row.status !== 'unchanged' && row.status !== 'collapsed');
    }

    // entries：草稿↔正文的 field-diff（与 rows 富视图并存），供 formatDiffText 详略轴渲染、与 diff.refs/history.diff 同形。
    const diffEntries: RowObject[] = store.computeDiff(
      { nodes: baseNodes.map(rowObject), axioms: baseAxioms.map(rowObject), refs: baseRefs.map(rowObject) },
      {
        nodes: projected.nodes.map(rowObject),
        axioms: projected.axioms.map(rowObject),
        refs: projected.refs.map(rowObject)
      }
    ).map(rowObject);
    const addrByNode = new Map<unknown, unknown>();
    for (const n of projected.nodes) addrByNode.set(n.id, n.address);
    for (const n of baseNodes) if (!addrByNode.has(n.id)) addrByNode.set(n.id, n.address);
    for (const e of diffEntries) if (e && e.node_id != null && e.address == null) e.address = addrByNode.get(e.node_id) ?? null;

    // 实体改动默认不进 diff（绑定动辄上千、会淹没正文 diff）；diff entity=true 时按动作流追加实体行。
    if (includeEntities) {
      for (const entry of buildEntityEditBranchDiffEntries(store, active, addrByNode)) {
        diffEntries.push(entry);
      }
    }

    return {
      kind: 'editBranch.diffView',
      entries: diffEntries,
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
        activeEntryCount: active.length,
        undoneEntryCount: undoneEditBranchEntries(entries).length,
        undoDepth: historyState.undoDepth,
        redoDepth: historyState.redoDepth,
        changedOnly
      },
      rows: outRows
    };
  }

  // 三方合并物化（A5-10）：取 merge-base（分支 fork 点 commit 的 snapshot）/ ours（当前主干 = live nodes）/
  // theirs（分支 entries 投影到 merge-base），交给 classifyThreeWayMerge 按稳定 id 逐字段三方分类。
  // fast-forward（分支 base commit == 当前 head）时无需三方调和，照现行直接应用本分支生效 diff 即可。
