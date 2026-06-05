import {
  compareStableIds,
  normalizeStableId
} from './db/ids.mjs';
import { normalizeNodeType } from '../core/node-model.mjs';

// Lazy diff projection: take a base doc snapshot (nodes/axioms/refs) plus a list
// of edit branch entries, and return the projected document state the user
// should see while editing — without ever writing to the base tables.
//
// Conventions:
//   - A "ref" in entry payloads is either a positive integer (an existing
//     base id) or a tmp id string of the form `tmp-node-…`, `tmp-axiom-…`,
//     `tmp-ref-…`. Tmp ids are produced by stage* functions when entries
//     create new rows.
//   - The projection only tracks the columns the editor UI cares about. It
//     does not try to replay refreshAddressScopes / structureMetadata side
//     effects exactly. Address and depth are recomputed once at the end so
//     the UI always sees consistent tree paths.

const SUPPORTED_ENTRY_KINDS = new Set([
  'node.update',
  'node.insert',
  'node.delete',
  'node.move',
  'node.promote',
  'node.split',
  'node.mergeInto',
  'node.mergePrevious',
  'node.reparent',
  'node.moveBefore',
  'node.moveAfter',
  'axiom.add',
  'axiom.update',
  'axiom.delete',
  'axiom.move',
  'ref.addNodeToNode',
  'ref.addAxiomToNode',
  'ref.delete',
  'entity.create',
  'entity.update',
  'entity.delete',
  'entity.link',
  'entity.unlink',
  'entity.bindNode',
  'entity.ignoreNode',
  'entity.clearNodeBinding'
]);

export function isSupportedEditBranchEntryKind(kind) {
  return SUPPORTED_ENTRY_KINDS.has(String(kind || ''));
}

export function isActiveEditBranchEntry(entry) {
  return String(entry?.status || 'active') !== 'undone';
}

export function activeEditBranchEntries(entries = []) {
  return (Array.isArray(entries) ? entries : []).filter(isActiveEditBranchEntry);
}

export function undoneEditBranchEntries(entries = []) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => !isActiveEditBranchEntry(entry));
}

function cloneRow(row) {
  return row ? { ...row } : row;
}

function cloneState(base) {
  return {
    docId: base.docId,
    nodes: (base.nodes || []).map(cloneRow),
    axioms: (base.axioms || []).map(cloneRow),
    refs: (base.refs || []).map(cloneRow),
    nodeIdSeq: -1,
    axiomIdSeq: -1,
    refIdSeq: -1
  };
}

function isTmpId(value) {
  return typeof value === 'string' && value.startsWith('tmp-');
}

function normalizeId(value) {
  if (value === null || value === undefined) return null;
  if (isTmpId(value)) return value;
  return normalizeStableId(value);
}

function findNodeIndex(state, ref) {
  if (ref === null || ref === undefined) return -1;
  if (isTmpId(ref)) return state.nodes.findIndex((node) => node.id === ref);
  return state.nodes.findIndex((node) => sameRef(node.id, ref));
}

function findAxiomIndex(state, ref) {
  if (ref === null || ref === undefined) return -1;
  if (isTmpId(ref)) return state.axioms.findIndex((axiom) => axiom.id === ref);
  return state.axioms.findIndex((axiom) => sameRef(axiom.id, ref));
}

function findRefIndex(state, ref) {
  if (ref === null || ref === undefined) return -1;
  if (isTmpId(ref)) return state.refs.findIndex((entry) => entry.id === ref);
  return state.refs.findIndex((entry) => sameRef(entry.id, ref));
}

function descendantNodeIds(state, rootId) {
  const result = new Set([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const node of state.nodes) {
      if (result.has(node.id)) continue;
      const parentId = node.parent_id;
      if (parentId !== null && parentId !== undefined && result.has(parentId)) {
        result.add(node.id);
        added = true;
      }
    }
  }
  return result;
}

