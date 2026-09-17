// 编辑分支暂存阶段（L2）：把用户动作收紧成可持久化 entry，不负责重放落库。

import { splitSentences } from '../../core/tree.js';
import { normalizeNodeType } from '../../core/node-model.js';
import { contentHash, type MerkleNode } from '../../core/merkle.js';
import { assertNoHumanTagField, assertNoEditTrustField, assertValidNodeRefKind } from '../shared.js';
import { sameStableId } from '../db/ids.js';
import { normalizePositiveId, normalizeSourcePosition } from '../db/normalizers.js';
import type { EditBranchRow, NodeRow, SourceSpanRow } from '../db/schema.js';
import type { NodePatchFields, NodeUpdateFieldsDelta, ProjectionNode } from './edit-branch-contract.js';
import type { EditBranchStore } from './edit-branch.js';
import {
  _appendEditBranchEntry,
  _findProjectedAxiom,
  _findProjectedNode,
  _projectedDocForBranch,
  _trunkNodeRow,
  _trunkSubtreeHash,
  nodePatchForEditBranch
} from './edit-branch.js';

type RowObject = Record<string, unknown>;
type EditBranchPayload = RowObject;
type CountRow = { count: number };
type ProjectedNode = ProjectionNode;

export function stageEditBranchNodeUpdate(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
    assertNoEditTrustField(payload, 'node.update payload');
    const nodeRef = payload.nodeId ?? payload.node_id;
    if (nodeRef === null || nodeRef === undefined) throw new Error('node.update requires nodeId');
    const before = _projectedDocForBranch(store, branch);
    const currentNode = _findProjectedNode(store, before, nodeRef);
    if (!currentNode) throw new Error(`Node not found in edit branch: ${nodeRef}`);
    // 接受顶层字段或 patch 包：不强制调用方手写嵌套 { patch: {...} }（不裸 json，见 15-5-2）。
    // nodePatchForEditBranch 按白名单取字段，顶层混入的 nodeId/action/owner 等非字段会被忽略。
    const requestedPatch = nodePatchForEditBranch(store, currentNode, (payload.patch ?? payload) as EditBranchPayload);
    if (Object.keys(requestedPatch).length === 0) {
      throw new Error('node.update 需要至少一个可改字段（text / nodeType / nodeTitle / nodeNote / sourcePosition），放在顶层或 patch 内均可');
    }
    const patch: NodePatchFields = {};
    const fields: NodeUpdateFieldsDelta[] = [];
    for (const [field, value] of Object.entries(requestedPatch)) {
      const oldValue = (currentNode as unknown as Record<string, unknown>)[field] ?? null;
      const nextValue = value ?? null;
      if (oldValue === nextValue) continue;
      // requestedPatch 经 nodePatchForEditBranch 白名单过滤，键已在 NodePatchFields 字段集内，
      // 但类型上仍是 string 索引——用 Record 视图写入，避开 keyof NodePatchFields 收紧。
      (patch as Record<string, unknown>)[field] = value;
      fields.push({ field, old: oldValue, new: nextValue });
    }
    if (fields.length === 0) {
      // 提供了字段但值与现状相同——合法 no-op，非错误
      return { branch, changed: false, node: store.requireEditBranchPort().nodeRowWithClientAliases(currentNode) };
    }
    const freshBranch = _appendEditBranchEntry(store, branch, {
      kind: 'node.update',
      action: 'patch',
      node_id: currentNode.id,
      address: currentNode.address || '',
      patch,
      fields
    });
    // node.update 只 patch 单节点内容字段、不动结构：改后投影中该节点 ≡ patchProjectedNode(改前节点, patch)
    // （applyNodeUpdate 的定义即此）。省掉原先「仅为取改后节点行」的第二次全量投影重建。
    const projectedNode = store.requireEditBranchPort().patchProjectedNode(currentNode, patch);
    return { branch: freshBranch, changed: true, node: store.requireEditBranchPort().nodeRowWithClientAliases(projectedNode as NodeRow) };
  }

