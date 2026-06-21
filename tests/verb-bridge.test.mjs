import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { IftreeStore } from '../src/backend/store/index.mjs';
import { runDatabaseWrite } from '../src/backend/mutation-api.mjs';
import { registerWriteTools, registerAgentTools } from '../scripts/mcp-server.mjs';

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-verb-'));
  const store = new IftreeStore(join(dir, 'store.sqlite'));
  try {
    store.init();
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// --- 后端 mutation 路由 + 派生索引收尾：history.certify / history.revert 不被 editBranch stage 拦、
//     直达 handler；handler 只动主库，派生索引维护统一由写分发收尾调 maintainDerivedAfterWrite ---

test('runDatabaseWrite 路由 history.certify：改 trust + 收尾触发派生索引重建', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'C', rootText: '根' });
    const child = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '子' });
    const maintained = [];
    const ctx = { maintainDerivedAfterWrite: (docId, opts) => maintained.push([String(docId), opts || {}]) };

    await runDatabaseWrite(store, { action: 'history.certify', docId: doc.id, nodeId: child.id, scope: 'node', trust: '受控', owner: 'human' }, ctx);

    assert.equal(store.db.prepare('SELECT trust_level FROM nodes WHERE id = ?').get(child.id).trust_level, '受控');
    assert.deepEqual(maintained, [[String(doc.id), {}]], '收尾对该文档触发一次派生索引重建');
  });
});

test('runDatabaseWrite 路由 history.revert：撤改 + 收尾触发派生索引重建', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'R', rootText: '根' });
    const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'A原文' });
    store.saveHistorySnapshot({ docId: doc.id, summary: 'c1', owner: 'human' });
    store.updateNode(a.id, { text: 'A改后' });
    const c2 = store.saveHistorySnapshot({ docId: doc.id, summary: 'c2', owner: 'human' });

    const maintained = [];
    const ctx = { maintainDerivedAfterWrite: (docId, opts) => maintained.push([String(docId), opts || {}]) };

    await runDatabaseWrite(store, { action: 'history.revert', commitId: c2.commit_id, owner: 'human' }, ctx);

    assert.equal(store.db.prepare('SELECT text FROM nodes WHERE id = ?').get(a.id).text, 'A原文');
    assert.deepEqual(maintained, [[String(doc.id), {}]], '收尾对该文档触发一次派生索引重建（向量零耦合、不在此 embed）');
  });
});

// --- MCP 工具桥接：按档位注册 + 参数→payload 转换（薄壳层）---

function mockServer() {
  const tools = new Map();
  return { tools, registerTool(name, schema, handler) { tools.set(name, { schema, handler }); } };
}
function mockClient() {
  const calls = [];
  // 统一 SDK 接口（解耦第 10 步）：mcp-server 的 handler 调语义方法（databaseWrite / runAgent…）而非
  // request(type, body)；mock 按方法名记录 { method, payload } 供断言核对入口的参数→payload 转换。
  const record = (method) => async (payload, opts) => {
    calls.push({ method, payload, opts });
    return { ok: true, applied: true, changed: true };
  };
  return {
    calls,
    databaseRead: record('databaseRead'),
    databaseWrite: record('databaseWrite'),
    databaseRun: record('databaseRun'),
    dbShell: record('dbShell'),
    runAgent: record('runAgent'),
    importLibraryDocument: record('importLibraryDocument'),
    deleteImportedDocument: record('deleteImportedDocument'),
    ensureDocVectors: record('ensureDocVectors'),
    updateImportedSourcePaths: record('updateImportedSourcePaths')
  };
}

test('MCP 档位注册：certify 只 human、revert/web_search 在 full、edit_agent/admin_agent 按档', async () => {
  const human = mockServer();
  registerWriteTools(human, mockClient(), 'human');
  assert.ok(human.tools.has('certify'), 'human 注册 certify');
  assert.ok(human.tools.has('revert'));
  assert.ok(human.tools.has('web_search'));

  const full = mockServer();
  registerWriteTools(full, mockClient(), 'full');
  assert.ok(!full.tools.has('certify'), 'full 不注册 certify（human 专属背书）');
  assert.ok(full.tools.has('revert'));
  assert.ok(full.tools.has('web_search'));

  const edit = mockServer();
  registerWriteTools(edit, mockClient(), 'edit');
  assert.ok(edit.tools.has('edit'), 'edit 档有基础 edit 动词');
  assert.ok(!edit.tools.has('revert'), 'edit 档无 full 组动词');
  assert.ok(!edit.tools.has('web_search'));
  assert.ok(!edit.tools.has('certify'));

  // agent 委托三态按档
  const agentRead = mockServer();
  registerAgentTools(agentRead, mockClient(), 'read');
  assert.ok(agentRead.tools.has('ask_agent'));
  assert.ok(!agentRead.tools.has('edit_agent'), 'read 档只 ask_agent');
  assert.ok(!agentRead.tools.has('admin_agent'));

  const agentEdit = mockServer();
  registerAgentTools(agentEdit, mockClient(), 'edit');
  assert.ok(agentEdit.tools.has('edit_agent'));
  assert.ok(!agentEdit.tools.has('admin_agent'), 'edit 档无 admin_agent');

  const agentFull = mockServer();
  registerAgentTools(agentFull, mockClient(), 'full');
  assert.ok(agentFull.tools.has('admin_agent'), 'full 档有 admin_agent');
});

test('MCP payload 转换：certify→history.certify(owner=human)、revert→history.revert、admin_agent→agent.run(mode=full)', async () => {
  const client = mockClient();
  const srv = mockServer();
  registerWriteTools(srv, client, 'human');

  await srv.tools.get('certify').handler({ docId: 'd1', nodeId: 'n1', trust: '受控' });
  const certifyReq = client.calls.at(-1);
  assert.equal(certifyReq.method, 'databaseWrite');
  assert.equal(certifyReq.payload.action, 'history.certify');
  assert.equal(certifyReq.payload.owner, 'human', 'certify 恒以 human 身份写');
  assert.equal(certifyReq.payload.nodeId, 'n1');

  await srv.tools.get('revert').handler({ commitId: 'c1' });
  const revertReq = client.calls.at(-1);
  assert.equal(revertReq.method, 'databaseWrite');
  assert.equal(revertReq.payload.action, 'history.revert');
  assert.equal(revertReq.payload.commitId, 'c1');

  const aClient = mockClient();
  const aSrv = mockServer();
  registerAgentTools(aSrv, aClient, 'full');
  await aSrv.tools.get('admin_agent').handler({ prompt: 'hi' });
  const agentReq = aClient.calls.at(-1);
  assert.equal(agentReq.method, 'runAgent');
  assert.equal(agentReq.payload.mode, 'full', 'admin_agent 委托 full 能力');
});