function resortSiblings(state, parentRef) {
  const parentId = parentRef === null || parentRef === undefined ? null : parentRef;
  const siblings = state.nodes.filter((node) => sameRef(node.parent_id, parentId));
  siblings.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)
    || compareIdForOrder(a.id, b.id));
  for (let index = 0; index < siblings.length; index += 1) {
    siblings[index].sort_order = index + 1;
  }
}

function compareIdForOrder(left, right) {
  return compareStableIds(left, right);
}

function sameRef(left, right) {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return String(left) === String(right);
}

function patchNodeRow(row, patch) {
  const next = { ...row };
  if (Object.prototype.hasOwnProperty.call(patch, 'text')) next.text = patch.text ?? '';
  if (Object.prototype.hasOwnProperty.call(patch, 'node_title')) next.node_title = patch.node_title ?? '';
  if (Object.prototype.hasOwnProperty.call(patch, 'node_note')) next.node_note = patch.node_note ?? '';
  if (Object.prototype.hasOwnProperty.call(patch, 'node_type')) next.node_type = normalizeNodeType(patch.node_type ?? row.node_type);
  if (Object.prototype.hasOwnProperty.call(patch, 'trust_level')) next.trust_level = patch.trust_level ?? null;
  if (Object.prototype.hasOwnProperty.call(patch, 'source_position')) next.source_position = patch.source_position ?? null;
  next.updated_at = new Date().toISOString();
  return next;
}

function applyNodeUpdate(state, entry) {
  const index = findNodeIndex(state, entry.node_id ?? entry.target_ref);
  if (index < 0) return;
  state.nodes[index] = patchNodeRow(state.nodes[index], entry.patch || {});
}

function applyNodeInsert(state, entry) {
  const parentRef = normalizeId(entry.parent_ref);
  const afterRef = normalizeId(entry.after_ref);
  const fields = entry.fields || {};
  const siblings = state.nodes.filter((node) => sameRef(node.parent_id, parentRef));
  siblings.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));

  let sortOrder = siblings.length + 1;
  if (afterRef !== null) {
    const afterIndex = siblings.findIndex((node) => sameRef(node.id, afterRef));
    if (afterIndex >= 0) sortOrder = (Number(siblings[afterIndex].sort_order) || 0) + 1;
  }
  for (const sibling of siblings) {
    if ((Number(sibling.sort_order) || 0) >= sortOrder) sibling.sort_order = (Number(sibling.sort_order) || 0) + 1;
  }
  const now = new Date().toISOString();
  state.nodes.push({
    id: entry.tmp_id,
    doc_id: state.docId,
    parent_id: parentRef,
    sort_order: sortOrder,
    depth: 0,
    address: '',
    node_type: normalizeNodeType(fields.node_type || fields.nodeType || 'TEXT'),
    text: fields.text ?? '',
    node_title: fields.node_title || fields.nodeTitle || '',
    node_note: fields.node_note || fields.nodeNote || '',
    source_position: fields.source_position ?? null,
    trust_level: fields.trust_level ?? null,
    created_at: now,
    updated_at: now,
    child_count: 0,
    pending_insert: true
  });
}

function applyNodeDelete(state, entry) {
  const targetRef = normalizeId(entry.target_ref ?? entry.node_id);
  const index = findNodeIndex(state, targetRef);
  if (index < 0) return;
  const target = state.nodes[index];
  if (target.parent_id === null || target.parent_id === undefined) return;
  const removeIds = descendantNodeIds(state, target.id);
  state.nodes = state.nodes.filter((node) => !removeIds.has(node.id));
  state.refs = state.refs.filter((ref) => {
    if (ref.source_type === 'node' && removeIds.has(ref.source_id)) return false;
    if (ref.target_type === 'node' && removeIds.has(ref.target_id)) return false;
    return true;
  });
  resortSiblings(state, target.parent_id);
}

