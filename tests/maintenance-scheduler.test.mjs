import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import { createMaintenanceScheduler } from '../dist/src/backend/store/maintenance-scheduler.js';

// 维护结果落日志（NOW.md「维护结果无人看」）：runMaintenance 完成后把
// { reason, cleared, durationMs, results } 交给注入的 log（默认 stderr →
// 共享后端进程即 backend-shared.log）。

test('runMaintenance 完成后把结果交给注入的 log', async () => {
  const entries = [];
  let clock = 1000;
  const scheduler = createMaintenanceScheduler({
    now: () => (clock += 10),
    log: (entry) => entries.push(entry)
  });
  scheduler.register('store', () => ({ ok: true, vacuum: { skipped: 'freelist 0/1' } }));
  scheduler.markDirty(5);
  const result = await scheduler.runMaintenance('manual');

  assert.equal(result.ok, true);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reason, 'manual');
  assert.equal(entries[0].cleared, 5);
  assert.equal(typeof entries[0].durationMs, 'number');
  assert.deepEqual(entries[0].results, { store: { ok: true, vacuum: { skipped: 'freelist 0/1' } } });
});

test('handler 抛错不致命：错误进 results 并照常落日志', async () => {
  const entries = [];
  const scheduler = createMaintenanceScheduler({ log: (entry) => entries.push(entry) });
  scheduler.register('bad', () => { throw new Error('boom'); });
  scheduler.register('good', () => ({ ok: true }));
  const result = await scheduler.runMaintenance('tick');

  assert.equal(result.ok, true);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].results, {
    bad: { ok: false, error: 'boom' },
    good: { ok: true }
  });
});

test('log 自身抛错不影响维护返回', async () => {
  const scheduler = createMaintenanceScheduler({ log: () => { throw new Error('log-broken'); } });
  scheduler.register('store', () => ({ ok: true }));
  const result = await scheduler.runMaintenance('manual');
  assert.equal(result.ok, true);
});
