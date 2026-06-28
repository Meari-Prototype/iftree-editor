import {
  docRefresh,
  ownPatch,
  plain,
  refDocId,
  requireDocId,
  requireId,
  rowById
} from './shared.js';
import type { IftreeStore } from '../../store/index.js';

type WritePayload = Record<string, unknown>;
type EffectList = Array<Record<string, unknown>>;

type AxiomRefStore = IftreeStore;

function axiomPayload(payload: WritePayload = {}): WritePayload {
  return {
    ...payload,
    docId: payload.docId ?? payload.doc_id,
    nodeTitle: payload.nodeTitle ?? payload.node_title ?? '',
    nodeNote: payload.nodeNote ?? payload.node_note ?? '',
    nodeWidth: payload.nodeWidth ?? payload.node_width ?? null,
    nodeHeight: payload.nodeHeight ?? payload.node_height ?? null,
    nodeSizeMode: payload.nodeSizeMode ?? payload.node_size_mode ?? 'auto'
  };
}

function axiomRefPayload(payload: WritePayload = {}): WritePayload {
  return {
    ...payload,
    docId: payload.docId ?? payload.doc_id,
    nodeId: payload.nodeId ?? payload.node_id,
    axiomId: payload.axiomId ?? payload.axiom_id,
    note: payload.note ?? null
  };
}

function nodeRefPayload(payload: WritePayload = {}): WritePayload {
  return {
    ...payload,
    docId: payload.docId ?? payload.doc_id,
    sourceNodeId: payload.sourceNodeId ?? payload.source_node_id ?? payload.nodeId ?? payload.node_id,
    targetNodeId: payload.targetNodeId ?? payload.target_node_id,
    refKind: payload.refKind ?? payload.ref_kind ?? payload.kind,
    note: payload.note ?? null
  };
}

export function handleAxiomMutation(store: AxiomRefStore, payload: WritePayload, action: string, effects: EffectList) {
  if (action === 'axiom.add') {
    const docId = requireDocId(payload);
    const axiom = store.addAxiom(axiomPayload(payload));
    if (!axiom) throw new Error('axiom.add: store.addAxiom returned no row');
    return docRefresh(action, docId, { axiom: plain(axiom), axiomId: axiom.id, sideEffects: effects });
  }

  if (action === 'axiom.update') {
    const axiomId = requireId(payload, 'axiomId', 'axiom_id');
    const axiom = store.updateAxiom(axiomId, ownPatch(payload));
    if (!axiom) throw new Error(`axiom.update: axiom not found: ${axiomId}`);
    return docRefresh(action, axiom.doc_id, { axiom: plain(axiom), axiomId, sideEffects: effects });
  }

  if (action === 'axiom.delete') {
    const axiomId = requireId(payload, 'axiomId', 'axiom_id');
    const before = rowById(store, 'axioms', axiomId);
    const changed = store.deleteAxiom(axiomId);
    return docRefresh(action, before?.doc_id ?? payload.docId ?? null, { changed: Boolean(changed), axiomId, sideEffects: effects });
  }

  if (action === 'axiom.move') {
    const docId = requireDocId(payload);
    const axiomId = requireId(payload, 'axiomId', 'axiom_id');
    const direction = payload.direction === 'up' ? 'up' : 'down';
    const changed = store.moveAxiom({
      docId,
      axiomId,
      direction
    });
    return docRefresh(action, docId, { changed: Boolean(changed), axiomId, direction, sideEffects: effects });
  }

  throw new Error(`Unhandled database_write action: ${action}`);
}

export function handleRefMutation(store: AxiomRefStore, payload: WritePayload, action: string, effects: EffectList) {
  if (action === 'ref.addNodeToNode') {
    const docId = requireDocId(payload);
    const ref = store.addNodeRefToNode(nodeRefPayload(payload));
    if (!ref) throw new Error('ref.addNodeToNode: store returned no row');
    return docRefresh(action, docId, { ref: plain(ref), refId: ref.id, sideEffects: effects });
  }
  if (action === 'ref.addAxiomToNode') {
    const docId = requireDocId(payload);
    const ref = store.addAxiomRefToNode(axiomRefPayload(payload));
    if (!ref) throw new Error('ref.addAxiomToNode: store returned no row');
    return docRefresh(action, docId, { ref: plain(ref), refId: ref.id, sideEffects: effects });
  }
  if (action === 'ref.delete') {
    const refId = requireId(payload, 'refId', 'ref_id');
    const docId = refDocId(store, refId) ?? payload.docId ?? null;
    const changed = store.deleteRef(refId);
    return docRefresh(action, docId, { changed: Boolean(changed), refId, sideEffects: effects });
  }
  throw new Error(`Unhandled database_write action: ${action}`);
}
