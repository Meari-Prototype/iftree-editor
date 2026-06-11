import { flattenTree } from './tree.mjs';

function normalizeQuery(query) {
  return String(query || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index < haystack.length) {
    const next = haystack.indexOf(needle, index);
    if (next === -1) break;
    count += 1;
    index = next + needle.length;
  }
  return count;
}

/** @param {{ tree?: any, query?: string, limit?: number }} [options] */
export function buildKeywordSearchResults({ tree, query, limit = 80 } = {}) {
  const terms = normalizeQuery(query);
  if (!tree || terms.length === 0) return [];

  const results = [];
  for (const [order, node] of flattenTree(tree).entries()) {
    const text = String(node.text || '');
    const haystack = text.toLowerCase();
    const counts = terms.map((term) => countOccurrences(haystack, term));
    if (counts.some((count) => count === 0)) continue;
    results.push({
      node_id: node.id,
      address: node.address || null,
      text: text || '空节点',
      score: counts.reduce((sum, count) => sum + count, 0),
      order
    });
  }

  return results
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, Math.max(1, Number(limit) || 80))
    .map(({ order, ...result }) => result);
}