export function stageEditBranchNodeInsert(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
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
      const projected = _projectedDocForBranch(store, branch);
      const anchor = _findProjectedNode(store, projected, afterRef);
      if (!anchor) throw new Error(`node.insert afterNodeId 锚点不存在: ${afterRef}`);
      if (anchor.parent_id === null || anchor.parent_id === undefined) {
        throw new Error('node.insert 不能插在根节点之后（根唯一）；要在根下插入请给 parentId');
      }
      parentRef = anchor.parent_id;
    } else {
      // 显式 parentId 同样前置校验（与 afterNodeId 锚点一致）：假 id 静默暂存会把错误拖到 commit
      // 才爆，fail-fast 在暂存层挡住。父可以是本草稿新增的 tmp 节点，故查投影而非只查主干表。
      const projected = _projectedDocForBranch(store, branch);
      const parent = _findProjectedNode(store, projected, parentRef);
      if (!parent) throw new Error(`node.insert parentId 父节点不存在: ${parentRef}`);
    }
    const tmpId = store.requireEditBranchPort().nextTmpId('node');
    const fields = {
      text: typeof payload.text === 'string' ? payload.text : '',
      node_type: normalizeNodeType(String(payload.nodeType ?? payload.node_type ?? 'TEXT')),
      node_title: payload.nodeTitle ?? payload.node_title ?? '',
      node_note: payload.nodeNote ?? payload.node_note ?? '',
      source_position: normalizeSourcePosition(payload.sourcePosition ?? payload.source_position ?? null)
    };
    const freshBranch = _appendEditBranchEntry(store, branch, {
      kind: 'node.insert',
      tmp_id: tmpId,
      parent_ref: parentRef,
      after_ref: afterRef,
      fields
    });
    const after = _projectedDocForBranch(store, freshBranch);
    const inserted = _findProjectedNode(store, after, tmpId);
    return {
      branch: freshBranch,
      changed: true,
      docId,
      node: inserted ? store.requireEditBranchPort().nodeRowWithClientAliases(inserted) : null,
      insertedNodeId: tmpId
    };
  }

export function stageEditBranchNodeDelete(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    if (ref === null || ref === undefined) throw new Error('node.delete requires nodeId');
    const before = _projectedDocForBranch(store, branch);
    const target = _findProjectedNode(store, before, ref);
    if (!target) throw new Error(`Node not found in edit branch: ${ref}`);
    if (target.parent_id === null || target.parent_id === undefined) {
      throw new Error('Cannot delete document root node');
    }
    const freshBranch = _appendEditBranchEntry(store, branch, {
      kind: 'node.delete',
      target_ref: target.id,
      address: target.address || '',
      // 乐观并发前置（A5-10）：记下主干当下这棵子树的指纹，保存时一致才允许照删——
      // 「删除时至少该知道删的是什么」。tmp 目标（分支自建）无主干前置，记 null。
      before_subtree_hash: _trunkSubtreeHash(store, docId, target.id)
    });
    return { branch: freshBranch, changed: true, docId, nodeId: target.id };
  }

export function stageEditBranchNodeMove(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    if (ref === null || ref === undefined) throw new Error('node.move requires nodeId');
    const direction = payload.direction === 'up' ? 'up' : 'down';
    const freshBranch = _appendEditBranchEntry(store, branch, {
      kind: 'node.move',
      target_ref: ref,
      direction
    });
    return { branch: freshBranch, changed: true, docId, nodeId: ref, direction };
  }

export function stageEditBranchNodePromote(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    if (ref === null || ref === undefined) throw new Error('node.promote requires nodeId');
    const trunkRow = _trunkNodeRow(store, docId, ref);
    const freshBranch = _appendEditBranchEntry(store, branch, {
      kind: 'node.promote',
      target_ref: ref,
      ...(trunkRow ? { before_parent_id: trunkRow.parent_id } : {})
    });
    return { branch: freshBranch, changed: true, docId, nodeId: ref };
  }

