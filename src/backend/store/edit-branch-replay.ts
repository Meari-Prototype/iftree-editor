// 编辑分支重放阶段（L2）：解析 tmp id，并把内建或外部 entry 落到主干。

import { normalizePositiveId } from '../db/normalizers.js';
import type { EditBranchRow } from '../db/schema.js';
import { isBuiltInEditBranchEntry, type EditBranchEntry } from './edit-branch-contract.js';
import type { EditBranchStore } from './edit-branch.js';

type RowObject = Record<string, unknown>;
type EditBranchDiff = RowObject & { entries?: EditBranchEntry[] };
type IdRow = { id: string };

function activeEntries(store: EditBranchStore, entries: unknown): EditBranchEntry[] {
  return store.requireEditBranchPort().activeEditBranchEntries(entries) as EditBranchEntry[];
}

export function applyEditBranchDiffEntries(store: EditBranchStore, branch: EditBranchRow, diff: EditBranchDiff = {}) {
    const entries = activeEntries(store, diff.entries);
    const baseDocId = normalizePositiveId(branch.base_doc_id);
    // tmp_id（key）总是 stage 端 nextTmpId 出的 string；实 id（value）总是 store.addNode/addAxiom/...
    // 返回的 IdRow.id（string）。Map 类型一开始就标对，下面 set/get 不再绕一道 unknown。
    const nodeIdByTmp = new Map<string, string>();
    const axiomIdByTmp = new Map<string, string>();
    const refIdByTmp = new Map<string, string>();
    const entityIdByTmp = new Map<string, string>();
    const resolveNodeId = (ref: unknown) => {
      if (ref === null || ref === undefined) return null;
      if (store.requireEditBranchPort().isTmpId(ref)) {
        const real = nodeIdByTmp.get(ref);
        if (!real) throw new Error(`apply: unresolved tmp node id ${ref}`);
        return real;
      }
      const id = normalizePositiveId(ref);
      if (!id) throw new Error(`apply: invalid node id ${ref}`);
      return id;
    };
    const resolveAxiomId = (ref: unknown) => {
      if (ref === null || ref === undefined) return null;
      if (store.requireEditBranchPort().isTmpId(ref)) {
        const real = axiomIdByTmp.get(ref);
        if (!real) throw new Error(`apply: unresolved tmp axiom id ${ref}`);
        return real;
      }
      const id = normalizePositiveId(ref);
      if (!id) throw new Error(`apply: invalid axiom id ${ref}`);
      return id;
    };
    const resolveRefId = (ref: unknown) => {
      if (ref === null || ref === undefined) return null;
      if (store.requireEditBranchPort().isTmpId(ref)) {
        const real = refIdByTmp.get(ref);
        if (!real) throw new Error(`apply: unresolved tmp ref id ${ref}`);
        return real;
      }
      const id = normalizePositiveId(ref);
      if (!id) throw new Error(`apply: invalid ref id ${ref}`);
      return id;
    };
    const resolveEntityId = (ref: unknown) => {
      if (ref === null || ref === undefined) return null;
      if (store.requireEditBranchPort().isTmpId(ref)) {
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
    const nodeRowExists = (id: unknown) => Boolean(store.db!.prepare('SELECT 1 FROM nodes WHERE id = ?').get<unknown>(id));

    for (const entry of entries) {
      if (!store.requireEditBranchPort().isSupportedEditBranchEntryKind(entry?.kind)) {
        throw new Error(`Unsupported edit branch diff entry: ${entry?.kind || ''}`);
      }
      if (!isBuiltInEditBranchEntry(entry)) {
        const applied = store.requireExternalEntryPort().applyExternalEntry(
          store,
          entry,
          { resolveEntityId, resolveNodeId, entityIdByTmp, baseDocId }
        );
        if (!applied) {
          throw new Error(`Unhandled edit branch diff entry kind: ${String(entry.kind || '')}`);
        }
        continue;
      }
      switch (entry.kind) {
        case 'node.update': {
          const nodeId = resolveNodeId(entry.node_id);
          store.updateNode(nodeId, entry.patch as RowObject);
          break;
        }
        case 'node.insert': {
          const fields = (entry.fields || {}) as RowObject;
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
          const subtreeIds = store.db!.prepare(`
            WITH RECURSIVE subtree(id) AS (
              SELECT id FROM nodes WHERE id = ?
              UNION ALL
              SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
            )
            SELECT id FROM subtree
          `);
          const beforeIds = new Set(subtreeIds.all<IdRow>(targetId).map((row: IdRow) => String(row.id)));
          store.splitNodeIntoChildren(targetId);
          // Build tmp_id -> real id mapping so later entries that reference
          // the freshly-split children resolve correctly.
          if (entry.strategy === 'source_paragraphs' && Array.isArray(entry.paragraph_splits)) {
            for (const split of entry.paragraph_splits) {
              const realParagraphId = resolveNodeId(split.paragraph_node_id);
              const realChildren = store.db!.prepare(`
                SELECT id FROM nodes WHERE parent_id = ?
                ORDER BY sort_order, id
              `).all<IdRow>(realParagraphId);
              const newChildren = realChildren.filter((row: IdRow) => !beforeIds.has(String(row.id)));
              const spans = Array.isArray(split.spans) ? split.spans : [];
              spans.forEach((span, position: number) => {
                const row = newChildren[position];
                if (span?.tmp_id && row) nodeIdByTmp.set(span.tmp_id, row.id);
              });
            }
          } else if (entry.strategy === 'split_sentences' && Array.isArray(entry.new_node_ids)) {
            const realChildren = store.db!.prepare(`
              SELECT id FROM nodes WHERE parent_id = ?
              ORDER BY sort_order, id
            `).all<IdRow>(targetId);
            const newChildren = realChildren.filter((row: IdRow) => !beforeIds.has(String(row.id)));
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
          const fields = (entry.fields || {}) as RowObject;
          const created = store.addAxiom({
            docId: baseDocId,
            content: fields.content ?? '',
            status: fields.status ?? 'pending',
            nodeTitle: fields.node_title ?? '',
            nodeNote: fields.node_note ?? ''
          }) as IdRow;
          if (entry.tmp_id) axiomIdByTmp.set(entry.tmp_id, created.id);
          break;
        }
        case 'axiom.update': {
          store.updateAxiom(resolveAxiomId(entry.axiom_ref), entry.patch as RowObject);
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
          }) as IdRow;
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
          }) as IdRow;
          if (entry.tmp_id) refIdByTmp.set(entry.tmp_id, created.id);
          break;
        }
        case 'ref.delete': {
          store.deleteRef(resolveRefId(entry.ref_ref));
          break;
        }
      }
    }
  }
