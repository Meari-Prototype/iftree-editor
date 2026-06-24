function normalizeIndex(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatIndex(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(3))).replace(/\.0+$/, '');
}

export function formatSentenceIndexes(indexes: (number | null)[] | null | undefined): string {
  const sorted = [...new Set((indexes || [])
    .map(normalizeIndex)
    .filter((value): value is number => value !== null))]
    .sort((a, b) => a - b);

  if (sorted.length === 0) return '';

  const parts: string[] = [];
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

interface SourceSpan {
  node_id?: unknown;
  sentence_index?: unknown;
}

interface TreeNodeLike {
  id?: unknown;
  children?: TreeNodeLike[];
}

export function buildNodeSentenceIndexMap(tree: TreeNodeLike | null, sourceSpans: SourceSpan[] = []): Map<string, number[]> {
  const direct = new Map<string, number[]>();
  for (const span of sourceSpans || []) {
    const nodeId = String(span.node_id || '').trim();
    const sentenceIndex = normalizeIndex(span.sentence_index);
    if (!nodeId || sentenceIndex === null) continue;
    if (!direct.has(nodeId)) direct.set(nodeId, []);
    direct.get(nodeId)!.push(sentenceIndex);
  }

  const aggregate = new Map<string, number[]>();
  function visit(node: TreeNodeLike | null | undefined): number[] {
    if (!node) return [];
    const nodeId = String(node.id || '').trim();
    const indexes = [...(direct.get(nodeId) || [])];
    for (const child of node.children || []) indexes.push(...visit(child));
    aggregate.set(nodeId, [...new Set(indexes)].sort((a, b) => a - b));
    return aggregate.get(nodeId)!;
  }
  visit(tree);
  return aggregate;
}

export function buildNodeSentenceLabelMap(tree: TreeNodeLike | null, sourceSpans: SourceSpan[] = []): Map<string, string> {
  const indexesByNode = buildNodeSentenceIndexMap(tree, sourceSpans);
  const labels = new Map<string, string>();
  for (const [nodeId, indexes] of indexesByNode) {
    const label = formatSentenceIndexes(indexes);
    if (label) labels.set(nodeId, label);
  }
  return labels;
}