import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMindMap } from '../src/core/mindmap.mjs';
import { buildTree } from '../src/core/tree.mjs';

test('buildMindMap positions root at depth 1', () => {
  const tree = buildTree([
    { id: 1, doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text: '根' }
  ]);
  const { nodes, edges, width, height } = buildMindMap({ tree, depthLimit: 3 });

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].depth, 1);
  assert.equal(nodes[0].address, '1');
  assert.equal(edges.length, 0);
  assert.ok(width > 200);
  assert.ok(height > 200);
});

test('buildMindMap places children one column to the right', () => {
  const tree = buildTree([
    { id: 1, doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text: '根' },
    { id: 2, doc_id: 1, parent_id: 1, sort_order: 1, node_type: 'IF', text: '如果' },
    { id: 3, doc_id: 1, parent_id: 1, sort_order: 2, node_type: 'ELSE', text: '否则' }
  ]);
  const { nodes, edges } = buildMindMap({ tree, depthLimit: 3 });

  assert.equal(nodes.length, 3);
  const root = nodes.find((n) => n.address === '1');
  const child1 = nodes.find((n) => n.address === '1-1');
  const child2 = nodes.find((n) => n.address === '1-2');

  assert.equal(root.depth, 1);
  assert.equal(child1.depth, 2);
  assert.equal(child2.depth, 2);

  // Children are to the right of root
  assert.ok(child1.x > root.x);
  assert.ok(child2.x > root.x);
  assert.equal(child1.x, child2.x, 'same depth = same x column');

  // Edges from root to children
  assert.equal(edges.length, 2);
  assert.ok(edges.find((e) => e.fromId === root.id && e.toId === child1.id));
  assert.ok(edges.find((e) => e.fromId === root.id && e.toId === child2.id));
});

test('buildMindMap respects depth limit', () => {
  const rows = [
    { id: 1, doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text: '根' },
    { id: 2, doc_id: 1, parent_id: 1, sort_order: 1, node_type: 'TEXT', text: 'A' },
    { id: 3, doc_id: 1, parent_id: 2, sort_order: 1, node_type: 'TEXT', text: 'B' },
    { id: 4, doc_id: 1, parent_id: 3, sort_order: 1, node_type: 'TEXT', text: 'C' }
  ];
  const tree = buildTree(rows);

  // depthLimit = 2: only root (depth 1) and A (depth 2)
  const limited = buildMindMap({ tree, depthLimit: 2 });
  assert.equal(limited.nodes.length, 2);
  const addresses2 = limited.nodes.map((n) => n.address);
  assert.ok(addresses2.includes('1'));
  assert.ok(addresses2.includes('1-1'));
  assert.ok(!addresses2.includes('1-1-1'));

  // depthLimit = 4: chain merges nodes at 1-1 and 1-1-1 into chain head 1
  const full = buildMindMap({ tree, depthLimit: 4 });
  assert.equal(full.nodes.length, 2, 'chain merges intermediate TEXT nodes');
  const root = full.nodes.find((n) => n.address === '1');
  assert.ok(root, 'root (chain head) visible');
  assert.ok(root.text.includes('A') && root.text.includes('B'), 'chain text merged into root');
  // The last node in chain (1-1-1-1) is still visible with its own text
  const lastNode = full.nodes.find((n) => n.address === '1-1-1-1');
  assert.ok(lastNode, 'last chain node visible as separate node');
  assert.ok(lastNode.text.includes('C'));
});

test('buildMindMap can preserve text chains as separate nodes for structural editing', () => {
  const tree = buildTree([
    { id: 1, doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text: '根' },
    { id: 2, doc_id: 1, parent_id: 1, sort_order: 1, node_type: 'TEXT', text: 'A' },
    { id: 3, doc_id: 1, parent_id: 2, sort_order: 1, node_type: 'TEXT', text: 'B' },
    { id: 4, doc_id: 1, parent_id: 3, sort_order: 1, node_type: 'TEXT', text: 'C' }
  ]);

  const { nodes, edges } = buildMindMap({ tree, depthLimit: 4, mergeTextChains: false });
  const addresses = nodes.map((node) => node.address);

  assert.deepEqual(addresses.sort(), ['1', '1-1', '1-1-1', '1-1-1-1']);
  assert.equal(nodes.find((node) => node.address === '1-1').text, 'A');
  assert.ok(edges.find((edge) => edge.fromId === 2 && edge.toId === 3));
  assert.ok(edges.find((edge) => edge.fromId === 3 && edge.toId === 4));
});

test('buildMindMap lays out siblings using measured node hitboxes', () => {
  const tree = buildTree([
    { id: 1, doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text: '根' },
    { id: 2, doc_id: 1, parent_id: 1, sort_order: 1, node_type: 'IF', text: '带图片的节点' },
    { id: 3, doc_id: 1, parent_id: 1, sort_order: 2, node_type: 'IF', text: '后续节点' }
  ]);

  const { nodes } = buildMindMap({
    tree,
    depthLimit: 3,
    measuredHeights: new Map([[2, 260]])
  });
  const first = nodes.find((node) => node.id === 2);
  const second = nodes.find((node) => node.id === 3);

  assert.equal(first.height, 260);
  assert.ok(second.y >= first.y + first.height + 20);
});