function applyNodeMove(state, entry) {
  const index = findNodeIndex(state, entry.target_ref ?? entry.node_id);
  if (index < 0) return;
  const node = state.nodes[index];
  if (node.parent_id === null || node.parent_id === undefined) return;
  const siblings = state.nodes.filter((other) => sameRef(other.parent_id, node.parent_id));
  siblings.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  const order = siblings.findIndex((other) => sameRef(other.id, node.id));
  const targetOrder = entry.direction === 'up' ? order - 1 : order + 1;
  if (targetOrder < 0 || targetOrder >= siblings.length) return;
  const sibling = siblings[targetOrder];
  const tmp = node.sort_order;
  node.sort_order = sibling.sort_order;
  sibling.sort_order = tmp;
}

function applyNodePromote(state, entry) {
  const index = findNodeIndex(state, entry.target_ref ?? entry.node_id);
  if (index < 0) return;
  const node = state.nodes[index];
  if (node.parent_id === null || node.parent_id === undefined) return;
  const parentIndex = findNodeIndex(state, node.parent_id);
  if (parentIndex < 0) return;
  const parent = state.nodes[parentIndex];
  if (parent.parent_id === null || parent.parent_id === undefined) return;
  const grandSiblings = state.nodes.filter((other) => sameRef(other.parent_id, parent.parent_id));
  grandSiblings.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  const parentOrder = grandSiblings.findIndex((other) => sameRef(other.id, parent.id));
  const insertOrder = parentOrder >= 0 ? parentOrder + 2 : grandSiblings.length + 1;
  for (const other of state.nodes) {
    if (sameRef(other.parent_id, parent.parent_id) && (Number(other.sort_order) || 0) >= insertOrder) {
      other.sort_order = (Number(other.sort_order) || 0) + 1;
    }
  }
  node.parent_id = parent.parent_id;
  node.sort_order = insertOrder;
  resortSiblings(state, parent.id);
}

function applyNodeSplitParagraphMode(state, entry) {
  const splits = Array.isArray(entry.paragraph_splits) ? entry.paragraph_splits : [];
  const now = new Date().toISOString();
  for (const split of splits) {
    const idx = findNodeIndex(state, split.paragraph_node_id);
    if (idx < 0) continue;
    const paragraph = state.nodes[idx];
    paragraph.text = '';
    paragraph.updated_at = now;
    const spans = Array.isArray(split.spans) ? split.spans : [];
    spans.forEach((span, position) => {
      state.nodes.push({
        id: span.tmp_id,
        doc_id: state.docId,
        parent_id: paragraph.id,
        sort_order: position + 1,
        depth: 0,
        address: '',
        node_type: 'TEXT',
        text: span.text ?? '',
        node_title: '',
        node_note: '',
        source_position: span.sentence_index ?? null,
        trust_level: null,
        created_at: now,
        updated_at: now,
        child_count: 0,
        pending_insert: true
      });
    });
    resortSiblings(state, paragraph.id);
  }
}

function applyNodeSplitSentenceMode(state, entry) {
  const index = findNodeIndex(state, entry.target_ref ?? entry.node_id);
  if (index < 0) return;
  const node = state.nodes[index];
  const sentences = Array.isArray(entry.sentences) ? entry.sentences.filter((s) => s && String(s).trim()) : [];
  const newIds = Array.isArray(entry.new_node_ids) ? entry.new_node_ids : [];
  if (sentences.length < 2 || newIds.length !== sentences.length - 1) return;
  node.text = sentences[0];
  node.updated_at = new Date().toISOString();
  for (const other of state.nodes) {
    if (sameRef(other.parent_id, node.id) && (Number(other.sort_order) || 0) >= 1) {
      other.sort_order = (Number(other.sort_order) || 0) + sentences.length - 1;
    }
  }
  const now = new Date().toISOString();
  sentences.slice(1).forEach((sentence, position) => {
    state.nodes.push({
      id: newIds[position],
      doc_id: state.docId,
      parent_id: node.id,
      sort_order: position + 1,
      depth: 0,
      address: '',
      node_type: 'TEXT',
      text: sentence,
      node_title: '',
      node_note: '',
      source_position: null,
      trust_level: null,
      created_at: now,
      updated_at: now,
      child_count: 0,
      pending_insert: true
    });
  });
  resortSiblings(state, node.id);
}

