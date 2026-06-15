import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { IftreeStore } from '../src/backend/store.mjs';
import { runDatabaseWrite } from '../src/backend/mutation-api.mjs';
import { runDatabaseRead } from '../src/backend/query-api.mjs';
import { runDbShellArgv } from '../src/backend/db-shell.mjs';
import {
  listMemoryVolumes,
  markMemoryVolumeDistilled,
  memoryVolumeMetaOf,
  sealDueMemoryVolumes,
  VOLUME_SEAL_IDLE_MS,
  VOLUME_DISTILL_COOLDOWN_MS
} from '../src/backend/memory-volumes.mjs';

const HOUR_MS = 60 * 60 * 1000;

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-memory-'));
  const store = new IftreeStore(join(dir, 'store.sqlite'));
  try {
    store.init();
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function deliverPayload(extra = {}) {
  return {
    action: 'memory.deliverVolume',
    agent: 'claude-code',
    sessionId: 'sess-001',
    hostAnchor: 'C:/logs/sess-001.jsonl',
    nodes: [
      {
        text: '用户原话：先提交所有改动',
        node_title: '用户原话',
        trust_level: '不受控',
        children: [{ text: '任务结果：成功', trust_level: '不受控' }]
      }
    ],
    ...extra
  };
}

test('memory.deliverVolume 建卷：meta 元信息齐全、incremental、节点入库、状态 active', async () => {
  await withStore(async (store) => {
    const result = await runDatabaseWrite(store, deliverPayload(), {});
    assert.equal(result.ok, true);
    assert.equal(result.createdCount, 2);

    const docRow = store.db.prepare('SELECT meta, edit_mode FROM docs WHERE id = ?').get(result.docId);
    const volume = memoryVolumeMetaOf(docRow.meta);
    assert.equal(volume.agent, 'claude-code');
    assert.equal(volume.sessionId, 'sess-001');
    assert.equal(volume.hostAnchor, 'C:/logs/sess-001.jsonl');
    assert.ok(volume.startedAt);
    assert.equal(volume.sealedAt, null);
    assert.equal(docRow.edit_mode, 'incremental');

    const listed = listMemoryVolumes(store);
    assert.equal(listed.volumes.length, 1);
    assert.equal(listed.volumes[0].state, 'active');
    assert.ok(listed.volumes[0].lastActivityAt);
    assert.ok(listed.volumes[0].sealAt);
  });
});

test('memory.deliverVolume 拒绝受控节点且不留空卷；缺 agent/sessionId 拒绝', async () => {
  await withStore(async (store) => {
    await assert.rejects(
      runDatabaseWrite(store, deliverPayload({ nodes: [{ text: 'x', trust_level: '受控' }] }), {}),
      /不受控/
    );
    await assert.rejects(
      runDatabaseWrite(store, deliverPayload({ agent: '' }), {}),
      /agent 身份/
    );
    // 空库自带导航虚拟文档：拒绝路径不得多出任何文档，更不得留下空卷。
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM docs WHERE meta LIKE '%memoryVolume%'").get().c, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM docs').get().c, 1);
  });
});

test('卷上 stream.push 追加照常可用，但受控节点被拒', async () => {
  await withStore(async (store) => {
    const { docId } = await runDatabaseWrite(store, deliverPayload(), {});
    const pushed = store.pushStreamNodes({
      docId,
      nodes: [{ text: '迟到的补充', trust_level: '不受控' }]
    });
    assert.equal(pushed.createdCount, 1);
    assert.throws(
      () => store.pushStreamNodes({ docId, nodes: [{ text: 'bad', trust_level: '受控' }] }),
      /15-10-3/
    );
  });
});

test('封卷：到期才封、sealedAt=末次活动+24h、封后拒绝追加', async () => {
  await withStore(async (store) => {
    const { docId } = await runDatabaseWrite(store, deliverPayload(), {});
    const fresh = sealDueMemoryVolumes(store);
    assert.equal(fresh.sealedCount, 0);

    const future = Date.now() + 25 * HOUR_MS;
    const sealed = sealDueMemoryVolumes(store, { nowMs: future });
    assert.equal(sealed.sealedCount, 1);
    assert.equal(sealed.sealed[0].docId, docId);

    const docRow = store.db.prepare('SELECT meta, edit_mode FROM docs WHERE id = ?').get(docId);
    assert.equal(docRow.edit_mode, 'readonly');
    const volume = memoryVolumeMetaOf(docRow.meta);
    const lastNodeMs = store.db.prepare(
      "SELECT MAX(strftime('%s', created_at)) AS ts FROM nodes WHERE doc_id = ?"
    ).get(docId).ts * 1000;
    assert.equal(Date.parse(volume.sealedAt), lastNodeMs + VOLUME_SEAL_IDLE_MS);
    assert.ok(volume.endedAt);

    assert.throws(
      () => store.pushStreamNodes({ docId, nodes: [{ text: 'late', trust_level: '不受控' }] }),
      /增量编辑/
    );

    // 幂等：再扫不重复封。
    assert.equal(sealDueMemoryVolumes(store, { nowMs: future }).sealedCount, 0);
  });
});

test('提炼节律：冷却期拒绝、force 中途快照不封卷、过冷却期正常提炼并补物理封卷', async () => {
  await withStore(async (store) => {
    const { docId } = await runDatabaseWrite(store, deliverPayload(), {});

    // active：默认拒绝，force=中途快照、卷保持可追加。
    assert.throws(() => markMemoryVolumeDistilled(store, { docId }), /冷却期/);
    const snapshot = markMemoryVolumeDistilled(store, { docId, force: true });
    assert.equal(snapshot.snapshotOnly, true);
    assert.equal(store.getDocEditMode(docId), 'incremental');

    // 封卷后冷却中：仍拒绝。
    const cooling = Date.now() + (24 + 1) * HOUR_MS;
    assert.throws(() => markMemoryVolumeDistilled(store, { docId, nowMs: cooling }), /冷却期/);

    // 过了封卷+冷却（24h+24h）：可提炼，且物理封卷补落。
    const ready = Date.now() + VOLUME_SEAL_IDLE_MS + VOLUME_DISTILL_COOLDOWN_MS + HOUR_MS;
    const done = markMemoryVolumeDistilled(store, { docId, nowMs: ready });
    assert.equal(done.snapshotOnly, false);
    assert.equal(store.getDocEditMode(docId), 'readonly');

    const listed = listMemoryVolumes(store, { nowMs: ready });
    assert.equal(listed.volumes[0].state, 'distilled');

    // 终态幂等。
    const again = markMemoryVolumeDistilled(store, { docId, nowMs: ready });
    assert.equal(again.alreadyDistilled, true);
  });
});

test('状态推导：active → sealed → distillable 随时钟推进，per-卷独立', async () => {
  await withStore(async (store) => {
    const { docId } = await runDatabaseWrite(store, deliverPayload(), {});
    const base = Date.now();
    const stateAt = (nowMs) => listMemoryVolumes(store, { nowMs }).volumes.find((v) => v.docId === docId).state;
    assert.equal(stateAt(base), 'active');
    assert.equal(stateAt(base + 25 * HOUR_MS), 'sealed');
    assert.equal(stateAt(base + 49 * HOUR_MS), 'distillable');
  });
});

test('完整记忆永不删除：deleteDoc 拒绝记忆卷', async () => {
  await withStore(async (store) => {
    const { docId } = await runDatabaseWrite(store, deliverPayload(), {});
    assert.throws(() => store.deleteDoc(docId), /15-10/);
    const ordinary = store.createDoc({ title: '普通文档' });
    assert.equal(store.deleteDoc(ordinary.id), true);
  });
});

test('投递级幂等：同 idempotencyKey 不长出第二个卷', async () => {
  await withStore(async (store) => {
    const first = await runDatabaseWrite(store, deliverPayload({ idempotencyKey: 'k1' }), {});
    const second = await runDatabaseWrite(store, deliverPayload({ idempotencyKey: 'k1' }), {});
    assert.equal(second.deduped, true);
    assert.equal(second.docId, first.docId);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM docs WHERE meta LIKE '%memoryVolume%'").get().c, 1);
  });
});

test('memory.appendSessionTurn：找活跃卷追加、物理封卷后自动新建续卷', async () => {
  await withStore(async (store) => {
    const turn = (text) => ({
      action: 'memory.appendSessionTurn',
      agent: 'iftree-builtin',
      sessionId: '7',
      hostAnchor: 'agent.sqlite#session=7',
      nodes: [{ text, trust_level: '不受控' }]
    });
    const first = await runDatabaseWrite(store, turn('turn 1'), {});
    assert.equal(first.createdVolume, true);
    const second = await runDatabaseWrite(store, turn('turn 2'), {});
    assert.equal(second.createdVolume, false);
    assert.equal(second.docId, first.docId);

    sealDueMemoryVolumes(store, { nowMs: Date.now() + 25 * HOUR_MS });
    const third = await runDatabaseWrite(store, turn('turn 3（迟到）'), {});
    assert.equal(third.createdVolume, true);
    assert.notEqual(third.docId, first.docId);

    const volumes = listMemoryVolumes(store, { sessionId: '7' }).volumes;
    assert.equal(volumes.length, 2);
  });
});

test('volumeNodesFromTurnMessages：消息粒度局部展开、工具事件为子节点、一律不受控', async () => {
  const { volumeNodesFromTurnMessages } = await import('../src/backend/llm/agent-runtime.mjs');
  const nodes = volumeNodesFromTurnMessages([
    { role: 'user', mode: 'qa', content: '查一下第三章', createdAt: '2026-06-11T01:00:00Z' },
    {
      role: 'assistant',
      mode: 'qa',
      content: '第三章讲检索。',
      status: '完成',
      toolEvents: [{ name: 'database_read', status: 'done', argsPreview: '{"action":"content.getSubtree"}' }],
      createdAt: '2026-06-11T01:00:05Z'
    }
  ]);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].text, '查一下第三章');
  assert.equal(nodes[0].trust_level, '不受控');
  assert.equal(nodes[1].children.length, 1);
  assert.match(nodes[1].children[0].node_title, /database_read/);
  assert.equal(nodes[1].children[0].trust_level, '不受控');
});