test('buildMindMap reserves node notes below the card instead of inside it', () => {
  const tree = buildTree([
    {
      id: 1,
      doc_id: 1,
      parent_id: null,
      sort_order: 1,
      node_type: 'TEXT',
      text: '节点正文',
      node_note: '这是显示在节点下方的备注。'.repeat(8)
    }
  ]);

  const { nodes } = buildMindMap({
    tree,
    depthLimit: 1,
    measuredHeights: new Map([[1, 90]])
  });

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].cardHeight, 90);
  assert.ok(nodes[0].noteHeight > 0);
  assert.equal(nodes[0].noteY, nodes[0].cardHeight);
  assert.ok(nodes[0].height > nodes[0].cardHeight);
});

test('buildMindMap defaults to a fully expanded editing depth', () => {
  const tree = buildTree([
    { id: 1, doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text: '根' },
    { id: 2, doc_id: 1, parent_id: 1, sort_order: 1, node_type: 'IF', text: 'L2' },
    { id: 3, doc_id: 1, parent_id: 2, sort_order: 1, node_type: 'IF', text: 'L3' },
    { id: 4, doc_id: 1, parent_id: 3, sort_order: 1, node_type: 'IF', text: 'L4' }
  ]);

  const { nodes } = buildMindMap({ tree, mergeTextChains: false });

  assert.ok(nodes.find((node) => node.address === '1-1-1-1'));
});

test('buildMindMap respects collapsed state', () => {
  const tree = buildTree([
    { id: 1, doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text: '根' },
    { id: 2, doc_id: 1, parent_id: 1, sort_order: 1, node_type: 'TEXT', text: '可见' },
    { id: 3, doc_id: 1, parent_id: 2, sort_order: 1, node_type: 'TEXT', text: '隐藏' }
  ]);

  const collapsed = new Set([2]); // collapse node 2
  const { nodes, edges } = buildMindMap({ tree, collapsed, depthLimit: 3 });

  // Node 2 is visible (collapsed), but its children are hidden
  assert.equal(nodes.length, 2);
  assert.ok(nodes.find((n) => n.address === '1'));
  assert.ok(nodes.find((n) => n.address === '1-1'));

  // Node 2 should show hidden count
  const collapsedNode = nodes.find((n) => n.address === '1-1');
  assert.ok(collapsedNode.hiddenCount > 0);

  // No edges to hidden children
  assert.ok(!edges.find((e) => e.toId === 3));
});

test('buildMindMap depth = address segment count', () => {
  const tree = buildTree([
    { id: 1, doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text: '根' },
    { id: 2, doc_id: 1, parent_id: 1, sort_order: 1, node_type: 'TEXT', text: 'L2' },
    { id: 3, doc_id: 1, parent_id: 2, sort_order: 1, node_type: 'TEXT', text: 'L3' },
    { id: 4, doc_id: 1, parent_id: 3, sort_order: 1, node_type: 'TEXT', text: 'L4' }
  ]);

  const { nodes } = buildMindMap({ tree, depthLimit: 5 });

  for (const node of nodes) {
    const segs = node.address.split('-').length;
    assert.equal(node.depth, segs, `${node.address} depth = ${segs}`);
  }

  // Each depth level is in a distinct x-column
  const xsByDepth = new Map();
  for (const node of nodes) {
    if (!xsByDepth.has(node.depth)) xsByDepth.set(node.depth, node.x);
    assert.equal(xsByDepth.get(node.depth), node.x, `all nodes at depth ${node.depth} have same x`);
  }

  // Depths are monotonically increasing in x
  const depths = [...xsByDepth.keys()].sort((a, b) => a - b);
  for (let i = 1; i < depths.length; i++) {
    assert.ok(xsByDepth.get(depths[i]) > xsByDepth.get(depths[i - 1]),
      `depth ${depths[i]} is to the right of depth ${depths[i - 1]}`);
  }
});

test('buildMindMap sizes merged markdown height without double-counting line breaks', () => {
  const mergedText = [
    '如果调查员已经拿到酒吧线索。',
    '那么他会继续追问关键证人。',
    '否则他会回到案发现场复盘。',
    '此时需要保留明确的行动条件。'
  ].join('\n\n');
  const tree = buildTree([
    { id: 1, doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text: mergedText }
  ]);

  const { nodes } = buildMindMap({ tree, depthLimit: 3 });

  assert.equal(nodes.length, 1);
  assert.ok(nodes[0].height < 190, `height should be compact, got ${nodes[0].height}`);
});

test('buildMindMap ignores blank markdown lines when sizing canvas cards', () => {
  const text = [
    '于是，贝雯都，人数不知道一个节奏在何处。',
    '',
    '• 复杂度是否集中在某个高层节点没被继续切开。',
    '',
    '• 某个区域是不是分叉已经过密，不该继续停留在这一层。',
    '',
    '• 某个子树是不是过深，说明抽象层级已经失衡。'
  ].join('\n');
  const tree = buildTree([
    { id: 1, doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text }
  ]);

  const { nodes } = buildMindMap({ tree, depthLimit: 1 });

  assert.equal(nodes.length, 1);
  assert.ok(nodes[0].cardHeight < 190, `card should not reserve blank paragraphs beyond the one-line padding, got ${nodes[0].cardHeight}`);
});