function applyNodeSplit(state, entry) {
  if (entry.strategy === 'source_paragraphs') {
    applyNodeSplitParagraphMode(state, entry);
    return;
  }
  applyNodeSplitSentenceMode(state, entry);
}

function applyNodeMergeInto(state, entry) {
  const sourceIndex = findNodeIndex(state, entry.source_ref ?? entry.node_id);
  const targetIndex = findNodeIndex(state, entry.target_ref ?? entry.target_node_id);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const source = state.nodes[sourceIndex];
  const target = state.nodes[targetIndex];
  if (source.parent_id === null || target.parent_id === null) return;
  if (sameRef(source.id, target.id)) return;
  const targetText = (target.text || '').trim();
  const sourceText = (source.text || '').trim();
  target.text = targetText && sourceText ? `${targetText}\n${sourceText}` : (targetText || sourceText);
  target.updated_at = new Date().toISOString();
  const targetChildSiblings = state.nodes.filter((other) => sameRef(other.parent_id, target.id));
  let nextOrder = targetChildSiblings.length;
  for (const child of state.nodes) {
    if (sameRef(child.parent_id, source.id)) {
      child.parent_id = target.id;
      nextOrder += 1;
      child.sort_order = nextOrder;
    }
  }
  for (const ref of state.refs) {
    if (ref.source_type === 'node' && sameRef(ref.source_id, source.id)) ref.source_id = target.id;
    if (ref.target_type === 'node' && sameRef(ref.target_id, source.id)) ref.target_id = target.id;
  }
  const sourceParent = source.parent_id;
  state.nodes = state.nodes.filter((node) => !sameRef(node.id, source.id));
  resortSiblings(state, sourceParent);
  resortSiblings(state, target.id);
}

function applyNodeReparent(state, entry) {
  const index = findNodeIndex(state, entry.node_ref ?? entry.node_id);
  if (index < 0) return;
  const node = state.nodes[index];
  if (node.parent_id === null || node.parent_id === undefined) return;
  const newParentRef = normalizeId(entry.new_parent_ref ?? entry.new_parent_id);
  if (newParentRef === null) return;
  if (sameRef(node.id, newParentRef)) return;
  const newParentIndex = findNodeIndex(state, newParentRef);
  if (newParentIndex < 0) return;
  // Disallow moving under own descendant
  const descendants = descendantNodeIds(state, node.id);
  if (descendants.has(state.nodes[newParentIndex].id)) return;
  const oldParent = node.parent_id;
  const newSiblings = state.nodes.filter((other) => sameRef(other.parent_id, newParentRef));
  node.parent_id = newParentRef;
  node.sort_order = newSiblings.length + 1;
  resortSiblings(state, oldParent);
  resortSiblings(state, newParentRef);
}

function applyNodeMoveAfter(state, entry) {
  const nodeIndex = findNodeIndex(state, entry.node_ref ?? entry.node_id);
  const targetIndex = findNodeIndex(state, entry.target_ref ?? entry.target_node_id);
  if (nodeIndex < 0 || targetIndex < 0) return;
  const node = state.nodes[nodeIndex];
  const target = state.nodes[targetIndex];
  if (node.parent_id === null || target.parent_id === null) return;
  if (sameRef(node.id, target.id)) return;
  const descendants = descendantNodeIds(state, node.id);
  if (descendants.has(target.id)) return;
  const oldParent = node.parent_id;
  const newParent = target.parent_id;
  const newSiblings = state.nodes.filter((other) => sameRef(other.parent_id, newParent) && !sameRef(other.id, node.id));
  newSiblings.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  const targetOrder = newSiblings.findIndex((other) => sameRef(other.id, target.id));
  const insertOrder = targetOrder >= 0 ? targetOrder + 2 : newSiblings.length + 1;
  node.parent_id = newParent;
  node.sort_order = insertOrder;
  // Push siblings after insertOrder down by 1
  for (const other of state.nodes) {
    if (other === node) continue;
    if (sameRef(other.parent_id, newParent) && (Number(other.sort_order) || 0) >= insertOrder) {
      other.sort_order = (Number(other.sort_order) || 0) + 1;
    }
  }
  resortSiblings(state, oldParent);
  resortSiblings(state, newParent);
}

