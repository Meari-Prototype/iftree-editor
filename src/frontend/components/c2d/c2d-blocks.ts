// c2d-blocks.ts
// C2D 块级数据工具：axiom 块构造、块判定、索引查询、拖拽目标校验、占位文案。
// 无 React、无 DOM——从 MindMapView 组件模块级原样外提。

import type { C2DBlock, C2DTreeIndex } from './c2d-types.js';

export function axiomBlock(rawAxiom: unknown, index: number): C2DBlock {
  // axiom.id 是 uuid 或 lazy 编辑分支的 `tmp-axiom-…` 字符串；保留原值，
  // 父组件处理事实前提命令时需要用它定位真实目标。
  const axiom = (rawAxiom || {}) as { id?: unknown; label?: string; node_title?: string; content?: string; node_note?: string };
  const rawAxiomId = (axiom.id ?? null) as string | null;
  const label = String(axiom.label || `A${index + 1}`);
  return {
    id: `axiom:${rawAxiomId ?? label}`,
    axiomId: rawAxiomId,
    address: label,
    parentId: null,
    childCount: 0,
    nodeType: 'AXIOMS',
    title: String(axiom.node_title || '').trim(),
    text: String(axiom.content || '').trim(),
    note: String(axiom.node_note || '').trim()
  };
}

export function isRootNode(node: C2DBlock | null | undefined) {
  return !node?.parentId || String(node?.address || '') === '1';
}

export function isAxiomNode(node: C2DBlock | null | undefined) {
  return node?.nodeType === 'AXIOMS';
}

// id 全链路是字符串（uuidv7 / `tmp-…`，见 c2d-types），byId 键即原值。
export function lookupBlock(index: C2DTreeIndex, id: string | null | undefined): C2DBlock | null {
  return (id && index.byId.get(id)) || null;
}

export function isValidDragTarget(source: C2DBlock | null, target: C2DBlock | null): target is C2DBlock {
  if (!source || !target) return false;
  if (isAxiomNode(source) || isAxiomNode(target)) return false;
  if (source.id === target.id) return false;
  const sourceAddress = String(source.address || '');
  const targetAddress = String(target.address || '');
  if (sourceAddress && targetAddress.startsWith(`${sourceAddress}-`)) return false;
  return true;
}

export function sourcePositionText(value: unknown) {
  const position = Number(value);
  if (!Number.isFinite(position)) return '';
  return String(position);
}

export function emptyNodePlaceholder(block: C2DBlock, paragraphLabelByNodeId: Map<string, string> | null | undefined) {
  const position = sourcePositionText(block.sourcePosition);
  if (!position) return '空节点';
  const paragraphLabel = paragraphLabelByNodeId?.get(block.id);
  return paragraphLabel ? `段落 ${paragraphLabel}，句位 ${position}` : `句位 ${position}`;
}
