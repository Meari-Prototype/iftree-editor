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
