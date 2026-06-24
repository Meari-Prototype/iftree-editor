import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampCenterScrollTop,
  measureButtonTops,
  measureConnectorLines
} from '../dist/src/frontend/components/c2d-measure.js';

function element({ left = 0, top = 0, right = 0, bottom = 0, offsetTop = 0, offsetHeight = 0, scrollWidth = 0, clientHeight = 0, scrollHeight = 0 } = {}) {
  return {
    offsetTop,
    offsetHeight,
    scrollWidth,
    clientHeight,
    scrollHeight,
    getBoundingClientRect() {
      return {
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top
      };
    }
  };
}

test('clampCenterScrollTop pins oversized nodes to their top edge', () => {
  assert.equal(clampCenterScrollTop(120, 200, 1000), 120);
  assert.equal(clampCenterScrollTop(420, 200, 1000), 200);
  assert.equal(clampCenterScrollTop(-50, 200, 1000), 0);
  assert.equal(clampCenterScrollTop(900, 1200, 500), 500);
});

test('measureConnectorLines returns viewport-clipped connector paths', () => {
  const parent = { id: 'node-root', address: '1' };
  const childA = { id: 'node-a', address: '1-1' };
  const childB = { id: 'node-b', address: '1-2' };
  const columns = [
    { groups: [{ parent: null, blocks: [parent] }] },
    { groups: [{ parent, blocks: [childA, childB] }] }
  ];
  const colEls = new Map([
    [0, element({ left: 0, right: 220 })],
    [1, element({ left: 300, right: 520 })]
  ]);
  const cards = new Map([
    ['1', element({ top: 40, bottom: 120 })],
    ['1-1', element({ top: 20, bottom: 80 })],
    ['1-2', element({ top: 160, bottom: 220 })]
  ]);

  const measured = measureConnectorLines(
    element({ top: 0, scrollWidth: 640 }),
    element({ top: 0, bottom: 180, clientHeight: 180 }),
    colEls,
    cards,
    columns
  );

  assert.equal(measured.w, 640);
  assert.equal(measured.h, 180);
  assert.equal(measured.lines.length, 2);
  assert.match(measured.lines[0].d, /^M 220 40 C 260 40 260 20 300 20$/);
  assert.match(measured.lines[1].d, /^M 220 120 C 260 120 260 180 300 180$/);
});

test('measureButtonTops follows the visible center of expandable cards', () => {
  const block = { id: 'node-root', address: '1', childCount: 2 };
  const columns = [{ groups: [{ parent: null, blocks: [block] }] }];
  const colEls = new Map([[0, element({ top: 100, bottom: 300 })]]);
  const cards = new Map([[
    '1',
    element({ top: 80, bottom: 260, offsetHeight: 180 })
  ]]);

  const tops = measureButtonTops(columns, colEls, cards);

  assert.equal(tops.get('1'), 84);
});
