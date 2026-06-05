export function findSiblingInsertionTarget({ nodes, edges, sourceId, point }) {
  const nodeById = new Map((nodes || []).map((node) => [node.id, node]));
  const source = nodeById.get(sourceId);
  if (!source || !point) return null;

  const parentId = parentIdFor(edges, sourceId);
  if (parentId === null) return null;

  const siblings = (edges || [])
    .filter((edge) => edge.fromId === parentId)
    .map((edge) => nodeById.get(edge.toId))
    .filter((node) => node && node.id !== sourceId)
    .sort((left, right) => (left.y - right.y) || (left.x - right.x));

  if (siblings.length === 0) return null;

  const columnCenter = source.x + source.width / 2;
  const sameColumnTolerance = Math.max(source.width * 1.35, 280);
  if (Math.abs(point.x - columnCenter) > sameColumnTolerance) return null;

  const minY = Math.min(...siblings.map((node) => node.y)) - 64;
  const maxY = Math.max(...siblings.map((node) => node.y + node.height)) + 64;
  if (point.y < minY || point.y > maxY) return null;

  const next = siblings.find((node) => point.y < node.y + node.height / 2);
  if (next) return { kind: 'before', targetNodeId: next.id };

  return { kind: 'after', targetNodeId: siblings[siblings.length - 1].id };
}

export function parentIdFor(edges, nodeId) {
  const edge = (edges || []).find((item) => item.toId === nodeId);
  return edge ? edge.fromId : null;
}

