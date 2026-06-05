import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyMindMapResizePreview,
  applyMindMapSizeOverrides,
  createMindMapHitIndex,
  fitCanvasTextScale,
  hitTestMindMapNode,
  mindMapDetailLevel,
  mindMapNodeDrawPlan
} from '../src/core/mindmap-renderer.mjs';

const nodes = [
  { id: 1, x: 0, y: 0, width: 220, height: 90, cardHeight: 72, address: '1', text: 'Root' },
  { id: 2, x: 260, y: 0, width: 220, height: 110, cardHeight: 90, address: '1-1', text: 'First child' },
  { id: 3, x: 260, y: 140, width: 220, height: 80, cardHeight: 72, address: '1-2', text: 'Second child' }
];

test('mindMapDetailLevel keeps all nodes drawable in panorama scale', () => {
  assert.equal(mindMapDetailLevel(0.05), 'overview');
  assert.equal(mindMapDetailLevel(0.12), 'labels');
  assert.equal(mindMapDetailLevel(0.3), 'detail');
  assert.equal(mindMapDetailLevel(1.2), 'detail');
});

test('mindMapNodeDrawPlan produces a shape command for every node at overview scale', () => {
  const plan = mindMapNodeDrawPlan({
    nodes,
    scale: 0.05,
    selectedNodeId: 2,
    errorNodeIds: new Set([3])
  });

  assert.equal(plan.level, 'overview');
  assert.equal(plan.nodes.length, nodes.length);
  assert.deepEqual(plan.nodes.map((node) => node.id), [1, 2, 3]);
  assert.equal(plan.nodes.every((node) => node.drawText === false), true);
  assert.equal(plan.nodes.find((node) => node.id === 2).selected, true);
  assert.equal(plan.nodes.find((node) => node.id === 3).hasError, true);
});

test('mindMapNodeDrawPlan enables readable text only at higher detail levels', () => {
  const labels = mindMapNodeDrawPlan({ nodes, scale: 0.12 });
  const detail = mindMapNodeDrawPlan({ nodes, scale: 0.3 });

  assert.equal(labels.nodes.every((node) => node.drawAddress), true);
  assert.equal(labels.nodes.every((node) => node.drawText === false), true);
  assert.equal(detail.nodes.every((node) => node.drawText), true);
});

test('hitTestMindMapNode finds nodes from the layout index without DOM elements', () => {
  const index = createMindMapHitIndex(nodes, { cellSize: 160 });

  assert.equal(hitTestMindMapNode(index, { x: 270, y: 20 })?.id, 2);
  assert.equal(hitTestMindMapNode(index, { x: 270, y: 20 }, new Set([2])), null);
  assert.equal(hitTestMindMapNode(index, { x: 270, y: 150 })?.id, 3);
  assert.equal(hitTestMindMapNode(index, { x: 900, y: 900 }), null);
});

test('mindMapNodeDrawPlan keeps ten-thousand node panoramas complete', () => {
  const manyNodes = Array.from({ length: 10000 }, (_, index) => ({
    id: index + 1,
    x: (index % 100) * 240,
    y: Math.floor(index / 100) * 130,
    width: 220,
    height: 92,
    cardHeight: 72,
    address: `1-${index + 1}`,
    text: `Node ${index + 1}`
  }));

  const plan = mindMapNodeDrawPlan({ nodes: manyNodes, scale: 0.05 });
  const index = createMindMapHitIndex(manyNodes, { cellSize: 320 });

  assert.equal(plan.nodes.length, 10000);
  assert.equal(plan.nodes.every((node) => node.drawText === false), true);
  assert.equal(hitTestMindMapNode(index, { x: 240 * 42 + 10, y: 130 * 17 + 10 })?.id, 1743);
});

test('applyMindMapResizePreview resizes the live node and reconnects its edges', () => {
  const mindmap = {
    nodes: [
      { id: 1, x: 0, y: 0, width: 220, height: 90, cardHeight: 72, noteHeight: 18, noteY: 72, address: '1', text: 'Root' },
      { id: 2, x: 280, y: 20, width: 220, height: 72, cardHeight: 72, address: '1-1', text: 'Child' }
    ],
    edges: [
      { fromId: 1, toId: 2, fromX: 220, fromY: 36, toX: 280, toY: 56 }
    ],
    width: 600,
    height: 400
  };

  const resized = applyMindMapResizePreview(mindmap, {
    active: true,
    nodeId: 1,
    width: 340,
    cardHeight: 913
  });

  assert.notEqual(resized, mindmap);
  const root = resized.nodes.find((node) => node.id === 1);
  const child = resized.nodes.find((node) => node.id === 2);
  assert.equal(root.width, 340);
  assert.equal(root.cardHeight, 913);
  assert.equal(root.noteY, 913);
  assert.equal(root.height, 931);
  assert.equal(child.width, 220);
  assert.equal(child.x, 400);
  assert.deepEqual(resized.edges[0], {
    fromId: 1,
    toId: 2,
    fromX: 340,
    fromY: 456.5,
    toX: 400,
    toY: 56
  });
});

test('applyMindMapSizeOverrides keeps committed size overrides after resize ends', () => {
  const mindmap = {
    nodes: [
      { id: 1, x: 0, y: 0, width: 220, height: 72, cardHeight: 72, address: '1', text: 'Root' }
    ],
    edges: [],
    width: 600,
    height: 400
  };

  const resized = applyMindMapSizeOverrides(mindmap, new Map([[1, { width: 416, cardHeight: 780 }]]));

  assert.equal(resized.nodes[0].width, 416);
  assert.equal(resized.nodes[0].cardHeight, 780);
  assert.equal(resized.nodes[0].height, 780);
  assert.equal(resized.width, 600);
  assert.equal(resized.height, 780);
});

test('fitCanvasTextScale shrinks text to fit all rendered lines', () => {
  assert.equal(fitCanvasTextScale({ lineCount: 4, lineHeight: 16, availableHeight: 96 }), 1);
  assert.equal(fitCanvasTextScale({ lineCount: 20, lineHeight: 16, availableHeight: 160 }), 0.5);
  assert.equal(fitCanvasTextScale({ lineCount: 200, lineHeight: 16, availableHeight: 160, minScale: 0.02 }), 0.05);
});
