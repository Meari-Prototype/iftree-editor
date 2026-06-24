import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import { diffTextSegments } from '../dist/src/core/text-diff.js';

// 片段级文本 diff：diff 对比视图的删除红遮罩/新增绿遮罩数据源。

function joinSide(segments, side) {
  const skip = side === 'left' ? 'ins' : 'del';
  return segments.filter((segment) => segment.type !== skip).map((segment) => segment.text).join('');
}

test('双侧重建不变式：equal+del 还原旧文本，equal+ins 还原新文本', () => {
  const cases = [
    ['批量写入按 doc 级删后追加。', '批量写入按 doc 级删后追加。embedding 生成优先使用外部加速服务。'],
    ['向量默认启用，走无头查询。', '向量默认禁用，改走渲染进程。'],
    ['abc', 'xyz'],
    ['', '新增整段'],
    ['整段删除', ''],
    ['中文与 English 混排 123', '中文与 English 混排 456']
  ];
  for (const [before, after] of cases) {
    const segments = diffTextSegments(before, after);
    assert.equal(joinSide(segments, 'left'), before);
    assert.equal(joinSide(segments, 'right'), after);
  }
});

test('中段修改：公共前后缀保持 equal，只有中间染色', () => {
  const segments = diffTextSegments('保存只押主数据落库，索引不阻塞。', '保存只押主数据写入，索引不阻塞。');
  assert.equal(segments[0].type, 'equal');
  assert.ok(segments[0].text.startsWith('保存只押主数据'));
  assert.equal(segments[segments.length - 1].type, 'equal');
  assert.ok(segments[segments.length - 1].text.endsWith('索引不阻塞。'));
  assert.ok(segments.some((segment) => segment.type === 'del' && segment.text.includes('落库')));
  assert.ok(segments.some((segment) => segment.type === 'ins' && segment.text.includes('写入')));
});

test('纯追加：只有 ins 片段，无 del', () => {
  const segments = diffTextSegments('前半句。', '前半句。后半句是新加的。');
  assert.deepEqual(segments.map((segment) => segment.type), ['equal', 'ins']);
  assert.equal(segments[1].text, '后半句是新加的。');
});

test('相同文本与空文本边界', () => {
  assert.deepEqual(diffTextSegments('同文', '同文'), [{ type: 'equal', text: '同文' }]);
  assert.deepEqual(diffTextSegments('', ''), []);
});

test('多处修改各自独立染色', () => {
  const segments = diffTextSegments('甲段旧词一，乙段旧词二。', '甲段新词一，乙段新词二。');
  const dels = segments.filter((segment) => segment.type === 'del');
  const inss = segments.filter((segment) => segment.type === 'ins');
  assert.equal(dels.length, 2);
  assert.equal(inss.length, 2);
  assert.ok(segments.some((segment) => segment.type === 'equal' && segment.text.includes('，乙段')));
});

test('编辑距离超限退化为整段 del+ins，双侧重建不变式仍成立', () => {
  const before = Array.from({ length: 2000 }, (_, i) => String.fromCharCode(0x4e00 + (i % 500))).join('');
  const after = Array.from({ length: 2000 }, (_, i) => String.fromCharCode(0x6e00 + (i % 500))).join('');
  const segments = diffTextSegments(before, after, { maxEditDistance: 100 });
  assert.deepEqual(segments.map((segment) => segment.type), ['del', 'ins']);
  assert.equal(joinSide(segments, 'left'), before);
  assert.equal(joinSide(segments, 'right'), after);
});
