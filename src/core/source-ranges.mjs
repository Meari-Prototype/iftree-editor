function normalizeIndex(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatIndex(value) {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(3))).replace(/\.0+$/, '');
}

export function formatSentenceIndexes(indexes) {
  const sorted = [...new Set((indexes || [])
    .map(normalizeIndex)
    .filter((value) => value !== null))]
    .sort((a, b) => a - b);

  if (sorted.length === 0) return '';

  const parts = [];
  let start = sorted[0];
  let previous = sorted[0];

  function flush() {
    parts.push(start === previous ? formatIndex(start) : `${formatIndex(start)}-${formatIndex(previous)}`);
  }

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    if (Number.isInteger(previous) && Number.isInteger(current) && current === previous + 1) {
      previous = current;
      continue;
    }
    flush();
    start = current;
    previous = current;
  }
  flush();

  return parts.join(';');
}

export function buildNodeSentenceIndexMap(tree, sourceSpans = []) {
  const direct = new Map();
  for (const span of sourceSpans || []) {
    const nodeId = String(span.node_id || '').trim();
    const sentenceIndex = normalizeIndex(span.sentence_index);
    if (!nodeId || sentenceIndex === null) continue;
    if (!direct.has(nodeId)) direct.set(nodeId, []);
    direct.get(nodeId).push(sentenceIndex);
  }

  const aggregate = new Map();
  function visit(node) {
    if (!node) return [];
    const nodeId = String(node.id || '').trim();
    const indexes = [...(direct.get(nodeId) || [])];
    for (const child of node.children || []) indexes.push(...visit(child));
    aggregate.set(nodeId, [...new Set(indexes)].sort((a, b) => a - b));
    return aggregate.get(nodeId);
  }
  visit(tree);
  return aggregate;
}

export function buildNodeSentenceLabelMap(tree, sourceSpans = []) {
  const indexesByNode = buildNodeSentenceIndexMap(tree, sourceSpans);
  const labels = new Map();
  for (const [nodeId, indexes] of indexesByNode) {
    const label = formatSentenceIndexes(indexes);
    if (label) labels.set(nodeId, label);
  }
  return labels;
}
