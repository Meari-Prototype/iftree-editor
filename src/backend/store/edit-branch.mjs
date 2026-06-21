// 编辑分支子系统（A5-5 / A5-10 / 15-5-2）：影子文档投影 + 暂存动作（22 个 stage）+ 重放落库 +
// 三方合并与人工裁决 + 乐观并发前置校验 + 撤销/重做/拣选/变基。纯函数模块，门面 IftreeStore
// 实例作首参——store.db 与底座的主 CRUD / 快照提交原语经它访问，模块不反向 import 门面。
// index.mjs 上每个方法保留一行同名转调壳；编辑分支方法之间也经门面句柄互调（store.xxx），
// 与历史/记忆子系统同构（参数化 store、对外门面壳）。

import { splitSentences } from '../../core/tree.mjs';
import { normalizeNodeType } from '../../core/node-model.mjs';
import { classifyThreeWayMerge } from '../../core/merkle-merge.mjs';
import { computeSubtreeHashes, contentHash } from '../../core/merkle.mjs';
import { parseJsonObject, hasOwnValue, assertNoHumanTagField, assertNoEditTrustField } from '../shared.mjs';
import { applyEntityEntry } from '../entities/write.mjs';
import { sameStableId } from '../db/ids.mjs';
import { normalizePositiveId, normalizeSourcePosition, patchValue } from '../db/normalizers.mjs';
import {
  activeEditBranchEntries,
  isSupportedEditBranchEntryKind,
  isTmpId,
  nextTmpId,
  projectEditBranchDoc,
  resolveConflictEntries,
  undoneEditBranchEntries
} from '../edit-branch-projection.mjs';
import { buildEditBranchDiffRows, buildAxiomDiffRows, nodeRowWithClientAliases } from '../diff-view.mjs';

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

/** @param {any} [entry] edit-branch diff entry（kind/patch/fields 形态随动作而异） */
function editBranchEntryTouchesTrust(entry = {}) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.kind === 'node.update') {
    if (hasOwnValue(entry.patch, 'trust_level', 'trustLevel', 'trust')) return true;
    return Array.isArray(entry.fields) && entry.fields.some((field) => (
      field && ['trust_level', 'trustLevel', 'trust'].includes(String(field.field || ''))
    ));
  }
  if (entry.kind === 'node.insert') {
    if (!hasOwnValue(entry.fields, 'trust_level', 'trustLevel', 'trust')) return false;
    const value = entry.fields?.trust_level ?? entry.fields?.trustLevel ?? entry.fields?.trust;
    return value !== null && value !== undefined && value !== '';
  }
  return false;
}

export function normalizeEditBranchOwner(store, owner = 'human') {
    const value = String(owner || '').trim();
    return value || 'human';
  }

export function activeEditBranchForBaseDoc(store, docId, owner = 'human') {
    if (!store.hasEditBranchesTable()) return null;
    return store.db.prepare(`
      SELECT * FROM edit_branches
      WHERE base_doc_id = ? AND owner = ? AND status = 'active'
      ORDER BY id DESC
      LIMIT 1
    `).get(normalizePositiveId(docId), store.normalizeEditBranchOwner(owner)) || null;
  }

export function activeEditBranchForShadowDoc(store, docId) {
    if (!store.hasEditBranchesTable()) return null;
    return store.db.prepare(`
      SELECT * FROM edit_branches
      WHERE shadow_doc_id = ? AND status = 'active'
      ORDER BY id DESC
      LIMIT 1
    `).get(normalizePositiveId(docId)) || null;
  }

export function activeEditBranchForDoc(store, docId, owner = null) {
    const shadow = store.activeEditBranchForShadowDoc(docId);
    if (shadow) {
      if (!owner || shadow.owner === store.normalizeEditBranchOwner(owner)) return shadow;
      return store.activeEditBranchForBaseDoc(shadow.base_doc_id, owner);
    }
    if (!owner) return null;
    return store.activeEditBranchForBaseDoc(docId, owner);
  }

export function listActiveEditBranches(store, owner = null) {
    if (!store.hasEditBranchesTable()) return [];
    const normalizedOwner = owner ? store.normalizeEditBranchOwner(owner) : null;
    const where = normalizedOwner ? 'WHERE eb.status = \'active\' AND eb.owner = ?' : 'WHERE eb.status = \'active\'';
    const params = normalizedOwner ? [normalizedOwner] : [];
    return store.db.prepare(`
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

export function docIdForMutationPayload(store, payload = {}) {
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
      const node = store.db.prepare('SELECT doc_id FROM nodes WHERE id = ?').get(nodeId);
      if (node) return node.doc_id;
    }
    const axiomId = normalizePositiveId(payload.axiomId ?? payload.axiom_id);
    if (axiomId !== null) {
      const axiom = store.db.prepare('SELECT doc_id FROM axioms WHERE id = ?').get(axiomId);
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
      const entity = store.db.prepare('SELECT doc_id FROM entities WHERE id = ?').get(entityId);
      if (entity) return entity.doc_id;
    }
    const refId = normalizePositiveId(payload.refId ?? payload.ref_id);
    if (refId !== null) {
      const ref = store.db.prepare('SELECT * FROM refs WHERE id = ?').get(refId);
      if (ref?.source_type === 'node') {
        const node = store.db.prepare('SELECT doc_id FROM nodes WHERE id = ?').get(ref.source_id);
        if (node) return node.doc_id;
      }
      if (ref?.target_type === 'node') {
        const node = store.db.prepare('SELECT doc_id FROM nodes WHERE id = ?').get(ref.target_id);
        if (node) return node.doc_id;
      }
      if (ref?.source_type === 'axiom') {
        const axiom = store.db.prepare('SELECT doc_id FROM axioms WHERE id = ?').get(ref.source_id);
        if (axiom) return axiom.doc_id;
      }
      if (ref?.target_type === 'axiom') {
        const axiom = store.db.prepare('SELECT doc_id FROM axioms WHERE id = ?').get(ref.target_id);
        if (axiom) return axiom.doc_id;
      }
    }
    return null;
  }

export function nodePatchForEditBranch(store, current, patch = {}) {
    assertNoHumanTagField(patch, 'node.update patch');
    assertNoEditTrustField(patch, 'node.update patch');
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
    return next;
  }

export function _appendEditBranchEntry(store, branch, entry) {
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
    store.db.prepare(`
      UPDATE edit_branches
      SET diff = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(nextDiff), branch.id);
    return store.db.prepare('SELECT * FROM edit_branches WHERE id = ?').get(branch.id);
  }