export function stageEditBranchNodeSplit(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    if (ref === null || ref === undefined) throw new Error('node.split requires nodeId');
    const before = _projectedDocForBranch(store, branch);
    const target = _findProjectedNode(store, before, ref);
    if (!target) throw new Error(`Node not found in edit branch: ${ref}`);

    // Source-paragraph mode: when target's subtree (in the real base table)
    // has childless paragraph nodes with source_spans, mirror what
    // splitNodeIntoChildren -> splitSourceParagraphsIntoSentenceChildren would
    // do. Only base node ids can carry source_spans; pending-insert tmp nodes
    // never do.
    if (!store.requireEditBranchPort().isTmpId(target.id)) {
      const candidates = store.db!.prepare(`
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
      `).all<ProjectedNode>(target.id);
      const baseChildCount = store.db!.prepare('SELECT COUNT(*) AS count FROM nodes WHERE parent_id = ?');
      const spansStmt = store.db!.prepare('SELECT * FROM source_spans WHERE node_id = ? ORDER BY sentence_index, id');
      const paragraphSplits: RowObject[] = [];
      for (const candidate of candidates) {
        // skip if base or projection already gave this paragraph children
        if ((baseChildCount.get<CountRow>(candidate.id)?.count || 0) > 0) continue;
        const projectedChildren = before.nodes.filter((n: ProjectedNode) => sameStableId(n.parent_id, candidate.id));
        if (projectedChildren.length > 0) continue;
        const spans = spansStmt.all<SourceSpanRow>(candidate.id);
        if (spans.length === 0) continue;
        paragraphSplits.push({
          paragraph_node_id: candidate.id,
          // 乐观并发前置：拆分基于该段当下的内容，保存时内容漂移则拒绝（candidate 是主干行）。
          before_content_hash: contentHash(candidate as unknown as MerkleNode),
          spans: spans.map((span: SourceSpanRow) => ({
            text: span.text || '',
            sentence_index: span.sentence_index ?? null,
            tmp_id: store.requireEditBranchPort().nextTmpId('node')
          }))
        });
      }
      if (paragraphSplits.length > 0) {
        const freshBranch = _appendEditBranchEntry(store, branch, {
          kind: 'node.split',
          target_ref: target.id,
          strategy: 'source_paragraphs',
          paragraph_splits: paragraphSplits
        });
        return {
          branch: freshBranch,
          changed: true,
          docId,
          nodeId: target.id,
          // 回执要交代拆分规模（逐动作计数对 split 恒 +1、不反映拆出节点数）：段落模式按段/句计。
          splitParagraphCount: paragraphSplits.length,
          splitNewNodeCount: paragraphSplits.reduce((sum, split) => sum + ((split.spans as unknown[]).length || 0), 0)
        };
      }
    }

    const sentences = splitSentences(target.text || '', {
      splitAsciiPunctuation: payload.splitAsciiPunctuation === true || payload.split_ascii_punctuation === true
    });
    if (sentences.length < 2) {
      return { branch, changed: false, docId, nodeId: target.id };
    }
    const newIds = sentences.slice(1).map(() => store.requireEditBranchPort().nextTmpId('node'));
    const trunkTarget = _trunkNodeRow(store, docId, target.id);
    const freshBranch = _appendEditBranchEntry(store, branch, {
      kind: 'node.split',
      target_ref: target.id,
      strategy: 'split_sentences',
      sentences,
      new_node_ids: newIds,
      // 乐观并发前置：拆分基于主干当下的正文，保存时内容漂移则拒绝（tmp 目标无前置）。
      before_content_hash: trunkTarget ? contentHash(trunkTarget as unknown as MerkleNode) : null
    });
    return {
      branch: freshBranch,
      changed: true,
      docId,
      nodeId: target.id,
      // 回执要交代拆分规模（逐动作计数对 split 恒 +1、不反映拆出节点数）：首句留守、其余下沉。
      splitSentenceCount: sentences.length,
      splitNewNodeCount: newIds.length
    };
  }