function applyAxiomAdd(state, entry) {
  const fields = entry.fields || {};
  const nextLabelNum = state.axioms
    .map((axiom) => {
      const match = String(axiom.label || '').match(/^A(\d+)$/);
      return match ? Number(match[1]) : 0;
    })
    .reduce((max, value) => Math.max(max, value), 0) + 1;
  const label = `A${nextLabelNum}`;
  state.axioms.push({
    id: entry.tmp_id,
    doc_id: state.docId,
    label,
    content: fields.content ?? '',
    status: fields.status || 'pending',
    node_title: fields.node_title || `事实前提 ${label}`,
    node_note: fields.node_note || '',
    node_width: null,
    node_height: null,
    node_size_mode: 'auto',
    pending_insert: true
  });
}

function applyAxiomUpdate(state, entry) {
  const index = findAxiomIndex(state, entry.axiom_ref ?? entry.axiom_id);
  if (index < 0) return;
  const axiom = state.axioms[index];
  const patch = entry.patch || {};
  if (Object.prototype.hasOwnProperty.call(patch, 'content')) axiom.content = patch.content ?? '';
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) axiom.status = patch.status || 'pending';
  if (Object.prototype.hasOwnProperty.call(patch, 'node_title')) axiom.node_title = patch.node_title ?? '';
  if (Object.prototype.hasOwnProperty.call(patch, 'node_note')) axiom.node_note = patch.node_note ?? '';
}

function applyAxiomDelete(state, entry) {
  const index = findAxiomIndex(state, entry.axiom_ref ?? entry.axiom_id);
  if (index < 0) return;
  const axiom = state.axioms[index];
  state.axioms.splice(index, 1);
  state.refs = state.refs.filter((ref) => {
    if (ref.source_type === 'axiom' && sameRef(ref.source_id, axiom.id)) return false;
    if (ref.target_type === 'axiom' && sameRef(ref.target_id, axiom.id)) return false;
    return true;
  });
  // Relabel
  state.axioms.sort((a, b) => {
    const left = Number(String(a.label || '').replace(/^A/, '')) || 0;
    const right = Number(String(b.label || '').replace(/^A/, '')) || 0;
    return left - right;
  });
  for (let i = 0; i < state.axioms.length; i += 1) {
    state.axioms[i].label = `A${i + 1}`;
  }
}

function applyAxiomMove(state, entry) {
  const index = findAxiomIndex(state, entry.axiom_ref ?? entry.axiom_id);
  if (index < 0) return;
  const targetIndex = entry.direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= state.axioms.length) return;
  const current = state.axioms[index];
  const target = state.axioms[targetIndex];
  const tmp = current.label;
  current.label = target.label;
  target.label = tmp;
  state.axioms.sort((a, b) => {
    const left = Number(String(a.label || '').replace(/^A/, '')) || 0;
    const right = Number(String(b.label || '').replace(/^A/, '')) || 0;
    return left - right;
  });
}