export function editBranchHistoryState(store, branch) {
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

export function getEditBranchDiffView(store, { branchId = null, shadowDocId = null, baseDocId = null, owner = 'human', changedOnly = false } = {}) {
    const branch = store.findEditBranch({ branchId, shadowDocId, baseDocId, owner });
    if (!branch) throw new Error('Edit branch not found');
    const docId = normalizePositiveId(branch.base_doc_id);
    if (!docId) throw new Error('Edit branch base doc not found');
    const baseDoc = store.db.prepare('SELECT id, title FROM docs WHERE id = ?').get(docId);
    if (!baseDoc) throw new Error('Edit branch base doc not found');
    const { nodes: baseNodes, axioms: baseAxioms, refs: baseRefs } = store._baseDocInputsForDoc(docId);
    const diff = JSON.parse(branch.diff || '{}');
    const baseSnapshot = JSON.parse(branch.base_snapshot || '{}');
    const head = store.db.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?').get(docId);
    const entries = Array.isArray(diff.entries) ? diff.entries : [];
    const activeEntries = activeEditBranchEntries(entries);
    const projected = projectEditBranchDoc({
      docId,
      nodes: baseNodes,
      axioms: baseAxioms,
      refs: baseRefs
    }, activeEntries);
    const baseHashes = store.ensureNodeHashes(docId);
    const { rows, stats } = buildEditBranchDiffRows(baseNodes, projected.nodes, baseHashes);
    // 公理（事实前提）差异行排最前——树视图里它们也画在正文树之外。
    const axiomDiff = buildAxiomDiffRows(baseAxioms, projected.axioms);
    stats.added += axiomDiff.stats.added;
    stats.deleted += axiomDiff.stats.deleted;
    stats.modified += axiomDiff.stats.modified;
    stats.totalRows += axiomDiff.rows.length;
    stats.visibleRows += axiomDiff.rows.length;
    const historyState = store.editBranchHistoryState(branch);

    // 公理改动行排最前（树视图里它们画在正文树之外），再接正文 diff 行。
    let outRows = [...axiomDiff.rows, ...rows];
    if (changedOnly) {
      // 只返改动行（agent/MCP/db 外壳消费路径，projectneed 18-1）：丢掉未改动上下文行与
      // 折叠占位行（含其 hiddenRows 全文），只留 added/deleted/modified。GUI 对比弹窗不传
      // changedOnly，仍拿完整折叠/展开结构。
      outRows = outRows.filter((row) => row.status !== 'unchanged' && row.status !== 'collapsed');
    }

    // entries：草稿↔正文的 field-diff（与 rows 富视图并存），供 formatDiffText 详略轴渲染、与 diff.refs/history.diff 同形。
    const diffEntries = store.computeDiff(
      { nodes: baseNodes, axioms: baseAxioms, refs: baseRefs },
      { nodes: projected.nodes, axioms: projected.axioms, refs: projected.refs }
    );
    const addrByNode = new Map();
    for (const n of projected.nodes) addrByNode.set(n.id, n.address);
    for (const n of baseNodes) if (!addrByNode.has(n.id)) addrByNode.set(n.id, n.address);
    for (const e of diffEntries) if (e && e.node_id != null && e.address == null) e.address = addrByNode.get(e.node_id) ?? null;

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
        activeEntryCount: activeEntries.length,
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
export function computeThreeWayMerge(store, { branchId = null, shadowDocId = null, baseDocId = null, owner = 'human' } = {}) {
    const branch = store.findEditBranch({ branchId, shadowDocId, baseDocId, owner });
    if (!branch) throw new Error('Edit branch not found');
    const docId = branch.base_doc_id;
    const baseSnapshot = parseJsonObject(branch.base_snapshot) || {};
    const baseCommitId = baseSnapshot.baseCommitId || null;
    const head = store.db.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?').get(docId);
    const headCommitId = head?.head_commit_id || null;
    const fastForward = (baseCommitId || null) === (headCommitId || null);

    // ours = 当前主干 = live nodes
    const oursNodes = store.db.prepare(`
      SELECT * FROM nodes WHERE doc_id = ?
      ORDER BY parent_id IS NOT NULL, parent_id, sort_order, id
    `).all(docId);

    // merge-base = 分支 fork 点 commit 的 snapshot；缺 fork commit 时退化为 ours（等价快进）
    let mergeBaseNodes = oursNodes;
    let mergeBaseAxioms = store.listAxioms(docId);
    let mergeBaseRefs = store._fetchBaseRefsForDoc(docId);
    if (baseCommitId) {
      const snap = store.commitSnapshot(baseCommitId);
      if (snap && Array.isArray(snap.nodes)) {
        mergeBaseNodes = snap.nodes;
        mergeBaseAxioms = Array.isArray(snap.axioms) ? snap.axioms : [];
        mergeBaseRefs = Array.isArray(snap.refs) ? snap.refs : [];
      }
    }

    // theirs = 本分支：entries 投影到 merge-base（不是投影到 live，避免与主干变更混淆）
    const diff = parseJsonObject(branch.diff) || {};
    const entries = activeEditBranchEntries(diff.entries);
    const theirs = projectEditBranchDoc({
      docId,
      nodes: mergeBaseNodes,
      axioms: mergeBaseAxioms,
      refs: mergeBaseRefs
    }, entries);

    const merge = classifyThreeWayMerge(mergeBaseNodes, oursNodes, theirs.nodes);
    // 给逐节点结果附上 address/title 供冲突解决 UI 标识节点（ours=live 优先，其次 theirs，再 base）。
    const displayById = new Map();
    for (const list of [mergeBaseNodes, theirs.nodes, oursNodes]) {
      for (const node of list) {
        displayById.set(String(node.id), {
          address: node.address || '',
          title: node.node_title ?? node.nodeTitle ?? ''
        });
      }
    }
    const nodes = merge.nodes.map((node) => ({
      ...node,
      address: displayById.get(String(node.id))?.address || '',
      title: displayById.get(String(node.id))?.title || ''
    }));
    return {
      kind: 'editBranch.threeWayMerge',
      branch: { ...branch },
      fastForward,
      baseCommitId,
      headCommitId,
      nodeCounts: { base: mergeBaseNodes.length, ours: oursNodes.length, theirs: theirs.nodes.length },
      ...merge,
      nodes
    };
  }

  // ─── 非快进保存的逐条前置验证（乐观并发，A5-10）──────────────
  // 账目在 stage 时记了「对什么状态做」：update 的 {field, old, new}、delete 的子树指纹、
  // split/merge 的正文指纹、移动类的 before_parent_id。保存时按 UUID 主键点查主干现值逐条比：
  //   现值==原值 → 前置成立；现值==新值 → 两侧收敛；否则冲突。
  // 成本 O(分支改动数) 次点查，不扫库、不解析快照（仅旧账目缺 before 时退化用 fork 快照补原值）。
  // 输出两类：conflicts（字段级/删改级，可经三列面板人裁）与 blocked（结构性失配，
  // v1 不可裁——主干已被修改，只能放弃本次编辑；清理敏感信息等历史重写后属常态）。

export function _trunkNodeRow(store, docId, ref) {
    if (ref === null || ref === undefined || isTmpId(ref)) return null;
    return store.db.prepare('SELECT * FROM nodes WHERE id = ? AND doc_id = ?').get(ref, docId) || null;
  }

export function _trunkSubtreeHash(store, docId, ref) {
    if (!store._trunkNodeRow(docId, ref)) return null;
    const rows = store.db.prepare(`
      WITH RECURSIVE subtree(id) AS (
        SELECT id FROM nodes WHERE id = ?
        UNION ALL
        SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
      )
      SELECT n.id, n.parent_id, n.sort_order, n.text, n.node_title, n.node_note, n.node_type, n.trust_level
      FROM nodes n JOIN subtree s ON n.id = s.id
    `).all(ref);
    // 子树根的父在集合外：置空让它成为遍历根（subtree_hash 本就 parent-independent）。
    const detached = rows.map((row) => (sameStableId(row.id, ref) ? { ...row, parent_id: null } : row));
    return computeSubtreeHashes(detached).get(String(ref))?.subtreeHash || null;
  }

export function _validateEditBranchEntriesAgainstTrunk(store, branch, entries) {
    const docId = branch.base_doc_id;
    const norm = (value) => (value === null || value === undefined ? null : String(value));

    // 分支自建的 tmp 节点：重放时一并创建，引用它们无需主干前置。
    const tmpCreated = new Set();
    for (const entry of entries) {
      if (entry.kind === 'node.insert' && entry.tmp_id) tmpCreated.add(entry.tmp_id);
      if (entry.kind === 'node.split') {
        for (const tmpId of entry.new_node_ids || []) tmpCreated.add(tmpId);
        for (const split of entry.paragraph_splits || []) {
          for (const span of split.spans || []) if (span.tmp_id) tmpCreated.add(span.tmp_id);
        }
      }
    }
    const refExists = (ref) => {
      if (ref === null || ref === undefined) return false;
      if (isTmpId(ref)) return tmpCreated.has(ref);
      return Boolean(store._trunkNodeRow(docId, ref));
    };

    // 旧账目缺 before 数据时退化用 fork 快照补原值（懒解析一次；快照缺失则视为无前置=旧盲存行为）。
    let forkNodes;
    const forkNode = (ref) => {
      if (forkNodes === undefined) {
        forkNodes = null;
        const baseCommitId = (parseJsonObject(branch.base_snapshot) || {}).baseCommitId || null;
        if (baseCommitId) {
          const snap = store.commitSnapshot(baseCommitId);
          if (snap && Array.isArray(snap.nodes)) {
            forkNodes = new Map(snap.nodes.map((node) => [String(node.id), node]));
          }
        }
      }
      return forkNodes ? forkNodes.get(String(ref)) || null : null;
    };
    const forkSubtreeHash = (ref) => {
      if (!forkNode(ref)) return null;
      const detached = [...forkNodes.values()].map((node) => (
        sameStableId(node.id, ref) ? { ...node, parent_id: null } : node
      ));
      return computeSubtreeHashes(detached).get(String(ref))?.subtreeHash || null;
    };

    const blocked = [];
    const conflicts = [];
    const fieldAgg = new Map();
    const block = (id, kind, reason, address = '') => blocked.push({ id: norm(id), kind, reason, address });
    // 拆分/并入的内容前置：节点须仍在主干且正文未漂移（拼接/截句都基于入账时所见内容）。
    const checkContentIntact = (ref, beforeHash, address = '') => {
      if (ref === null || ref === undefined || isTmpId(ref)) return;
      const row = store._trunkNodeRow(docId, ref);
      if (!row) {
        block(ref, 'node-deleted', '主干已删除该节点，分支的拆分/并入无法应用', address);
        return;
      }
      const fork = forkNode(ref);
      const before = beforeHash || (fork ? contentHash(fork) : null);
      if (before && contentHash(row) !== before) {
        block(ref, 'content-drift', '主干已修改该节点的内容，分支基于旧内容的拆分/并入无法应用', row.address || address);
      }
    };

    for (const entry of entries) {
      switch (entry.kind) {
        case 'node.update': {
          const ref = entry.node_id ?? entry.target_ref;
          if (isTmpId(ref)) break; // 改自己新建的节点，无主干前置
          const row = store._trunkNodeRow(docId, ref);
          if (!row) {
            block(ref, 'node-deleted', '主干已删除该节点，分支对它的修改无法应用（复活不支持）', entry.address || '');
            break;
          }
          const fieldList = Array.isArray(entry.fields) && entry.fields.length > 0
            ? entry.fields
            : Object.entries(entry.patch || {}).map(([field, value]) => ({ field, new: value ?? null }));
          for (const item of fieldList) {
            if (!item || !item.field) continue;
            const key = `${norm(ref)}::${item.field}`;
            if (!fieldAgg.has(key)) {
              // 链式多次改同字段：取最早一条的 old（=入账时所见原值），最后一条的 new（=分支终值）。
              const fork = forkNode(ref);
              const old = Object.prototype.hasOwnProperty.call(item, 'old')
                ? item.old
                : (fork ? fork[item.field] : undefined);
              fieldAgg.set(key, { id: norm(ref), field: item.field, old, next: item.new });
            } else {
              fieldAgg.get(key).next = item.new;
            }
          }
          break;
        }
        case 'node.insert': {
          if (!refExists(entry.parent_ref)) {
            block(entry.parent_ref, 'parent-deleted', '主干已删除目标父节点，分支在其下的新增无法挂载');
          }
          break; // after_ref 只定位置，缺了重放容错为追加，不算冲突
        }
        case 'node.delete': {
          const ref = entry.target_ref ?? entry.node_id;
          if (isTmpId(ref)) break;
          if (!store._trunkNodeRow(docId, ref)) break; // 主干也删了 → 收敛
          const before = entry.before_subtree_hash || forkSubtreeHash(ref) || null;
          if (before && store._trunkSubtreeHash(docId, ref) !== before) {
            // 分支删 / 主干改 → 删改冲突，可人裁：取主干=撤回删除，取本分支=照删。
            conflicts.push({ id: norm(ref), field: '__node__', base: 'present', ours: 'modified', theirs: 'deleted' });
          }
          break;
        }
        case 'node.move':
          break; // 同父排序，位置不进冲突；节点已删由重放容错跳过
        case 'node.promote':
        case 'node.reparent':
        case 'node.moveBefore':
        case 'node.moveAfter': {
          const ref = entry.node_ref ?? entry.target_ref ?? entry.node_id;
          if (isTmpId(ref)) break;
          const row = store._trunkNodeRow(docId, ref);
          if (!row) {
            // 显式重挂/提升的对象已被主干删除 → 复活不支持；纯排序（moveBefore/After）位置意图失效，跳过即可。
            if (entry.kind === 'node.reparent' || entry.kind === 'node.promote') {
              block(ref, 'node-deleted', '主干已删除该节点，分支对它的移动无法应用');
            }
            break;
          }
          const fork = forkNode(ref);
          const beforeParent = Object.prototype.hasOwnProperty.call(entry, 'before_parent_id')
            ? entry.before_parent_id
            : (fork ? fork.parent_id : undefined);
          if (beforeParent !== undefined) {
            const currentParent = norm(row.parent_id);
            const intended = entry.kind === 'node.reparent' ? norm(entry.new_parent_ref) : undefined;
            if (currentParent !== norm(beforeParent) && currentParent !== intended) {
              block(ref, 'parent-conflict', '主干已移动该节点，与分支的移动冲突', row.address || '');
              break;
            }
          }
          if (entry.kind === 'node.reparent' && !refExists(entry.new_parent_ref)) {
            block(entry.new_parent_ref, 'parent-deleted', '主干已删除目标父节点，分支的移动无法挂载');
          }
          break; // moveBefore/After 的锚点缺失只影响位置，重放容错跳过
        }
        case 'node.split': {
          if (entry.strategy === 'source_paragraphs' && Array.isArray(entry.paragraph_splits)) {
            for (const split of entry.paragraph_splits) {
              checkContentIntact(split.paragraph_node_id, split.before_content_hash || null);
            }
          } else {
            checkContentIntact(entry.target_ref ?? entry.node_id, entry.before_content_hash || null, entry.address || '');
          }
          break;
        }
        case 'node.mergeInto':
        case 'node.mergePrevious': {
          checkContentIntact(entry.source_ref ?? entry.node_id, entry.source_before_content_hash || null);
          if (entry.target_ref !== null && entry.target_ref !== undefined) {
            checkContentIntact(entry.target_ref, entry.target_before_content_hash || null);
          }
          break;
        }
        default:
          break; // axiom/ref/entity：v1 不做主干前置（与既有行为一致），照常重放
      }
    }

    // 字段三态：现值==分支终值 → 收敛；现值==原值 → 主干没动；否则冲突（原值不可知时保守按冲突，base 置空）。
    for (const item of fieldAgg.values()) {
      const row = store._trunkNodeRow(docId, item.id);
      if (!row) continue; // 已在 update 处 block
      const current = norm(row[item.field]);
      const next = norm(item.next);
      if (current === next) continue;
      if (item.old !== undefined && current === norm(item.old)) continue;
      conflicts.push({
        id: item.id,
        field: item.field,
        base: item.old === undefined ? null : norm(item.old),
        ours: current,
        theirs: next
      });
    }

    // 面板数据：按节点聚合冲突，附 address/title 标识。
    const nodes = [];
    const byNode = new Map();
    for (const conflict of conflicts) {
      if (!byNode.has(conflict.id)) {
        const row = store._trunkNodeRow(docId, conflict.id);
        const node = {
          id: conflict.id,
          resolution: 'conflict',
          address: row?.address || '',
          title: row?.node_title || '',
          conflicts: []
        };
        byNode.set(conflict.id, node);
        nodes.push(node);
      }
      byNode.get(conflict.id).conflicts.push(conflict);
    }
    return { conflicts, nodes, blocked };
  }

  // 保存闸门（A5-10）：快进直接重放（lazy diff 本职，前置必然成立）；非快进走逐条前置验证：
  //   - blocked（结构性失配）→ 拒绝写回：「主干已被修改，无法保存，请放弃本次编辑」；
  //     前端取消可保留分支（自行留存 diff 后再放弃），确认则丢弃分支退出。
  //   - conflicts（字段级/删改级）→ 无人裁拒绝并返回冲突；带 resolutions 折进账目后提交。
  //   - 干净/收敛 → 直接重放写回。
export function applyThreeWayMerge(store, { branchId = null, shadowDocId = null, baseDocId = null, owner = 'human', summary = '三方合并', resolutions = null, strategy = null } = {}) {
    const branch = store.findEditBranch({ branchId, shadowDocId, baseDocId, owner });
    if (!branch) throw new Error('Edit branch not found');
    const docId = branch.base_doc_id;
    const baseCommitId = (parseJsonObject(branch.base_snapshot) || {}).baseCommitId || null;
    const head = store.db.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?').get(docId);
    const headCommitId = head?.head_commit_id || null;
    const fastForward = (baseCommitId || null) === (headCommitId || null);
    const rawPayload = parseJsonObject(branch.diff) || {};
    const entries = activeEditBranchEntries(rawPayload.entries);
    const meta = {
      kind: 'editBranch.threeWayMerge.apply',
      baseDocId: docId,
      fastForward,
      baseCommitId,
      headCommitId
    };

    if (fastForward || entries.length === 0) {
      return { ...meta, applied: true, ...store._commitEditBranchPayload(branch, rawPayload, summary) };
    }

    const validation = store._validateEditBranchEntriesAgainstTrunk(branch, entries);
    if (validation.blocked.length > 0) {
      return {
        ...meta,
        applied: false,
        blocked: true,
        message: '主干已被修改，无法保存，请放弃本次编辑',
        blockedConflicts: validation.blocked,
        conflicts: validation.conflicts,
        nodes: validation.nodes
      };
    }
    if (validation.conflicts.length > 0) {
      // 整批策略（strategy=ours/theirs，对应 git -X）是逐条裁决的语法糖：把冲突清单映射成统一 pick，
      // 一处合成、MCP/CLI 都不必各做一遍 dry-run；结构性冲突（parent_id/__parent__）仍由 resolveConflictEntries 拒绝。
      const picks = Array.isArray(resolutions) && resolutions.length > 0
        ? resolutions
        : (strategy === 'ours' || strategy === 'theirs')
          ? validation.conflicts.map((c) => ({ id: c.id, field: c.field, pick: strategy }))
          : [];
      if (picks.length === 0) {
        return { ...meta, applied: false, conflicts: validation.conflicts, nodes: validation.nodes };
      }
      const { entries: folded, errors } = resolveConflictEntries({
        entries: rawPayload.entries,
        conflicts: validation.conflicts,
        resolutions: picks
      });
      if (errors.length > 0) {
        return { ...meta, applied: false, resolutionErrors: errors, conflicts: validation.conflicts, nodes: validation.nodes };
      }
      return { ...meta, applied: true, resolved: true, ...store._commitEditBranchPayload(branch, { ...rawPayload, entries: folded }, summary) };
    }
    return { ...meta, applied: true, ...store._commitEditBranchPayload(branch, rawPayload, summary) };
  }

export function _replaceEditBranchDiff(store, branch, diff) {
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
    store.db.prepare(`
      UPDATE edit_branches
      SET diff = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(nextDiff), branch.id);
    return store.db.prepare('SELECT * FROM edit_branches WHERE id = ?').get(branch.id);
  }

export function undoEditBranchEntry(store, { branchId = null, shadowDocId = null, baseDocId = null, owner = 'human' } = {}) {
    const branch = store.findEditBranch({ branchId, shadowDocId, baseDocId, owner });
    if (!branch) throw new Error('Edit branch not found');
    const diff = JSON.parse(branch.diff || '{}');
    const entries = Array.isArray(diff.entries) ? [...diff.entries] : [];
    const index = entries.findLastIndex((entry) => activeEditBranchEntries([entry]).length === 1);
    if (index < 0) {
      return { changed: false, branch, ...store.editBranchHistoryState(branch) };
    }
    const updatedAt = new Date().toISOString();
    entries[index] = { ...entries[index], status: 'undone', undoneAt: updatedAt };
    const freshBranch = store._replaceEditBranchDiff(branch, { ...diff, entries });
    return { changed: true, branch: freshBranch, ...store.editBranchHistoryState(freshBranch) };
  }

export function redoEditBranchEntry(store, { branchId = null, shadowDocId = null, baseDocId = null, owner = 'human' } = {}) {
    const branch = store.findEditBranch({ branchId, shadowDocId, baseDocId, owner });
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
      return { changed: false, branch, ...store.editBranchHistoryState(branch) };
    }
    const restored = { ...entries[index], status: 'active' };
    delete restored.undoneAt;
    entries[index] = restored;
    const freshBranch = store._replaceEditBranchDiff(branch, { ...diff, entries });
    return { changed: true, branch: freshBranch, ...store.editBranchHistoryState(freshBranch) };
  }

  // Fetch the doc-scoped refs (both endpoints in either nodes or axioms of the
  // doc). Shared between getDoc and _projectedDocForBranch so the lazy diff
  // projection always sees the same set of ref rows that the read path does.
export function _fetchBaseRefsForDoc(store, docId) {
    return store.db.prepare(`
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

  // 某文档当前正文（base）的投影输入：节点（父→排序→id 稳定序）、公理、引用。diffView / 投影 / liveDocSnapshot
  // 共用这一份取数，省得三处各写一遍、nodes 排序或 base 取法要改时追三处。
export function _baseDocInputsForDoc(store, docId) {
    const id = normalizePositiveId(docId);
    const nodes = store.db.prepare(`
      SELECT * FROM nodes WHERE doc_id = ?
      ORDER BY parent_id IS NOT NULL, parent_id, sort_order, id
    `).all(id);
    return { docId: id, nodes, axioms: store.listAxioms(id), refs: store._fetchBaseRefsForDoc(id) };
  }

  // Read the doc with all entries from `branch` already projected on top of the
  // base tables. Returns the projection state (nodes/axioms/refs maps) — the
  // caller can use it to derive `node`, `axiom`, or `ref` views to hand back
  // to the front-end after a stage operation.
export function _projectedDocForBranch(store, branch) {
    const diff = JSON.parse(branch.diff || '{}');
    const entries = Array.isArray(diff.entries) ? diff.entries : [];
    return projectEditBranchDoc(store._baseDocInputsForDoc(branch.base_doc_id), entries);
  }

  // 把某文档当前正文（HEAD）投影成快照 {nodes(含 address),axioms,refs}，供 diff.refs 与历史/草稿快照同形比对。
  // 空 entries 投影 = 正文本身，但复用投影器算地址，地址口径与草稿/历史快照一致（computeDiff 按稳定 id 配对）。
export function liveDocSnapshot(store, docId) {
    return projectEditBranchDoc(store._baseDocInputsForDoc(docId), []);
  }

export function _findProjectedNode(store, state, ref) {
    if (ref === null || ref === undefined) return null;
    if (isTmpId(ref)) return state.nodes.find((node) => node.id === ref) || null;
    return state.nodes.find((node) => sameStableId(node.id, ref)) || null;
  }

export function _findProjectedAxiom(store, state, ref) {
    if (ref === null || ref === undefined) return null;
    if (isTmpId(ref)) return state.axioms.find((axiom) => axiom.id === ref) || null;
    return state.axioms.find((axiom) => sameStableId(axiom.id, ref)) || null;
  }

export function stageEditBranchNodeUpdate(store, branch, payload = {}) {
    assertNoEditTrustField(payload, 'node.update payload');
    const nodeRef = payload.nodeId ?? payload.node_id;
    if (nodeRef === null || nodeRef === undefined) throw new Error('node.update requires nodeId');
    const before = store._projectedDocForBranch(branch);
    const currentNode = store._findProjectedNode(before, nodeRef);
    if (!currentNode) throw new Error(`Node not found in edit branch: ${nodeRef}`);
    // 接受顶层字段或 patch 包：不强制调用方手写嵌套 { patch: {...} }（不裸 json，见 15-5-2）。
    // nodePatchForEditBranch 按白名单取字段，顶层混入的 nodeId/action/owner 等非字段会被忽略。
    const requestedPatch = store.nodePatchForEditBranch(currentNode, payload.patch ?? payload);
    if (Object.keys(requestedPatch).length === 0) {
      throw new Error('node.update 需要至少一个可改字段（text / nodeType / nodeTitle / nodeNote / sourcePosition），放在顶层或 patch 内均可');
    }
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
      // 提供了字段但值与现状相同——合法 no-op，非错误
      return { branch, changed: false, node: nodeRowWithClientAliases(currentNode) };
    }
    const freshBranch = store._appendEditBranchEntry(branch, {
      kind: 'node.update',
      action: 'patch',
      node_id: currentNode.id,
      address: currentNode.address || '',
      patch,
      fields
    });
    const after = store._projectedDocForBranch(freshBranch);
    const projectedNode = store._findProjectedNode(after, currentNode.id) || currentNode;
    return { branch: freshBranch, changed: true, node: nodeRowWithClientAliases(projectedNode) };
  }

export function stageEditBranchNodeInsert(store, branch, payload = {}) {
    assertNoHumanTagField(payload, 'node.insert payload');
    assertNoEditTrustField(payload, 'node.insert payload');
    const docId = normalizePositiveId(branch.base_doc_id);
    const afterRef = payload.afterNodeId ?? payload.after_node_id ?? null;
    let parentRef = payload.parentId ?? payload.parent_id ?? null;
    if (parentRef === null || parentRef === undefined) {
      // afterNodeId 自足：锚点一确定，父（=锚点的父）与位次（=锚点之后）在地址体系下唯一确定，
      // 无需再抄一遍 parentId。只有插为首个子节点 / 插进空父（没有前序兄弟可锚）才必须 parentId。
      if (afterRef === null || afterRef === undefined) {
        throw new Error('node.insert 需要 parentId（插为首个子节点或空父下），或 afterNodeId（插在某节点之后，父从锚点推断）');
      }
      const projected = store._projectedDocForBranch(branch);
      const anchor = store._findProjectedNode(projected, afterRef);
      if (!anchor) throw new Error(`node.insert afterNodeId 锚点不存在: ${afterRef}`);
      if (anchor.parent_id === null || anchor.parent_id === undefined) {
        throw new Error('node.insert 不能插在根节点之后（根唯一）；要在根下插入请给 parentId');
      }
      parentRef = anchor.parent_id;
    }
    const tmpId = nextTmpId('node');
    const fields = {
      text: typeof payload.text === 'string' ? payload.text : '',
      node_type: normalizeNodeType(payload.nodeType ?? payload.node_type ?? 'TEXT'),
      node_title: payload.nodeTitle ?? payload.node_title ?? '',
      node_note: payload.nodeNote ?? payload.node_note ?? '',
      source_position: normalizeSourcePosition(payload.sourcePosition ?? payload.source_position ?? null)
    };
    const freshBranch = store._appendEditBranchEntry(branch, {
      kind: 'node.insert',
      tmp_id: tmpId,
      parent_ref: parentRef,
      after_ref: afterRef,
      fields
    });
    const after = store._projectedDocForBranch(freshBranch);
    const inserted = store._findProjectedNode(after, tmpId);
    return {
      branch: freshBranch,
      changed: true,
      docId,
      node: inserted ? nodeRowWithClientAliases(inserted) : null,
      insertedNodeId: tmpId
    };
  }

export function stageEditBranchNodeDelete(store, branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    if (ref === null || ref === undefined) throw new Error('node.delete requires nodeId');
    const before = store._projectedDocForBranch(branch);
    const target = store._findProjectedNode(before, ref);
    if (!target) throw new Error(`Node not found in edit branch: ${ref}`);
    if (target.parent_id === null || target.parent_id === undefined) {
      throw new Error('Cannot delete document root node');
    }
    const freshBranch = store._appendEditBranchEntry(branch, {
      kind: 'node.delete',
      target_ref: target.id,
      address: target.address || '',
      // 乐观并发前置（A5-10）：记下主干当下这棵子树的指纹，保存时一致才允许照删——
      // 「删除时至少该知道删的是什么」。tmp 目标（分支自建）无主干前置，记 null。
      before_subtree_hash: store._trunkSubtreeHash(docId, target.id)
    });
    return { branch: freshBranch, changed: true, docId };
  }

export function stageEditBranchNodeMove(store, branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    if (ref === null || ref === undefined) throw new Error('node.move requires nodeId');
    const direction = payload.direction === 'up' ? 'up' : 'down';
    const freshBranch = store._appendEditBranchEntry(branch, {
      kind: 'node.move',
      target_ref: ref,
      direction
    });
    return { branch: freshBranch, changed: true, docId };
  }

export function stageEditBranchNodePromote(store, branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    if (ref === null || ref === undefined) throw new Error('node.promote requires nodeId');
    const trunkRow = store._trunkNodeRow(docId, ref);
    const freshBranch = store._appendEditBranchEntry(branch, {
      kind: 'node.promote',
      target_ref: ref,
      ...(trunkRow ? { before_parent_id: trunkRow.parent_id } : {})
    });
    return { branch: freshBranch, changed: true, docId };
  }

export function stageEditBranchNodeSplit(store, branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    if (ref === null || ref === undefined) throw new Error('node.split requires nodeId');
    const before = store._projectedDocForBranch(branch);
    const target = store._findProjectedNode(before, ref);
    if (!target) throw new Error(`Node not found in edit branch: ${ref}`);

    // Source-paragraph mode: when target's subtree (in the real base table)
    // has childless paragraph nodes with source_spans, mirror what
    // splitNodeIntoChildren -> splitSourceParagraphsIntoSentenceChildren would
    // do. Only base node ids can carry source_spans; pending-insert tmp nodes
    // never do.
    if (!isTmpId(target.id)) {
      const candidates = store.db.prepare(`
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
      const baseChildCount = store.db.prepare('SELECT COUNT(*) AS count FROM nodes WHERE parent_id = ?');
      const spansStmt = store.db.prepare('SELECT * FROM source_spans WHERE node_id = ? ORDER BY sentence_index, id');
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
          // 乐观并发前置：拆分基于该段当下的内容，保存时内容漂移则拒绝（candidate 是主干行）。
          before_content_hash: contentHash(candidate),
          spans: spans.map((span) => ({
            text: span.text || '',
            sentence_index: span.sentence_index ?? null,
            tmp_id: nextTmpId('node')
          }))
        });
      }
      if (paragraphSplits.length > 0) {
        const freshBranch = store._appendEditBranchEntry(branch, {
          kind: 'node.split',
          target_ref: target.id,
          strategy: 'source_paragraphs',
          paragraph_splits: paragraphSplits
        });
        return { branch: freshBranch, changed: true, docId };
      }
    }

    const sentences = splitSentences(target.text || '', {
      splitAsciiPunctuation: payload.splitAsciiPunctuation === true || payload.split_ascii_punctuation === true
    });
    if (sentences.length < 2) {
      return { branch, changed: false, docId };
    }
    const newIds = sentences.slice(1).map(() => nextTmpId('node'));
    const trunkTarget = store._trunkNodeRow(docId, target.id);
    const freshBranch = store._appendEditBranchEntry(branch, {
      kind: 'node.split',
      target_ref: target.id,
      strategy: 'split_sentences',
      sentences,
      new_node_ids: newIds,
      // 乐观并发前置：拆分基于主干当下的正文，保存时内容漂移则拒绝（tmp 目标无前置）。
      before_content_hash: trunkTarget ? contentHash(trunkTarget) : null
    });
    return { branch: freshBranch, changed: true, docId };
  }

export function stageEditBranchNodeMergeInto(store, branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const sourceRef = payload.nodeId ?? payload.node_id;
    const targetRef = payload.targetNodeId ?? payload.target_node_id;
    if (sourceRef === null || sourceRef === undefined) throw new Error('node.mergeInto requires nodeId');
    if (targetRef === null || targetRef === undefined) throw new Error('node.mergeInto requires targetNodeId');
    const trunkSource = store._trunkNodeRow(docId, sourceRef);
    const trunkTarget = store._trunkNodeRow(docId, targetRef);
    const freshBranch = store._appendEditBranchEntry(branch, {
      kind: 'node.mergeInto',
      source_ref: sourceRef,
      target_ref: targetRef,
      // 乐观并发前置：拼接结果取决于两侧当下正文，保存时任一侧内容漂移则拒绝。
      source_before_content_hash: trunkSource ? contentHash(trunkSource) : null,
      target_before_content_hash: trunkTarget ? contentHash(trunkTarget) : null
    });
    return { branch: freshBranch, changed: true, docId };
  }

export function stageEditBranchNodeMergePrevious(store, branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const sourceRef = payload.nodeId ?? payload.node_id;
    if (sourceRef === null || sourceRef === undefined) throw new Error('node.mergePrevious requires nodeId');
    // "前一兄弟"在 stage 时就着投影态物化成 target_ref：op-log 动词记录意图的对象
    // 而不是位置谓词，否则 undo/redo 翻动前序 entry 后"前一个"会漂移——投影端
    // （applyNodeMergeInto）与重放端都按定死的 target_ref 应用，所见即所得。
    const projected = store._projectedDocForBranch(branch);
    const node = store._findProjectedNode(projected, sourceRef);
    if (!node) throw new Error(`Node not found in edit branch: ${sourceRef}`);
    if (node.parent_id === null || node.parent_id === undefined) {
      return { branch, changed: false, docId };
    }
    const previous = projected.nodes
      .filter((other) => other.parent_id !== null && other.parent_id !== undefined
        && String(other.parent_id) === String(node.parent_id)
        && Number(other.sort_order) < Number(node.sort_order))
      .sort((left, right) => Number(right.sort_order) - Number(left.sort_order))[0] || null;
    if (!previous) {
      return { branch, changed: false, docId };
    }
    const trunkSource = store._trunkNodeRow(docId, sourceRef);
    const trunkTarget = store._trunkNodeRow(docId, previous.id);
    const freshBranch = store._appendEditBranchEntry(branch, {
      kind: 'node.mergePrevious',
      source_ref: sourceRef,
      target_ref: previous.id,
      // 乐观并发前置：与 mergeInto 同律，两侧内容漂移则拒绝（tmp 侧无前置）。
      source_before_content_hash: trunkSource ? contentHash(trunkSource) : null,
      target_before_content_hash: trunkTarget ? contentHash(trunkTarget) : null
    });
    return { branch: freshBranch, changed: true, docId };
  }

export function stageEditBranchNodeReparent(store, branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    const newParentRef = payload.newParentId ?? payload.new_parent_id;
    if (ref === null || ref === undefined) throw new Error('node.reparent requires nodeId');
    if (newParentRef === null || newParentRef === undefined) throw new Error('node.reparent requires newParentId');
    const trunkRow = store._trunkNodeRow(docId, ref);
    const freshBranch = store._appendEditBranchEntry(branch, {
      kind: 'node.reparent',
      node_ref: ref,
      new_parent_ref: newParentRef,
      // 乐观并发前置：记录移动时主干上的父节点；保存时父已被主干改走 → 两侧移动相撞。
      // 仅主干行存在时记录（缺省=无前置），避免把「未知」误记成「根(null)」。
      ...(trunkRow ? { before_parent_id: trunkRow.parent_id } : {})
    });
    return { branch: freshBranch, changed: true, docId };
  }

export function stageEditBranchNodeMoveBefore(store, branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    const targetRef = payload.targetNodeId ?? payload.target_node_id;
    if (ref === null || ref === undefined) throw new Error('node.moveBefore requires nodeId');
    if (targetRef === null || targetRef === undefined) throw new Error('node.moveBefore requires targetNodeId');
    const trunkRow = store._trunkNodeRow(docId, ref);
    const freshBranch = store._appendEditBranchEntry(branch, {
      kind: 'node.moveBefore',
      node_ref: ref,
      target_ref: targetRef,
      ...(trunkRow ? { before_parent_id: trunkRow.parent_id } : {})
    });
    return { branch: freshBranch, changed: true, docId };
  }

export function stageEditBranchNodeMoveAfter(store, branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    const targetRef = payload.targetNodeId ?? payload.target_node_id;
    if (ref === null || ref === undefined) throw new Error('node.moveAfter requires nodeId');
    if (targetRef === null || targetRef === undefined) throw new Error('node.moveAfter requires targetNodeId');
    const trunkRow = store._trunkNodeRow(docId, ref);
    const freshBranch = store._appendEditBranchEntry(branch, {
      kind: 'node.moveAfter',
      node_ref: ref,
      target_ref: targetRef,
      ...(trunkRow ? { before_parent_id: trunkRow.parent_id } : {})
    });
    return { branch: freshBranch, changed: true, docId };
  }

export function stageEditBranchAxiomAdd(store, branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const tmpId = nextTmpId('axiom');
    const fields = {
      content: typeof payload.content === 'string' ? payload.content : '',
      status: typeof payload.status === 'string' ? payload.status : 'pending',
      node_title: payload.nodeTitle ?? payload.node_title ?? '',
      node_note: payload.nodeNote ?? payload.node_note ?? ''
    };
    const freshBranch = store._appendEditBranchEntry(branch, {
      kind: 'axiom.add',
      tmp_id: tmpId,
      fields
    });
    const after = store._projectedDocForBranch(freshBranch);
    const axiom = store._findProjectedAxiom(after, tmpId);
    return { branch: freshBranch, changed: true, docId, axiom: axiom ? { ...axiom } : null, insertedAxiomId: tmpId };
  }

export function stageEditBranchAxiomUpdate(store, branch, payload = {}) {
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
    const freshBranch = store._appendEditBranchEntry(branch, {
      kind: 'axiom.update',
      axiom_ref: ref,
      patch
    });
    const after = store._projectedDocForBranch(freshBranch);
    const axiom = store._findProjectedAxiom(after, ref);
    return { branch: freshBranch, changed: true, docId, axiom: axiom ? { ...axiom } : null };
  }

export function stageEditBranchAxiomDelete(store, branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.axiomId ?? payload.axiom_id;
    if (ref === null || ref === undefined) throw new Error('axiom.delete requires axiomId');
    const freshBranch = store._appendEditBranchEntry(branch, {
      kind: 'axiom.delete',
      axiom_ref: ref
    });
    return { branch: freshBranch, changed: true, docId };
  }

export function stageEditBranchAxiomMove(store, branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.axiomId ?? payload.axiom_id;
    if (ref === null || ref === undefined) throw new Error('axiom.move requires axiomId');
    const direction = payload.direction === 'up' ? 'up' : 'down';
    const freshBranch = store._appendEditBranchEntry(branch, {
      kind: 'axiom.move',
      axiom_ref: ref,
      direction
    });
    return { branch: freshBranch, changed: true, docId };
  }

export function stageEditBranchRefAddAxiomToNode(store, branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const nodeRef = payload.nodeId ?? payload.node_id;
    const axiomRef = payload.axiomId ?? payload.axiom_id;
    if (nodeRef === null || nodeRef === undefined) throw new Error('ref.addAxiomToNode requires nodeId');
    if (axiomRef === null || axiomRef === undefined) throw new Error('ref.addAxiomToNode requires axiomId');
    const tmpId = nextTmpId('ref');
    const freshBranch = store._appendEditBranchEntry(branch, {
      kind: 'ref.addAxiomToNode',
      tmp_id: tmpId,
      node_ref: nodeRef,
      axiom_ref: axiomRef,
      note: payload.note ?? null
    });
    return { branch: freshBranch, changed: true, docId, insertedRefId: tmpId };
  }

export function stageEditBranchRefAddNodeToNode(store, branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const sourceRef = payload.sourceNodeId ?? payload.source_node_id ?? payload.nodeId ?? payload.node_id;
    const targetRef = payload.targetNodeId ?? payload.target_node_id;
    const refKind = String(payload.refKind ?? payload.ref_kind ?? payload.kind ?? '').trim();
    if (sourceRef === null || sourceRef === undefined) throw new Error('ref.addNodeToNode requires sourceNodeId');
    if (targetRef === null || targetRef === undefined) throw new Error('ref.addNodeToNode requires targetNodeId');
    if (!refKind) throw new Error('ref.addNodeToNode requires refKind');
    const tmpId = nextTmpId('ref');
    const freshBranch = store._appendEditBranchEntry(branch, {
      kind: 'ref.addNodeToNode',
      tmp_id: tmpId,
      source_ref: sourceRef,
      target_ref: targetRef,
      ref_kind: refKind,
      note: payload.note ?? null
    });
    return { branch: freshBranch, changed: true, docId, insertedRefId: tmpId };
  }

export function stageEditBranchRefDelete(store, branch, payload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.refId ?? payload.ref_id;
    if (ref === null || ref === undefined) throw new Error('ref.delete requires refId');
    const freshBranch = store._appendEditBranchEntry(branch, {
      kind: 'ref.delete',
      ref_ref: ref
    });
    return { branch: freshBranch, changed: true, docId };
  }

export function applyEditBranchDiffEntries(store, branch, diff = {}) {
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
    // 位置类容错（非快进合并后允许的降级）：锚点/排序对象已被主干删除时，位置意图失效，
    // 跳过或退化为追加——位置不进内容身份（A5-2），不算丢改动。内容类缺失仍由前置验证拦在重放前。
    const nodeRowExists = (id) => Boolean(store.db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(id));

    for (const entry of entries) {
      if (!isSupportedEditBranchEntryKind(entry?.kind)) {
        throw new Error(`Unsupported edit branch diff entry: ${entry?.kind || ''}`);
      }
      switch (entry.kind) {
        case 'node.update': {
          const nodeId = resolveNodeId(entry.node_id);
          store.updateNode(nodeId, entry.patch || {});
          break;
        }
        case 'node.insert': {
          const fields = entry.fields || {};
          const afterId = entry.after_ref ? resolveNodeId(entry.after_ref) : null;
          const inserted = store.insertNode({
            docId: baseDocId,
            parentId: resolveNodeId(entry.parent_ref),
            afterNodeId: afterId && nodeRowExists(afterId) ? afterId : null,
            text: fields.text ?? '',
            nodeType: fields.node_type ?? fields.nodeType ?? 'TEXT',
            nodeTitle: fields.node_title ?? fields.nodeTitle ?? '',
            nodeNote: fields.node_note ?? fields.nodeNote ?? '',
            sourcePosition: fields.source_position ?? null,
            // 兼容旧 diff / 历史摘取里已经存在的 trust_level 字段；新的 edit branch
            // stage 与 commit 入口不再接受 trust_level，标受控只走 human certify。
            trustLevel: fields.trust_level ?? fields.trustLevel ?? null
          });
          if (entry.tmp_id) nodeIdByTmp.set(entry.tmp_id, inserted.id);
          break;
        }
        case 'node.delete': {
          const targetId = resolveNodeId(entry.target_ref);
          if (nodeRowExists(targetId)) store.deleteNodeSubtree(targetId); // 主干也删了 → 收敛跳过
          break;
        }
        case 'node.move': {
          const targetId = resolveNodeId(entry.target_ref);
          if (nodeRowExists(targetId)) store.moveNode(targetId, entry.direction === 'up' ? 'up' : 'down');
          break;
        }
        case 'node.promote': {
          const targetId = resolveNodeId(entry.target_ref);
          if (nodeRowExists(targetId)) store.promoteNode(targetId);
          break;
        }
        case 'node.split': {
          const targetId = resolveNodeId(entry.target_ref);
          const subtreeIds = store.db.prepare(`
            WITH RECURSIVE subtree(id) AS (
              SELECT id FROM nodes WHERE id = ?
              UNION ALL
              SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
            )
            SELECT id FROM subtree
          `);
          const beforeIds = new Set(subtreeIds.all(targetId).map((row) => String(row.id)));
          store.splitNodeIntoChildren(targetId);
          // Build tmp_id -> real id mapping so later entries that reference
          // the freshly-split children resolve correctly.
          if (entry.strategy === 'source_paragraphs' && Array.isArray(entry.paragraph_splits)) {
            for (const split of entry.paragraph_splits) {
              const realParagraphId = resolveNodeId(split.paragraph_node_id);
              const realChildren = store.db.prepare(`
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
            const realChildren = store.db.prepare(`
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
          store.mergeNodeIntoTarget({
            nodeId: resolveNodeId(entry.source_ref),
            targetNodeId: resolveNodeId(entry.target_ref)
          });
          break;
        }
        case 'node.mergePrevious': {
          // stage 端已把"前一兄弟"物化为 target_ref；按定死目标重放，与投影所见一致。
          // 无 target_ref 的旧 entry 退回重放时现查（防御兜底；现行 stage 必写 target_ref）。
          if (entry.target_ref !== null && entry.target_ref !== undefined) {
            store.mergeNodeIntoTarget({
              nodeId: resolveNodeId(entry.source_ref),
              targetNodeId: resolveNodeId(entry.target_ref)
            });
          } else {
            store.mergeNodeIntoPreviousSibling(resolveNodeId(entry.source_ref));
          }
          break;
        }
        case 'node.reparent': {
          store.moveNodeToParent({
            nodeId: resolveNodeId(entry.node_ref),
            newParentId: resolveNodeId(entry.new_parent_ref)
          });
          break;
        }
        case 'node.moveBefore': {
          const nodeId = resolveNodeId(entry.node_ref);
          const targetId = resolveNodeId(entry.target_ref);
          if (nodeRowExists(nodeId) && nodeRowExists(targetId)) {
            store.moveNodeBeforeSibling({ nodeId, targetNodeId: targetId });
          }
          break;
        }
        case 'node.moveAfter': {
          const nodeId = resolveNodeId(entry.node_ref);
          const targetId = resolveNodeId(entry.target_ref);
          if (nodeRowExists(nodeId) && nodeRowExists(targetId)) {
            store.moveNodeAfterSibling({ nodeId, targetNodeId: targetId });
          }
          break;
        }
        case 'axiom.add': {
          const fields = entry.fields || {};
          const created = store.addAxiom({
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
          store.updateAxiom(resolveAxiomId(entry.axiom_ref), entry.patch || {});
          break;
        }
        case 'axiom.delete': {
          store.deleteAxiom(resolveAxiomId(entry.axiom_ref));
          break;
        }
        case 'axiom.move': {
          store.moveAxiom({
            docId: baseDocId,
            axiomId: resolveAxiomId(entry.axiom_ref),
            direction: entry.direction === 'up' ? 'up' : 'down'
          });
          break;
        }
        case 'ref.addAxiomToNode': {
          const created = store.addAxiomRefToNode({
            docId: baseDocId,
            nodeId: resolveNodeId(entry.node_ref),
            axiomId: resolveAxiomId(entry.axiom_ref),
            note: entry.note ?? null
          });
          if (entry.tmp_id) refIdByTmp.set(entry.tmp_id, created.id);
          break;
        }
        case 'ref.addNodeToNode': {
          const created = store.addNodeRefToNode({
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
          store.deleteRef(resolveRefId(entry.ref_ref));
          break;
        }
        case 'entity.create':
        case 'entity.update':
        case 'entity.delete':
        case 'entity.link':
        case 'entity.unlink':
        case 'entity.bindNode':
        case 'entity.ignoreNode':
        case 'entity.clearNodeBinding':
          // entity 落库已下沉 entities/write.mjs（解耦第 4 步）；提交循环只把横切解析器交给它。
          applyEntityEntry(store, entry, { resolveEntityId, resolveNodeId, entityIdByTmp, baseDocId });
          break;
        default:
          throw new Error(`Unhandled edit branch diff entry kind: ${entry.kind}`);
      }
    }
  }

export function beginEditBranch(store, docId, owner = 'human') {
    const normalizedDocId = normalizePositiveId(docId);
    const normalizedOwner = store.normalizeEditBranchOwner(owner);
    if (!normalizedDocId) throw new Error('beginEditBranch requires docId');

    const shadowExisting = store.activeEditBranchForShadowDoc(normalizedDocId);
    if (shadowExisting && shadowExisting.owner === normalizedOwner) return shadowExisting;
    const existing = store.activeEditBranchForBaseDoc(normalizedDocId, normalizedOwner);
    if (existing && existing.owner === normalizedOwner) return existing;

    const head = store.db.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?').get(normalizedDocId);
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
    const result = store.db.prepare(`
      INSERT INTO edit_branches (base_doc_id, shadow_doc_id, owner, base_snapshot, diff)
      VALUES (?, ?, ?, ?, ?)
    `).run(normalizedDocId, normalizedDocId, normalizedOwner, JSON.stringify(baseSnapshot), JSON.stringify(diff));
    return store.db.prepare('SELECT * FROM edit_branches WHERE id = ?').get(Number(result.lastInsertRowid));
  }

export function findEditBranch(store, { branchId = null, shadowDocId = null, baseDocId = null, owner = 'human' } = {}) {
    const normalizedOwner = owner == null ? null : store.normalizeEditBranchOwner(owner);
    const acceptOwner = (branch) => (
      branch && (!normalizedOwner || branch.owner === normalizedOwner) ? branch : null
    );
    if (branchId) {
      // branchId 是主键、全局唯一，唯一锁定一条草稿；owner 是写入身份/消歧维度、不是定位键。
      // 给了唯一句柄就不再按 owner 过滤——否则不传/传错 owner 会找不到本已锁定的草稿（见 A5-5、15-5-2）。
      return store.db.prepare("SELECT * FROM edit_branches WHERE id = ? AND status = 'active'").get(Number(branchId)) || null;
    }
    if (shadowDocId) return acceptOwner(store.activeEditBranchForShadowDoc(shadowDocId));
    if (baseDocId) return store.activeEditBranchForBaseDoc(baseDocId, normalizedOwner || 'human');
    return null;
  }

export function rebaseEditBranch(store, { branchId = null, shadowDocId = null, baseDocId = null, owner = 'human' } = {}) {
    const branch = store.findEditBranch({ branchId, shadowDocId, baseDocId, owner });
    if (!branch) throw new Error('Edit branch not found');
    const head = store.db.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?').get(branch.base_doc_id);
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
    store.db.prepare(`
      UPDATE edit_branches
      SET base_snapshot = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(baseSnapshot), branch.id);
    const freshBranch = store.db.prepare('SELECT * FROM edit_branches WHERE id = ?').get(branch.id);
    return {
      changed: true,
      branch: freshBranch,
      baseCommitId: baseSnapshot.baseCommitId,
      ...store.editBranchHistoryState(freshBranch)
    };
  }

export function cherryPickEditBranchEntries(store, {
    sourceHistoryId = null,
    sourceBranchId = null,
    targetBranchId = null,
    targetBaseDocId = null,
    targetOwner = 'human',
    entryId = null,
    entryIndex = null
  } = {}) {
    const source = store._cherryPickSource({ sourceHistoryId, sourceBranchId });
    const selectedEntries = store._selectCherryPickEntries(source.entries, { entryId, entryIndex });
    if (selectedEntries.length === 0) throw new Error('cherry-pick found no entries');
    const targetBranch = targetBranchId
      ? store.findEditBranch({ branchId: targetBranchId, owner: null })
      : store.beginEditBranch(targetBaseDocId || source.docId, targetOwner);
    if (!targetBranch) throw new Error('Target edit branch not found');
    if (!sameStableId(targetBranch.base_doc_id, source.docId)) {
      throw new Error('cherry-pick source and target must belong to the same document');
    }
    let branch = targetBranch;
    const picked = [];
    for (const entry of selectedEntries) {
      const copy = store._copyCherryPickEntry(entry, source);
      branch = store._appendEditBranchEntry(branch, copy);
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

export function _cherryPickSource(store, { sourceHistoryId = null, sourceBranchId = null } = {}) {
    if (sourceBranchId) {
      const branch = store.findEditBranch({ branchId: sourceBranchId, owner: null });
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
      const commit = store.db.prepare('SELECT id, doc_id, meta FROM commits WHERE id = ?').get(sourceHistoryId);
      if (!commit) throw new Error(`Commit not found: ${sourceHistoryId}`);
      // 操作级条目内联在 meta.entries。
      const meta = parseJsonObject(commit.meta) || {};
      const rawEntries = Array.isArray(meta.entries) ? meta.entries : null;
      const entries = activeEditBranchEntries(rawEntries);
      if (entries.length === 0 && Array.isArray(rawEntries) && rawEntries.length > 0) {
        throw new Error('cherry-pick commit does not contain edit-branch entries');
      }
      return {
        kind: 'history',
        id: commit.id,
        docId: commit.doc_id,
        entries
      };
    }
    throw new Error('cherry-pick requires sourceHistoryId or sourceBranchId');
  }

export function _selectCherryPickEntries(store, entries = [], { entryId = null, entryIndex = null } = {}) {
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

export function _copyCherryPickEntry(store, entry = {}, source = {}) {
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

export function saveEditBranch(store, { branchId = null, shadowDocId = null, baseDocId = null, owner = 'human', summary = '保存编辑分支' } = {}) {
    // 与 applyMerge 同一道闸门：非快进时逐条前置验证，受阻/冲突拒绝写回（MCP commit 不再盲存）。
    return store.applyThreeWayMerge({ branchId, shadowDocId, baseDocId, owner, summary });
  }

  // 重放前后的节点签名快照，比对找出本次实际受影响节点。签名分两维，对应两套派生索引
  // 各自的身份语义：keyword 行绑（地址+全部内容字段，4-6-2），向量只绑正文（15-8-1，
  // 地址/标题/备注变化不重算）。contentHash 现算（merkle 同款）——content_hash 列是
  // 惰性回写（触发器只标 doc 脏），事务内不可用。逐 entry 收集容易漏（split/merge/
  // 级联删除），两次 O(n) 快照比对不会。iterate 逐行算完即弃，不持全文。
export function _docNodeSignatures(store, docId) {
    const map = new Map();
    const rows = store.db.prepare(`
      SELECT id, address, text, node_title, node_note, node_type, trust_level
      FROM nodes WHERE doc_id = ?
    `).iterate(docId);
    for (const row of rows) {
      map.set(String(row.id), {
        keyword: `${row.address || ''}|${contentHash(row)}`,
        text: contentHash({ text: row.text })
      });
    }
    return map;
  }

  // 把一份 diff payload（生效 entries）应用到主干、提交、写历史、删分支。
  // saveEditBranch 用分支存储的 entries 调用；三方合并人裁后用折进 resolution 的 entries 调用。
  // 返回 touchedNodeIds/deletedNodeIds 供派生索引按受影响节点增量同步（4-6-2）。
export function _commitEditBranchPayload(store, branch, rawPayload = {}, summary = '保存编辑分支') {
    const entries = activeEditBranchEntries(rawPayload.entries);
    if (entries.some(editBranchEntryTouchesTrust)) {
      throw new Error('edit branch diff no longer supports trust_level; use human certify to set trust_level');
    }
    const payload = { ...rawPayload, entries };
    const hasEffectiveDiff = entries.length > 0;

    return store.withTransaction(() => {
      const touchedNodeIds = [];
      const deletedNodeIds = [];
      const vectorStaleNodeIds = [];
      if (hasEffectiveDiff) {
        const before = store._docNodeSignatures(branch.base_doc_id);
        store.applyEditBranchDiffEntries(branch, payload);
        const after = store._docNodeSignatures(branch.base_doc_id);
        for (const [id, signature] of after) {
          const previous = before.get(id);
          if (!previous || previous.keyword !== signature.keyword) touchedNodeIds.push(id);
          // 向量陈旧 = 既有节点正文变了；新增节点无旧向量行，地址/标题/备注变化不算。
          if (previous && previous.text !== signature.text) vectorStaleNodeIds.push(id);
        }
        for (const id of before.keys()) {
          if (!after.has(id)) deletedNodeIds.push(id);
        }
        const currentSnapshot = store.createSnapshot(branch.base_doc_id);
        store.createCommit({
          docId: branch.base_doc_id,
          summary,
          snapshot: currentSnapshot,
          entries, // 操作级条目（cherry-pick 重放 / 单 ref diff 展示要它）
          author: branch.owner || null
        });
      }

      store.db.prepare('DELETE FROM edit_branches WHERE id = ?').run(branch.id);
      if (hasEffectiveDiff) store.touchDoc(branch.base_doc_id);

      return {
        changed: hasEffectiveDiff,
        baseDocId: branch.base_doc_id,
        branchId: branch.id,
        owner: branch.owner,
        touchedNodeIds,
        deletedNodeIds,
        vectorStaleNodeIds,
        history: hasEffectiveDiff
          ? store.db.prepare(`
            SELECT id, doc_id, id AS commit_id, committed_at AS saved_at, summary
            FROM commits
            WHERE doc_id = ?
            ORDER BY committed_at DESC, id DESC
            LIMIT 1
          `).get(branch.base_doc_id)
          : null
      };
    });
  }

export function discardEditBranch(store, { branchId = null, shadowDocId = null, baseDocId = null, owner = 'human' } = {}) {
    const branch = store.findEditBranch({ branchId, shadowDocId, baseDocId, owner });
    if (!branch) return false;
    // Lazy mode: base tables are never modified during the edit session, so
    // discarding the branch simply drops the staged entries.
    store.db.prepare('DELETE FROM edit_branches WHERE id = ?').run(branch.id);
    return true;
  }