export function stageEditBranchNodeMergeInto(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const sourceRef = payload.nodeId ?? payload.node_id;
    const targetRef = payload.targetNodeId ?? payload.target_node_id;
    if (sourceRef === null || sourceRef === undefined) throw new Error('node.mergeInto requires nodeId');
    if (targetRef === null || targetRef === undefined) throw new Error('node.mergeInto requires targetNodeId');
    const trunkSource = _trunkNodeRow(store, docId, sourceRef);
    const trunkTarget = _trunkNodeRow(store, docId, targetRef);
    const freshBranch = _appendEditBranchEntry(store, branch, {
      kind: 'node.mergeInto',
      source_ref: sourceRef,
      target_ref: targetRef,
      // 乐观并发前置：拼接结果取决于两侧当下正文，保存时任一侧内容漂移则拒绝。
      source_before_content_hash: trunkSource ? contentHash(trunkSource as unknown as MerkleNode) : null,
      target_before_content_hash: trunkTarget ? contentHash(trunkTarget as unknown as MerkleNode) : null
    });
    return { branch: freshBranch, changed: true, docId, nodeId: sourceRef, sourceNodeId: sourceRef, targetNodeId: targetRef };
  }

export function stageEditBranchNodeMergePrevious(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const sourceRef = payload.nodeId ?? payload.node_id;
    if (sourceRef === null || sourceRef === undefined) throw new Error('node.mergePrevious requires nodeId');
    // "前一兄弟"在 stage 时就着投影态物化成 target_ref：op-log 动词记录意图的对象
    // 而不是位置谓词，否则 undo/redo 翻动前序 entry 后"前一个"会漂移——投影端
    // （applyNodeMergeInto）与重放端都按定死的 target_ref 应用，所见即所得。
    const projected = _projectedDocForBranch(store, branch);
    const node = _findProjectedNode(store, projected, sourceRef);
    if (!node) throw new Error(`Node not found in edit branch: ${sourceRef}`);
    if (node.parent_id === null || node.parent_id === undefined) {
      return { branch, changed: false, docId, nodeId: sourceRef };
    }
    const previous = projected.nodes
      .filter((other: ProjectedNode) => other.parent_id !== null && other.parent_id !== undefined
        && String(other.parent_id) === String(node.parent_id)
        && Number(other.sort_order) < Number(node.sort_order))
      .sort((left: ProjectedNode, right: ProjectedNode) => Number(right.sort_order) - Number(left.sort_order))[0] || null;
    if (!previous) {
      return { branch, changed: false, docId, nodeId: sourceRef };
    }
    const trunkSource = _trunkNodeRow(store, docId, sourceRef);
    const trunkTarget = _trunkNodeRow(store, docId, previous.id);
    const freshBranch = _appendEditBranchEntry(store, branch, {
      kind: 'node.mergePrevious',
      source_ref: sourceRef,
      target_ref: previous.id,
      // 乐观并发前置：与 mergeInto 同律，两侧内容漂移则拒绝（tmp 侧无前置）。
      source_before_content_hash: trunkSource ? contentHash(trunkSource as unknown as MerkleNode) : null,
      target_before_content_hash: trunkTarget ? contentHash(trunkTarget as unknown as MerkleNode) : null
    });
    return { branch: freshBranch, changed: true, docId, nodeId: sourceRef, sourceNodeId: sourceRef, targetNodeId: previous.id };
  }

