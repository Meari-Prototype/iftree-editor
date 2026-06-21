import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { IftreeStore } from '../src/backend/store/index.mjs';
import { runDatabaseWrite } from '../src/backend/mutation-api.mjs';
import { runDatabaseRead } from '../src/backend/query-api.mjs';
import { runDbShellArgv } from '../src/backend/db-shell.mjs';
import {
  listMemoryVolumeAnchors,
  listMemoryVolumes,
  markMemoryVolumeDistilled,
  memoryVolumeMetaOf,
  sealDueMemoryVolumes,
  selectOrphanedMemoryVolumes,
  VOLUME_SEAL_IDLE_MS,
  VOLUME_DISTILL_COOLDOWN_MS
} from '../src/backend/memory/volumes.mjs';

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
    ...extra
  };
}

// 生产里 ctx.writeMemoryAnchor 由 headless-agent-host 提供：建 .memory 实体锚（symlink）并写 source 行（15-10-4）。
// 测试替身只写 source 行——让卷进入「已锚」态（deleteDoc 据此拒删，15-10），不碰文件系统；
// 建锚的「无锚即拒 / 抛错回滚」另有专测覆盖。
// ctx.writeMemoryAnchor / sessionVolumeNodes：生产里由 host 提供（建 .memory 锚 + 读 session 文件
// 规则解析成节点）；测试替身只写 source 行 + 给固定节点（deliverVolume 不再收 agent nodes，节点一律
// 来自解析路径）。第二参可覆盖解析节点，验全删重导。
function anchorCtx(store, nodes = null) {
  return {
    writeMemoryAnchor({ docId }) {
      store.setMemoryAnchorSource(docId, `.memory/test/${docId}.jsonl`);
    },
    sessionVolumeNodes() {
      return nodes || [
        { node_title: '用户 · ', node_note: '@ t', text: '用户原话：先提交所有改动', trust_level: '不受控' },
        { node_title: '助手 · 完成', node_note: '@ t', text: '任务结果：成功', trust_level: '不受控' }
      ];
    }
  };
}

