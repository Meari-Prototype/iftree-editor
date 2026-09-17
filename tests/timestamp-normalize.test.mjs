import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeTimestampForCompare } from '../dist/src/backend/shared.js';

// 时间戳归一化（B1 修复）：created_at/updated_at 两格式混存——表默认 CURRENT_TIMESTAMP 产
// 'YYYY-MM-DD HH:MM:SS'（空格、无毫秒），restore/导入等 JS 写入路径产 ISO 'YYYY-MM-DDTHH:MM:SS.sssZ'。
// 直接字典序比较在异格式相遇时出错（' ' 0x20 < 'T' 0x54）。归一后字典序必须 = 时间序。

test('normalizeTimestampForCompare 归一 SQLite CURRENT_TIMESTAMP 空格格式', () => {
  assert.equal(normalizeTimestampForCompare('2026-08-22 03:00:00'), '2026-08-22T03:00:00.000Z');
});

test('normalizeTimestampForCompare 保留 ISO 毫秒格式', () => {
  assert.equal(normalizeTimestampForCompare('2026-08-22T03:00:00.500Z'), '2026-08-22T03:00:00.500Z');
});

test('normalizeTimestampForCompare 给无毫秒 ISO 补 .000', () => {
  assert.equal(normalizeTimestampForCompare('2026-08-22T03:00:00Z'), '2026-08-22T03:00:00.000Z');
});

test('normalizeTimestampForCompare 处理纯日期与垃圾输入', () => {
  assert.equal(normalizeTimestampForCompare('2026-08-22'), '2026-08-22T00:00:00.000Z');
  assert.equal(normalizeTimestampForCompare('not-a-date'), 'not-a-date');
  assert.equal(normalizeTimestampForCompare(''), '');
});

test('带时区偏移的输入原样返回（不静默把本地时刻错标 UTC）', () => {
  assert.equal(normalizeTimestampForCompare('2026-08-22T10:00:00+08:00'), '2026-08-22T10:00:00+08:00');
  assert.equal(normalizeTimestampForCompare('2026-08-22 10:00:00+08:00'), '2026-08-22 10:00:00+08:00');
});

test('归一后字典序 = 时间序：ISO 格式的 since 不再漏掉空格格式的同日更晚行（B1 回归）', () => {
  // 修复前：'2026-08-22 15:00:00' < '2026-08-22T10:00:00Z'（' ' < 'T'）→ 下午 3 点的行被 since=10:00 错误排除
  const row = normalizeTimestampForCompare('2026-08-22 15:00:00');
  const since = normalizeTimestampForCompare('2026-08-22T10:00:00Z');
  assert.ok(row > since, '空格格式 15:00 归一后必须大于 ISO 格式 10:00');
  // 反向：空格 since 下 ISO 行不被错误多收
  const isoRow = normalizeTimestampForCompare('2026-08-22T09:00:00.000Z');
  const spaceSince = normalizeTimestampForCompare('2026-08-22 10:00:00');
  assert.ok(isoRow < spaceSince, 'ISO 格式 09:00 归一后必须小于空格格式 10:00');
});