test('检索命中附带时间元数据（15-12-6）：searchKeyword 命中行带 createdAt/updatedAt', async () => {
  await withStore(async (store) => {
    const { docId } = await runDatabaseWrite(store, deliverPayload(), {});
    const result = await runDatabaseRead(store, {
      action: 'content.searchKeyword',
      docId,
      terms: ['原话']
    }, {});
    assert.ok(result.rows.length >= 1);
    assert.ok(result.rows[0].node.createdAt, 'hit missing createdAt');
    assert.ok(result.rows[0].node.updatedAt, 'hit missing updatedAt');
  });
});

test('db 外壳 memory 动词端到端：deliver → list --state active → mark-distilled 冷却拒绝', async () => {
  await withStore(async (store) => {
    const database = {
      run: async ({ operation, payload }) => (operation === 'read'
        ? runDatabaseRead(store, payload, {})
        : runDatabaseWrite(store, payload, {}))
    };
    const delivered = await runDbShellArgv(database, [
      'memory', 'deliver',
      JSON.stringify({ agent: 'codex', sessionId: 's9', nodes: [{ text: '收尾日志', trust_level: '不受控' }] })
    ], {});
    const deliverResult = JSON.parse(delivered.text);
    assert.equal(deliverResult.ok, true);

    const listed = await runDbShellArgv(database, ['memory', 'list', '--state', 'active', '--agent', 'codex'], {});
    const listResult = JSON.parse(listed.text);
    assert.equal(listResult.volumes.length, 1);
    assert.equal(listResult.volumes[0].sessionId, 's9');

    await assert.rejects(
      runDbShellArgv(database, ['memory', 'mark-distilled', String(deliverResult.docId)], {}),
      /冷却期/
    );
  });
});