test('memory.deliverVolume 建卷：meta 元信息齐全、incremental、节点入库、状态 active', async () => {
  await withStore(async (store) => {
    const result = await runDatabaseWrite(store, deliverPayload(), anchorCtx(store));
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

test('memory.deliverVolume：缺 sessionVolumeNodes 能力 / 缺 agent 拒绝，且不留空卷', async () => {
  await withStore(async (store) => {
    // 无 ctx.sessionVolumeNodes（拿不到解析节点）：建卷前即拒。
    await assert.rejects(runDatabaseWrite(store, deliverPayload(), {}), /session 导入|sessionVolumeNodes/);
    // 缺 agent：解析能力在、但身份不全，建卷时拒。
    await assert.rejects(
      runDatabaseWrite(store, deliverPayload({ agent: '' }), anchorCtx(store)),
      /agent 身份/
    );
    // 空库自带导航虚拟文档：拒绝路径不得多出任何文档，更不得留下空卷。
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM docs WHERE meta LIKE '%memoryVolume%'").get().c, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM docs').get().c, 1);
  });
});

test('建锚抛错回滚，不留残卷（15-10-4 非导航文档必有库内实体锚）', async () => {
  await withStore(async (store) => {
    // 建锚抛错：已建的卷回滚删除（未锚卷无 source 行、deleteDoc 放行），不留残卷。
    await assert.rejects(
      runDatabaseWrite(store, deliverPayload(), {
        sessionVolumeNodes: () => [{ node_title: '用户 · ', text: 'x', trust_level: '不受控' }],
        writeMemoryAnchor() { throw new Error('symlink 失败'); }
      }),
      /建锚失败|回滚/
    );
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM docs WHERE meta LIKE '%memoryVolume%'").get().c, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM docs').get().c, 1);
  });
});

test('卷上 stream.push 追加照常可用，但受控节点被拒', async () => {
  await withStore(async (store) => {
    const { docId } = await runDatabaseWrite(store, deliverPayload(), anchorCtx(store));
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
    const { docId } = await runDatabaseWrite(store, deliverPayload(), anchorCtx(store));
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
    const { docId } = await runDatabaseWrite(store, deliverPayload(), anchorCtx(store));

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
    const { docId } = await runDatabaseWrite(store, deliverPayload(), anchorCtx(store));
    const base = Date.now();
    const stateAt = (nowMs) => listMemoryVolumes(store, { nowMs }).volumes.find((v) => v.docId === docId).state;
    assert.equal(stateAt(base), 'active');
    assert.equal(stateAt(base + 25 * HOUR_MS), 'sealed');
    assert.equal(stateAt(base + 49 * HOUR_MS), 'distillable');
  });
});

test('完整记忆永不删除：deleteDoc 拒绝记忆卷', async () => {
  await withStore(async (store) => {
    const { docId } = await runDatabaseWrite(store, deliverPayload(), anchorCtx(store));
    assert.throws(() => store.deleteDoc(docId), /15-10/);
    const ordinary = store.createDoc({ title: '普通文档' });
    assert.equal(store.deleteDoc(ordinary.id), true);
  });
});

test('listMemoryVolumeAnchors：列出每卷及锚路径；无 source 行的脱锚卷也照样列出（LEFT JOIN，扫除可重入）', async () => {
  await withStore(async (store) => {
    const a = await runDatabaseWrite(store, deliverPayload({ sessionId: 'sess-A' }), anchorCtx(store));
    const b = await runDatabaseWrite(store, deliverPayload({ sessionId: 'sess-B' }), anchorCtx(store));

    const before = listMemoryVolumeAnchors(store);
    assert.equal(before.length, 2);
    const rowA = before.find((v) => v.docId === a.docId);
    assert.equal(rowA.anchorPath, `.memory/test/${a.docId}.jsonl`);
    assert.equal(rowA.sessionId, 'sess-A');

    // 「解锚后未及删卷」的中间态：source 行没了、卷还在。LEFT JOIN 不能漏它，否则永远清不掉。
    store.db.prepare('DELETE FROM source_documents WHERE doc_id = ?').run(b.docId);
    const after = listMemoryVolumeAnchors(store);
    assert.equal(after.length, 2);
    assert.equal(after.find((v) => v.docId === b.docId).anchorPath, null);
  });
});

test('selectOrphanedMemoryVolumes：锚被删 / 无 source 行→清；锚还在（含悬空 symlink、占位文件）→留', () => {
  const volumes = [
    { docId: 1, anchorPath: '.memory/alive.jsonl' },   // 锚文件路径本身还在（含悬空 symlink、占位文件）
    { docId: 2, anchorPath: '.memory/deleted.jsonl' }, // 人工删掉了锚文件
    { docId: 3, anchorPath: null }                     // 无 source 行（解锚中间态）
  ];
  const alivePaths = new Set(['.memory/alive.jsonl']);
  const orphaned = selectOrphanedMemoryVolumes(volumes, (path) => alivePaths.has(path));
  assert.deepEqual(orphaned.map((volume) => volume.docId), [2, 3]);
});

test('校验扫除删除序列：解锚（删 source 行）后 deleteDoc 守卫放行、卷连带删除', async () => {
  await withStore(async (store) => {
    const { docId } = await runDatabaseWrite(store, deliverPayload(), anchorCtx(store));
    // 锚还在：守卫拒删（15-10）。
    assert.throws(() => store.deleteDoc(docId), /15-10/);
    // 扫除第一步——解锚（对应人工删掉 .memory 锚文件后、扫除清掉 source 行）。
    store.db.prepare('DELETE FROM source_documents WHERE doc_id = ?').run(docId);
    // 第二步：此时无 source 行，守卫放行，卷连带 nodes/refs 一并消失。
    assert.equal(store.deleteDoc(docId), true);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM docs WHERE meta LIKE '%memoryVolume%'").get().c, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE doc_id = ?').get(docId).c, 0);
  });
});

test('投递级幂等：同 idempotencyKey 不长出第二个卷', async () => {
  await withStore(async (store) => {
    const first = await runDatabaseWrite(store, deliverPayload({ idempotencyKey: 'k1' }), anchorCtx(store));
    const second = await runDatabaseWrite(store, deliverPayload({ idempotencyKey: 'k1' }), anchorCtx(store));
    assert.equal(second.deduped, true);
    assert.equal(second.docId, first.docId);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM docs WHERE meta LIKE '%memoryVolume%'").get().c, 1);
  });
});

test('一 session 一卷：同 session 重投 = 全删旧卷 + 完整重导（仍只一个卷、docId 换新）', async () => {
  await withStore(async (store) => {
    const first = await runDatabaseWrite(store, deliverPayload(), anchorCtx(store));
    // 重投（无 idempotencyKey 绕开请求级防抖缓存）：旧卷全删、完整重导。
    const second = await runDatabaseWrite(
      store,
      deliverPayload(),
      anchorCtx(store, [{ node_title: '用户 · ', text: '重导后的内容', trust_level: '不受控' }])
    );
    // 旧卷删除、新卷接管：只有一个卷，docId 换了、回执报 overwrote、旧 docId 不存在。
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM docs WHERE meta LIKE '%memoryVolume%'").get().c, 1);
    assert.notEqual(second.docId, first.docId);
    assert.equal(second.overwrote, first.docId);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM docs WHERE id = ?').get(first.docId).c, 0);
    const texts = store.db.prepare('SELECT text FROM nodes WHERE doc_id = ?').all(second.docId).map((r) => r.text);
    assert.ok(texts.includes('重导后的内容'));
  });
});

test('封卷不挡重导：封卷后同 session 重投仍全删重导（session 文件停增长才天然终态）', async () => {
  await withStore(async (store) => {
    const first = await runDatabaseWrite(store, deliverPayload(), anchorCtx(store));
    sealDueMemoryVolumes(store, { nowMs: Date.now() + 25 * HOUR_MS });
    // 封卷（readonly）不再特判拒绝：重导照样删旧建新（全删+新建无条件）。
    const second = await runDatabaseWrite(store, deliverPayload(), anchorCtx(store));
    assert.notEqual(second.docId, first.docId);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM docs WHERE id = ?').get(first.docId).c, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM docs WHERE meta LIKE '%memoryVolume%'").get().c, 1);
  });
});

test('不空卷直接造：session 文件不可解析则投递前拒、不建卷', async () => {
  await withStore(async (store) => {
    const ctx = {
      ...anchorCtx(store),
      sessionVolumeNodes() { throw new Error('session 文件不存在、无法导入'); }
    };
    await assert.rejects(
      runDatabaseWrite(store, deliverPayload({ sessionId: 'no-file' }), ctx),
      /session 文件/
    );
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM docs WHERE meta LIKE '%memoryVolume%'").get().c, 0);
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
    const first = await runDatabaseWrite(store, turn('turn 1'), anchorCtx(store));
    assert.equal(first.createdVolume, true);
    const second = await runDatabaseWrite(store, turn('turn 2'), anchorCtx(store));
    assert.equal(second.createdVolume, false);
    assert.equal(second.docId, first.docId);

    sealDueMemoryVolumes(store, { nowMs: Date.now() + 25 * HOUR_MS });
    const third = await runDatabaseWrite(store, turn('turn 3（迟到）'), anchorCtx(store));
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
      toolEvents: [{ name: 'admin_override', status: 'done', argsPreview: '{"action":"content.getSubtree"}' }],
      createdAt: '2026-06-11T01:00:05Z'
    }
  ]);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].text, '查一下第三章');
  assert.equal(nodes[0].trust_level, '不受控');
  assert.equal(nodes[1].children.length, 1);
  assert.match(nodes[1].children[0].node_title, /admin_override/);
  assert.equal(nodes[1].children[0].trust_level, '不受控');
});

test('检索命中附带时间元数据（15-12-6）：searchKeyword 命中行带 createdAt/updatedAt', async () => {
  await withStore(async (store) => {
    const { docId } = await runDatabaseWrite(store, deliverPayload(), anchorCtx(store));
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

test('db 外壳 memory 动词端到端：deliver → list --state active → distill 冷却拒绝', async () => {
  await withStore(async (store) => {
    const database = {
      run: async ({ operation, payload }) => (operation === 'read'
        ? runDatabaseRead(store, payload, {})
        : runDatabaseWrite(store, payload, anchorCtx(store)))
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
      runDbShellArgv(database, ['memory', 'distill', String(deliverResult.docId)], {}),
      /冷却期/
    );
  });
});

test('memory.listVolumes 经读 API 路由可达并带时间元数据', async () => {
  await withStore(async (store) => {
    await runDatabaseWrite(store, deliverPayload(), anchorCtx(store));
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
      await runDatabaseWrite(store, deliverPayload({ sessionId: `s${i}` }), anchorCtx(store));
    }
    const def = listMemoryVolumes(store);
    assert.equal(def.volumes.length, 5);
    // 建卷顺序 s1..s7，docs.id（UUIDv7）递增；默认按 id DESC 取最新 5 卷。
    assert.deepEqual(def.volumes.map((v) => v.sessionId), ['s7', 's6', 's5', 's4', 's3']);
    // 显式调大能拿回全量。
    assert.equal(listMemoryVolumes(store, { limit: 50 }).volumes.length, 7);
  });
});

test('messagesFromClaudeTranscript：只取 user 原话 + assistant 文本/工具，过滤系统合成行与坏行', async () => {
  const { messagesFromClaudeTranscript } = await import('../src/core/session-transcript.mjs');
  const lines = [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'x' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '帮我审一下代码' }, timestamp: 't1' }),
    JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: '内心戏不进卷' },
      { type: 'text', text: '我来读文件' },
      { type: 'tool_use', name: 'Read', input: { file: 'a.mjs' } }
    ], stop_reason: 'tool_use' }, timestamp: 't2' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '…' }] }, timestamp: 't3' }),
    // CC 写成 string-content user 行的系统合成内容：按已知标签前缀过滤（斜杠命令展开 / 本地命令输出 /
    // system-reminder / task-notification）。
    JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-message>…</command-message>' }, timestamp: 't4' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' }, timestamp: 't5' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '<system-reminder>Message sent at …</system-reminder>' }, timestamp: 't6' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>x</task-id>\n</task-notification>' }, timestamp: 't7' }),
    // 事件级元标记过滤：isMeta（caveat、以及无标签的工具重试提示）、isCompactSummary（/compact·续接摘要）。
    JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat: The messages below…' }, timestamp: 't8' }),
    JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'Your tool call was malformed and could not be parsed. Please retry.' }, timestamp: 't9' }),
    JSON.stringify({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation…' }, timestamp: 't10' }),
    // 真实用户原话：即便以尖括号注释开头也保留（<!-- 不是系统标签，别误删）。
    JSON.stringify({ type: 'user', message: { role: 'user', content: '<!-- iftree:generated-note --> 这个标记你顺手消一下' }, timestamp: 't11' }),
    '坏行不是 json',
    ''
  ].join('\n');
  const messages = messagesFromClaudeTranscript(lines);
  // 保留 2 条用户原话（普通 + <!-- 注释开头）+ 1 条 assistant；queue-operation/attachment/纯 tool_result/
  // 各类系统合成行（标签前缀 / isMeta / isCompactSummary）/坏行/空行全过滤。
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.filter((m) => m.role === 'user').map((m) => m.content), [
    '帮我审一下代码',
    '<!-- iftree:generated-note --> 这个标记你顺手消一下'
  ]);
  const assistant = messages.find((m) => m.role === 'assistant');
  assert.equal(assistant.content, '我来读文件'); // thinking 不进卷
  assert.equal(assistant.toolEvents.length, 1);
  assert.match(assistant.toolEvents[0].name, /Read/);
});

