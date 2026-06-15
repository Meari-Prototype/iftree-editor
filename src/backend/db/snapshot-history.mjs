// 公理比对字段与编辑分支 diff（store.buildAxiomDiffRows）保持一致，避免两套 diff 体系分叉。
const AXIOM_DIFF_FIELDS = ['content', 'status', 'node_title', 'node_note'];

function shortSnapshotId(id) {
  const value = String(id ?? '');
  return value ? value.slice(0, 8) : '?';
}

// 引用边的人读描述：端点为节点时用地址（快照节点带 address），否则用 类型#短id。
function describeSnapshotRef(ref, addressById) {
  const end = (type, id) => (type === 'node'
    ? (addressById.get(id) || shortSnapshotId(id))
    : `${type || '?'}#${shortSnapshotId(id)}`);
  return `${ref.ref_kind || 'ref'} ${end(ref.source_type, ref.source_id)}→${end(ref.target_type, ref.target_id)}`;
}

// 两个快照的字段级差异。快照存了 nodes/axioms/refs（store.createSnapshot），三者都比：
// 节点逐字段、公理逐字段、引用纯增删。实体（术语库）不在快照、也不归文档 diff 管——
// 它有自己的变更通道，不从文档 diff 查。entry 统一为 field-diff 形态（无 kind，
// 靠 node_id/axiom_id/ref_id + field/old/new），由 formatDiffText / formatDiffEntry 渲染。
export function computeSnapshotDiff(prevSnapshot, currentSnapshot) {
  const entries = [];
  const prevById = new Map((prevSnapshot.nodes || []).map((node) => [node.id, node]));
  const currById = new Map((currentSnapshot.nodes || []).map((node) => [node.id, node]));
  const fields = [
    'text',
    'node_title',
    'node_note',
    'source_position',
    'node_type',
    'trust_level'
  ];

  // 节点：按稳定 id 配对，新增 old=null、删除 new=null、改字段逐项。
  for (const [id, curr] of currById) {
    const prev = prevById.get(id);
    if (!prev) {
      entries.push({ node_id: id, field: '*', old: null, new: curr.text });
      continue;
    }
    for (const field of fields) {
      if (curr[field] !== prev[field]) {
        entries.push({ node_id: id, field, old: prev[field], new: curr[field] });
      }
    }
  }
  for (const [id, prev] of prevById) {
    if (!currById.has(id)) {
      entries.push({ node_id: id, field: '*', old: prev.text, new: null });
    }
  }

  // 公理（事实前提）：快照已存，按 id 配对，比对字段对齐编辑分支 diff。
  const prevAxioms = new Map((prevSnapshot.axioms || []).map((axiom) => [String(axiom.id), axiom]));
  const currAxioms = new Map((currentSnapshot.axioms || []).map((axiom) => [String(axiom.id), axiom]));
  for (const [id, curr] of currAxioms) {
    const prev = prevAxioms.get(id);
    const label = curr.label || (prev && prev.label) || '';
    if (!prev) {
      entries.push({ axiom_id: id, label, field: '*', old: null, new: curr.content ?? '' });
      continue;
    }
    for (const field of AXIOM_DIFF_FIELDS) {
      if (String(curr[field] ?? '') !== String(prev[field] ?? '')) {
        entries.push({ axiom_id: id, label, field, old: prev[field] ?? '', new: curr[field] ?? '' });
      }
    }
  }
  for (const [id, prev] of prevAxioms) {
    if (!currAxioms.has(id)) {
      entries.push({ axiom_id: id, label: prev.label || '', field: '*', old: prev.content ?? '', new: null });
    }
  }

  // 引用边：快照已存，纯增删（ref 无可改字段）。描述带两端地址供定位；
  // 增 old=null/new=''（进增分支、不带多余内容），删 old=''/new=null（进删分支）。
  const prevAddr = new Map([...prevById].map(([id, node]) => [id, node.address]));
  const currAddr = new Map([...currById].map(([id, node]) => [id, node.address]));
  const prevRefs = new Map((prevSnapshot.refs || []).map((ref) => [String(ref.id), ref]));
  const currRefs = new Map((currentSnapshot.refs || []).map((ref) => [String(ref.id), ref]));
  for (const [id, curr] of currRefs) {
    if (!prevRefs.has(id)) {
      entries.push({ ref_id: id, ref_label: describeSnapshotRef(curr, currAddr), field: '*', old: null, new: '' });
    }
  }
  for (const [id, prev] of prevRefs) {
    if (!currRefs.has(id)) {
      entries.push({ ref_id: id, ref_label: describeSnapshotRef(prev, prevAddr), field: '*', old: '', new: null });
    }
  }

  return entries;
}

export function assertRestorableSnapshotPayload(snapshot) {
  const snapshotNodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const rootCount = snapshotNodes.filter((node) => node?.parent_id === null || node?.parentId === null).length;
  if (snapshotNodes.length === 0 || rootCount !== 1) {
    throw new Error('Refusing to restore an incomplete document snapshot');
  }
  return snapshotNodes;
}