export function stageEditBranchNodeReparent(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    const newParentRef = payload.newParentId ?? payload.new_parent_id;
    if (ref === null || ref === undefined) throw new Error('node.reparent requires nodeId');
    if (newParentRef === null || newParentRef === undefined) throw new Error('node.reparent requires newParentId');
    const trunkRow = _trunkNodeRow(store, docId, ref);
    const freshBranch = _appendEditBranchEntry(store, branch, {
      kind: 'node.reparent',
      node_ref: ref,
      new_parent_ref: newParentRef,
      // 乐观并发前置：记录移动时主干上的父节点；保存时父已被主干改走 → 两侧移动相撞。
      // 仅主干行存在时记录（缺省=无前置），避免把「未知」误记成「根(null)」。
      ...(trunkRow ? { before_parent_id: trunkRow.parent_id } : {})
    });
    return { branch: freshBranch, changed: true, docId, nodeId: ref, newParentId: newParentRef };
  }

export function stageEditBranchNodeMoveBefore(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    const targetRef = payload.targetNodeId ?? payload.target_node_id;
    if (ref === null || ref === undefined) throw new Error('node.moveBefore requires nodeId');
    if (targetRef === null || targetRef === undefined) throw new Error('node.moveBefore requires targetNodeId');
    const trunkRow = _trunkNodeRow(store, docId, ref);
    const freshBranch = _appendEditBranchEntry(store, branch, {
      kind: 'node.moveBefore',
      node_ref: ref,
      target_ref: targetRef,
      ...(trunkRow ? { before_parent_id: trunkRow.parent_id } : {})
    });
    return { branch: freshBranch, changed: true, docId, nodeId: ref, targetNodeId: targetRef };
  }

export function stageEditBranchNodeMoveAfter(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.nodeId ?? payload.node_id;
    const targetRef = payload.targetNodeId ?? payload.target_node_id;
    if (ref === null || ref === undefined) throw new Error('node.moveAfter requires nodeId');
    if (targetRef === null || targetRef === undefined) throw new Error('node.moveAfter requires targetNodeId');
    const trunkRow = _trunkNodeRow(store, docId, ref);
    const freshBranch = _appendEditBranchEntry(store, branch, {
      kind: 'node.moveAfter',
      node_ref: ref,
      target_ref: targetRef,
      ...(trunkRow ? { before_parent_id: trunkRow.parent_id } : {})
    });
    return { branch: freshBranch, changed: true, docId, nodeId: ref, targetNodeId: targetRef };
  }

export function stageEditBranchAxiomAdd(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const tmpId = store.requireEditBranchPort().nextTmpId('axiom');
    const fields = {
      content: typeof payload.content === 'string' ? payload.content : '',
      status: typeof payload.status === 'string' ? payload.status : 'pending',
      node_title: payload.nodeTitle ?? payload.node_title ?? '',
      node_note: payload.nodeNote ?? payload.node_note ?? ''
    };
    const freshBranch = _appendEditBranchEntry(store, branch, {
      kind: 'axiom.add',
      tmp_id: tmpId,
      fields
    });
    const after = _projectedDocForBranch(store, freshBranch);
    const axiom = _findProjectedAxiom(store, after, tmpId);
    return { branch: freshBranch, changed: true, docId, axiom: axiom ? { ...axiom } : null, insertedAxiomId: tmpId };
  }

export function stageEditBranchAxiomUpdate(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.axiomId ?? payload.axiom_id;
    if (ref === null || ref === undefined) throw new Error('axiom.update requires axiomId');
    const rawPatch = (payload.patch || payload) as EditBranchPayload;
    const patch: RowObject = {};
    if (Object.prototype.hasOwnProperty.call(rawPatch, 'content')) patch.content = rawPatch.content;
    if (Object.prototype.hasOwnProperty.call(rawPatch, 'status')) patch.status = rawPatch.status;
    if (Object.prototype.hasOwnProperty.call(rawPatch, 'node_title') || Object.prototype.hasOwnProperty.call(rawPatch, 'nodeTitle')) {
      patch.node_title = rawPatch.node_title ?? rawPatch.nodeTitle ?? '';
    }
    if (Object.prototype.hasOwnProperty.call(rawPatch, 'node_note') || Object.prototype.hasOwnProperty.call(rawPatch, 'nodeNote')) {
      patch.node_note = rawPatch.node_note ?? rawPatch.nodeNote ?? '';
    }
    const freshBranch = _appendEditBranchEntry(store, branch, {
      kind: 'axiom.update',
      axiom_ref: ref,
      patch
    });
    const after = _projectedDocForBranch(store, freshBranch);
    const axiom = _findProjectedAxiom(store, after, ref);
    return { branch: freshBranch, changed: true, docId, axiom: axiom ? { ...axiom } : null, axiomId: ref };
  }

