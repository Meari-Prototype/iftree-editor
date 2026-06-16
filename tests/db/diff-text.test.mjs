import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { formatDiffText, diffShortRef, diffOneLine } from '../../src/backend/diff-text.mjs';

// formatDiffText 渲染纯函数，不碰 DB；但本项目统一用 electron 跑测试、禁用 node（见 ../_assert-electron.mjs）。
// 它此前内嵌在 scripts/mcp-server.mjs 里无法单测，导致下面这个回归长期无人发现：
// 跨 commit diff 走 computeSnapshotDiff 产出 field-diff 形态（无 kind，靠 node_id/field/old/new），
// 而旧渲染器只认 op-log 形态（kind/address/fields），整组 field-diff 被打成「· ? ?」。

test('field-diff 形态（跨 commit）渲染改/增/删，绝不出现占位问号', () => {
  const text = formatDiffText({
    from: { id: '019e9678-aaaa', summary: 'BASE' },
    to: { id: '019eca0c-bbbb', summary: 'HEAD' },
    entries: [
      { node_id: 'n-modify', field: 'text', old: 'old-text', new: 'new-text', address: '1-1-6-1-1' },
      { node_id: 'n-insert', field: '*', old: null, new: '新增节点正文', address: '1-1-9' },
      { node_id: 'n-delete', field: '*', old: '被删正文', new: null, address: '1-1-8' }
    ]
  });
  assert.match(text, /\[diff 019e9678 BASE → 019eca0c HEAD\]/);
  assert.match(text, /~ 1-1-6-1-1 改/);
  assert.match(text, /\[text\]/);
  assert.match(text, /- old-text/);
  assert.match(text, /\+ new-text/);
  assert.match(text, /\+ 1-1-9 增 新增节点正文/);
  assert.match(text, /- 1-1-8 删/);
  // 回归核心：修复前这里整组是「· ? ?」。任何残留问号都视为渲染丢字段。
  assert.doesNotMatch(text, /\?/);
});

test('field-diff 缺 address（后端未补到）退回短 node_id，仍不渲染成 ?', () => {
  const text = formatDiffText({
    entries: [{ node_id: '0123456789abcdef', field: 'node_title', old: 'A', new: 'B' }]
  });
  assert.match(text, /~ 01234567 改/);
  assert.match(text, /\[node_title\]/);
  assert.doesNotMatch(text, /\?/);
});

test('field-diff 形态：公理与引用变更有可读主语（公理:/引用:），不渲染成 ?', () => {
  const text = formatDiffText({
    entries: [
      { axiom_id: 'ax-1', label: '前提A', field: 'content', old: '旧内容', new: '新内容' },
      { axiom_id: 'ax-2', label: '前提B', field: '*', old: null, new: '新增公理内容' },
      { axiom_id: 'ax-3', label: '前提C', field: '*', old: '将删', new: null },
      { ref_id: 'r-1', ref_label: 'mention 1-2→1-5', field: '*', old: null, new: '' },
      { ref_id: 'r-2', ref_label: 'mention 1-3→1-9', field: '*', old: '', new: null }
    ]
  });
  assert.match(text, /~ 公理:前提A 改/);
  assert.match(text, /\[content\]/);
  assert.match(text, /- 旧内容/);
  assert.match(text, /\+ 新内容/);
  assert.match(text, /\+ 公理:前提B 增 新增公理内容/);
  assert.match(text, /- 公理:前提C 删/);
  assert.match(text, /\+ 引用:mention 1-2→1-5 增/);
  assert.match(text, /- 引用:mention 1-3→1-9 删/);
  assert.doesNotMatch(text, /\?/);
});

test('op-log 形态（node.update / 实体操作）抽模块后保持原渲染，不回归', () => {
  const update = formatDiffText({
    entries: [{ kind: 'node.update', address: '1-2', fields: [{ field: 'text', old: 'x', new: 'y' }] }]
  });
  assert.match(update, /~ 1-2 改/);
  assert.match(update, /\[text\]/);
  assert.match(update, /- x/);
  assert.match(update, /\+ y/);

  const entity = formatDiffText({
    entries: [{ kind: 'entity.link', target_ref: 'ent-7', status: 'active' }]
  });
  assert.match(entity, /· ent-7 entity\.link/);
});

test('空 entries 明示无节点级改动而非空白', () => {
  const text = formatDiffText({ to: { id: 'abc', summary: 'X' }, entries: [] });
  assert.match(text, /无节点级改动/);
});

test('非 entries 结构兜底原始 JSON，不抛错', () => {
  const text = formatDiffText({ weird: true });
  assert.match(text, /"weird": true/);
});

test('diffShortRef / diffOneLine 基本行为', () => {
  assert.equal(diffShortRef('0123456789'), '01234567');
  assert.equal(diffShortRef(''), '?');
  assert.equal(diffOneLine('a\n  b   c'), 'a b c');
  assert.equal(diffOneLine('x'.repeat(250)).endsWith('…'), true);
});
