import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import { findSiblingInsertionTarget } from '../dist/src/core/drag-drop.js';

const nodes = [
  { id: 10, x: 40, y: 80, width: 220, height: 90 },
  { id: 11, x: 340, y: 120, width: 220, height: 90 },
  { id: 12, x: 340, y: 240, width: 220, height: 90 },
  { id: 13, x: 340, y: 360, width: 220, height: 90 }
];

const edges = [
  { fromId: 10, toId: 11 },
  { fromId: 10, toId: 12 },
  { fromId: 10, toId: 13 }
];

test('blank drop above an earlier sibling inserts before that sibling', () => {
  const result = findSiblingInsertionTarget({
    nodes,
    edges,
    sourceId: 12,
    point: { x: 450, y: 112 }
  });

  assert.deepEqual(result, { kind: 'before', targetNodeId: 11 });
});

test('blank drop below the last sibling inserts after the last sibling', () => {
  const result = findSiblingInsertionTarget({
    nodes,
    edges,
    sourceId: 11,
    point: { x: 450, y: 470 }
  });

  assert.deepEqual(result, { kind: 'after', targetNodeId: 13 });
});

test('blank drop outside the source column is ignored', () => {
  const result = findSiblingInsertionTarget({
    nodes,
    edges,
    sourceId: 12,
    point: { x: 900, y: 112 }
  });

  assert.equal(result, null);
});