export function stageEditBranchAxiomDelete(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.axiomId ?? payload.axiom_id;
    if (ref === null || ref === undefined) throw new Error('axiom.delete requires axiomId');
    const freshBranch = _appendEditBranchEntry(store, branch, {
      kind: 'axiom.delete',
      axiom_ref: ref
    });
    return { branch: freshBranch, changed: true, docId, axiomId: ref };
  }

export function stageEditBranchAxiomMove(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.axiomId ?? payload.axiom_id;
    if (ref === null || ref === undefined) throw new Error('axiom.move requires axiomId');
    const direction = payload.direction === 'up' ? 'up' : 'down';
    const freshBranch = _appendEditBranchEntry(store, branch, {
      kind: 'axiom.move',
      axiom_ref: ref,
      direction
    });
    return { branch: freshBranch, changed: true, docId, axiomId: ref, direction };
  }

export function stageEditBranchRefAddAxiomToNode(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const nodeRef = payload.nodeId ?? payload.node_id;
    const axiomRef = payload.axiomId ?? payload.axiom_id;
    if (nodeRef === null || nodeRef === undefined) throw new Error('ref.addAxiomToNode requires nodeId');
    if (axiomRef === null || axiomRef === undefined) throw new Error('ref.addAxiomToNode requires axiomId');
    const tmpId = store.requireEditBranchPort().nextTmpId('ref');
    const freshBranch = _appendEditBranchEntry(store, branch, {
      kind: 'ref.addAxiomToNode',
      tmp_id: tmpId,
      node_ref: nodeRef,
      axiom_ref: axiomRef,
      note: payload.note ?? null
    });
    return { branch: freshBranch, changed: true, docId, insertedRefId: tmpId, refId: tmpId, nodeId: nodeRef, axiomId: axiomRef };
  }

export function stageEditBranchRefAddNodeToNode(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const sourceRef = payload.sourceNodeId ?? payload.source_node_id ?? payload.nodeId ?? payload.node_id;
    const targetRef = payload.targetNodeId ?? payload.target_node_id;
    const refKind = String(payload.refKind ?? payload.ref_kind ?? payload.kind ?? '').trim();
    if (sourceRef === null || sourceRef === undefined) throw new Error('ref.addNodeToNode requires sourceNodeId');
    if (targetRef === null || targetRef === undefined) throw new Error('ref.addNodeToNode requires targetNodeId');
    if (!refKind) throw new Error('ref.addNodeToNode requires refKind');
    assertValidNodeRefKind(refKind);
    const tmpId = store.requireEditBranchPort().nextTmpId('ref');
    const freshBranch = _appendEditBranchEntry(store, branch, {
      kind: 'ref.addNodeToNode',
      tmp_id: tmpId,
      source_ref: sourceRef,
      target_ref: targetRef,
      ref_kind: refKind,
      note: payload.note ?? null
    });
    return { branch: freshBranch, changed: true, docId, insertedRefId: tmpId, refId: tmpId, sourceNodeId: sourceRef, targetNodeId: targetRef };
  }

export function stageEditBranchRefDelete(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
    const docId = normalizePositiveId(branch.base_doc_id);
    const ref = payload.refId ?? payload.ref_id;
    if (ref === null || ref === undefined) throw new Error('ref.delete requires refId');
    const freshBranch = _appendEditBranchEntry(store, branch, {
      kind: 'ref.delete',
      ref_ref: ref
    });
    return { branch: freshBranch, changed: true, docId, refId: ref };
  }