test('buildMindMap default layout does not clip long canvas cards at 420px', () => {
  const text = Array.from({ length: 80 }, (_, index) => (
    `Long node line ${index + 1}: this content should stay visible after automatic sizing.`
  )).join('\n');
  const tree = buildTree([
    { id: 1, doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text }
  ]);

  const { nodes } = buildMindMap({ tree, depthLimit: 1 });

  assert.equal(nodes.length, 1);
  assert.ok(nodes[0].cardHeight > 420, `long card should exceed old 420px cap, got ${nodes[0].cardHeight}`);
});

test('buildMindMap automatic card height keeps exactly one blank text line', () => {
  const text = ['Line 1', 'Line 2', 'Line 3', 'Line 4', 'Line 5', 'Line 6'].join('\n');
  const tree = buildTree([
    { id: 1, doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text }
  ]);

  const { nodes } = buildMindMap({ tree, depthLimit: 1 });

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].cardHeight, 140);
});

test('buildMindMap ignores blank note lines when sizing attached notes', () => {
  const note = [
    '通过观察树结构，可以判断复杂度是否集中。',
    '',
    '',
    '区域分叉是否过密，子树是否过深。'
  ].join('\n');
  const tree = buildTree([
    { id: 1, doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text: '正文', node_note: note }
  ]);

  const { nodes } = buildMindMap({ tree, depthLimit: 1 });
  const compactTree = buildTree([
    {
      id: 1,
      doc_id: 1,
      parent_id: null,
      sort_order: 1,
      node_type: 'TEXT',
      text: '姝ｆ枃',
      node_note: note.split('\n').filter((line) => line.trim()).join('\n')
    }
  ]);
  const compact = buildMindMap({ tree: compactTree, depthLimit: 1 });

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].noteHeight, compact.nodes[0].noteHeight);
});

test('buildMindMap applies equal-width node layout settings and per-node size overrides', () => {
  const tree = buildTree([
    {
      id: 1,
      doc_id: 1,
      parent_id: null,
      sort_order: 1,
      node_type: 'TEXT',
      text: 'Root',
      node_size_mode: 'manual',
      node_width: 360,
      node_height: 144
    },
    { id: 2, doc_id: 1, parent_id: 1, sort_order: 1, node_type: 'TEXT', text: 'Child' }
  ]);

  const { nodes, edges } = buildMindMap({
    tree,
    depthLimit: 2,
    nodeLayout: {
      mode: 'equalWidth',
      defaultWidth: 260,
      defaultHeight: 80,
      minWidth: 120,
      maxWidth: 520,
      minHeight: 48,
      maxHeight: 420
    }
  });

  const root = nodes.find((node) => node.id === 1);
  const child = nodes.find((node) => node.id === 2);

  assert.equal(root.width, 360);
  assert.equal(root.cardHeight, 144);
  assert.equal(child.width, 120);
  assert.equal(child.cardHeight, 60);
  assert.equal(edges[0].fromX, root.x + root.width);
  assert.equal(edges[0].fromY, root.y + root.cardHeight / 2);
});

test('buildMindMap shrinks golden-ratio auto cards to content height', () => {
  const tree = buildTree([
    { id: 1, doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text: 'Short' }
  ]);

  const { nodes } = buildMindMap({
    tree,
    depthLimit: 1,
    nodeLayout: {
      mode: 'goldenRatio',
      defaultWidth: 200,
      defaultHeight: 72,
      minWidth: 120,
      maxWidth: 520,
      minHeight: 48,
      maxHeight: 420
    }
  });

  assert.equal(nodes[0].width, 120);
  assert.equal(nodes[0].cardHeight, 60);
});

test('buildMindMap returns the structural root before leaves and axiom cards', () => {
  const tree = buildTree([
    { id: 1, doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text: 'Root' },
    { id: 2, doc_id: 1, parent_id: 1, sort_order: 1, node_type: 'TEXT', text: 'Left' },
    { id: 3, doc_id: 1, parent_id: 1, sort_order: 2, node_type: 'TEXT', text: 'Right' },
    { id: 4, doc_id: 1, parent_id: 2, sort_order: 1, node_type: 'TEXT', text: 'Leaf' }
  ]);

  const { nodes } = buildMindMap({
    tree,
    depthLimit: 3,
    mergeTextChains: false,
    axioms: [{ id: 1, label: 'A1', content: 'Axiom' }]
  });

  assert.equal(nodes[0].id, 1);
  assert.equal(nodes[0].address, '1');
  assert.deepEqual(nodes.filter((node) => node.kind !== 'axiom').map((node) => node.address), [
    '1',
    '1-1',
    '1-2',
    '1-1-1'
  ]);
  assert.equal(nodes.at(-1).kind, 'axiom');
});