function applyRefAddAxiomToNode(state, entry) {
  const nodeRef = normalizeId(entry.node_ref ?? entry.node_id);
  const axiomRef = normalizeId(entry.axiom_ref ?? entry.axiom_id);
  if (nodeRef === null || axiomRef === null) return;
  state.refs.push({
    id: entry.tmp_id,
    source_type: 'axiom',
    source_id: axiomRef,
    target_type: 'node',
    target_id: nodeRef,
    ref_kind: 'axiom',
    note: entry.note ?? null,
    pending_insert: true
  });
}

function applyRefAddNodeToNode(state, entry) {
  const sourceRef = normalizeId(entry.source_ref ?? entry.source_node_id);
  const targetRef = normalizeId(entry.target_ref ?? entry.target_node_id);
  const refKind = String(entry.ref_kind ?? entry.kind ?? '').trim();
  if (sourceRef === null || targetRef === null || !refKind) return;
  state.refs.push({
    id: entry.tmp_id,
    source_type: 'node',
    source_id: sourceRef,
    target_type: 'node',
    target_id: targetRef,
    ref_kind: refKind,
    note: entry.note ?? null,
    pending_insert: true
  });
}

function applyRefDelete(state, entry) {
  const index = findRefIndex(state, entry.ref_ref ?? entry.ref_id);
  if (index < 0) return;
  state.refs.splice(index, 1);
}

const APPLIERS = {
  'node.update': applyNodeUpdate,
  'node.insert': applyNodeInsert,
  'node.delete': applyNodeDelete,
  'node.move': applyNodeMove,
  'node.promote': applyNodePromote,
  'node.split': applyNodeSplit,
  'node.mergeInto': applyNodeMergeInto,
  'node.mergePrevious': applyNodeMergeInto,
  'node.reparent': applyNodeReparent,
  'node.moveBefore': applyNodeMoveAfter,
  'node.moveAfter': applyNodeMoveAfter,
  'axiom.add': applyAxiomAdd,
  'axiom.update': applyAxiomUpdate,
  'axiom.delete': applyAxiomDelete,
  'axiom.move': applyAxiomMove,
  'ref.addNodeToNode': applyRefAddNodeToNode,
  'ref.addAxiomToNode': applyRefAddAxiomToNode,
  'ref.delete': applyRefDelete
};

function recomputeAddressesAndDepth(state) {
  const childrenByParent = new Map();
  for (const node of state.nodes) {
    const parentKey = node.parent_id === null || node.parent_id === undefined ? 'root' : node.parent_id;
    if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
    childrenByParent.get(parentKey).push(node);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)
      || compareIdForOrder(a.id, b.id));
    for (let index = 0; index < list.length; index += 1) {
      list[index].sort_order = index + 1;
    }
  }
  const roots = childrenByParent.get('root') || [];
  const visit = (node, address, depth) => {
    node.address = address;
    node.depth = depth;
    const key = node.id;
    const children = childrenByParent.get(key) || [];
    node.child_count = children.length;
    for (let index = 0; index < children.length; index += 1) {
      visit(children[index], `${address}-${index + 1}`, depth + 1);
    }
  };
  for (let index = 0; index < roots.length; index += 1) {
    visit(roots[index], String(index + 1), 1);
  }
}

export function projectEditBranchDoc(base, entries = []) {
  const state = cloneState(base);
  for (const entry of entries) {
    if (!isActiveEditBranchEntry(entry)) continue;
    const kind = String(entry?.kind || '');
    if (!SUPPORTED_ENTRY_KINDS.has(kind)) continue;
    const apply = APPLIERS[kind];
    if (!apply) continue;
    try {
      apply(state, entry);
    } catch {
      // entries may reference ids that were since invalidated by an earlier
      // delete; skip such entries rather than crashing the whole projection.
    }
  }
  recomputeAddressesAndDepth(state);
  return state;
}

let tmpIdCounter = 0;
export function nextTmpId(kind = 'node') {
  tmpIdCounter += 1;
  return `tmp-${kind}-${Date.now().toString(36)}-${tmpIdCounter.toString(36)}`;
}

export { isTmpId, sameRef };