test('memory.listVolumes 经读 API 路由可达并带时间元数据', async () => {
  await withStore(async (store) => {
    await runDatabaseWrite(store, deliverPayload(), {});
    const result = await runDatabaseRead(store, { action: 'memory.listVolumes' }, {});
    assert.equal(result.kind, 'memory.listVolumes');
    assert.equal(result.volumes.length, 1);
    const row = result.volumes[0];
    for (const key of ['startedAt', 'lastActivityAt', 'sealAt', 'distillableAt', 'createdAt']) {
      assert.ok(row[key], `missing ${key}`);
    }
  });
});

test('listVolumes 默认只返回最新 5 卷，显式 limit 可取全量', async () => {
  await withStore(async (store) => {
    for (let i = 1; i <= 7; i += 1) {
      await runDatabaseWrite(store, deliverPayload({ sessionId: `s${i}` }), {});
    }
    const def = listMemoryVolumes(store);
    assert.equal(def.volumes.length, 5);
    // 建卷顺序 s1..s7，docs.id（UUIDv7）递增；默认按 id DESC 取最新 5 卷。
    assert.deepEqual(def.volumes.map((v) => v.sessionId), ['s7', 's6', 's5', 's4', 's3']);
    // 显式调大能拿回全量。
    assert.equal(listMemoryVolumes(store, { limit: 50 }).volumes.length, 7);
  });
});