test('isLegalEventVolumeLayout：. / .. / 含分隔符段判非法（堵锚目录逃逸），正常单段合法', async () => {
  const { isLegalEventVolumeLayout } = await import('../src/backend/memory/anchor-layout.mjs');
  // 正常租户 + 工作区：合法。
  assert.equal(isLegalEventVolumeLayout('claude-code', 'D--WorkSpace-IFTreeEditor'), true);
  // 占位段：非法（原有多租户隔离契约）。
  assert.equal(isLegalEventVolumeLayout('unknown-agent', 'ws'), false);
  assert.equal(isLegalEventVolumeLayout('agent', '_local'), false);
  assert.equal(isLegalEventVolumeLayout('', 'ws'), false);
  // . / ..：路径跳转，join 会规约、.. 能逃出 .memory —— 判非法（健壮性闸，本次新增）。
  assert.equal(isLegalEventVolumeLayout('..', 'ws'), false);
  assert.equal(isLegalEventVolumeLayout('agent', '..'), false);
  assert.equal(isLegalEventVolumeLayout('.', 'ws'), false);
  assert.equal(isLegalEventVolumeLayout('agent', '.'), false);
  // 残留路径分隔符（多段穿透）：判非法。
  assert.equal(isLegalEventVolumeLayout('a/b', 'ws'), false);
  assert.equal(isLegalEventVolumeLayout('agent', 'a\\b'), false);
});
