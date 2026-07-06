import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { createSharedBackendServer } from '../dist/src/backend/llm/backend-shared-server.js';
import { createPipeBackendClient } from '../dist/src/backend/llm/backend-pipe-client.js';
import { createDatabaseService } from '../dist/src/backend/database-service.js';

// database.read 绕全局串行队列（IMMEDIATE）+ host 侧独立只读连接：
// agent.run / 大写入占队时读不再被饿死，读走 WAL 快照隔离绝不见写事务中间态。

let pipeSeq = 0;
function testPipeName(dir) {
  pipeSeq += 1;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\iftree-readbypass-${process.pid}-${pipeSeq}`
    : join(dir, `iftree-readbypass-${pipeSeq}.sock`);
}

test('server 层：database.read 绕队列——写请求挂起时读先返回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-readbypass-'));
  let server = null;
  let client = null;
  try {
    let releaseWrite;
    const writeGate = new Promise((resolveGate) => { releaseWrite = resolveGate; });
    const order = [];
    server = createSharedBackendServer({
      handleRequest: async (request) => {
        if (request.type === 'database.write') {
          await writeGate; // 模拟占住队列的长写（agent.run 同理，都走队列）
          order.push('write');
          return { ok: true, kind: 'write' };
        }
        order.push(request.type);
        return { ok: true, kind: request.type };
      }
    });
    const pipeName = testPipeName(dir);
    await server.listen(pipeName);
    client = createPipeBackendClient({ pipeName });

    const writePromise = client.request('database.write', { payload: { action: 'x' } });
    const readResult = await client.request('database.read', { payload: { action: 'y' } });
    assert.equal(readResult.kind, 'database.read', '读绕行队列即时返回');
    assert.deepEqual(order, ['database.read'], '写仍挂着，读已完成');

    releaseWrite();
    await writePromise;
    assert.deepEqual(order, ['database.read', 'write'], '写在放行后完成');
  } finally {
    client?.close();
    server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('service 层：只读连接读结果与写连接一致、拒绝写、能看到后续提交', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-readsvc-'));
  let writeSvc = null;
  let readSvc = null;
  try {
    const dbPath = join(dir, 'store.sqlite');
    writeSvc = createDatabaseService({ dbPath });
    const store = writeSvc.getStore();
    const doc = store.createDoc({ title: 'R', rootText: '根' });
    const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'a' });

    readSvc = createDatabaseService({ dbPath, initOptions: { readonly: true } });

    // 读对拍：同一动词两个连接结果一致。
    const viaWrite = await writeSvc.read({ action: 'node.listChildren', docId: doc.id, parentId: doc.rootNodeId });
    const viaRead = await readSvc.read({ action: 'node.listChildren', docId: doc.id, parentId: doc.rootNodeId });
    assert.deepEqual(viaRead.rows.map((r) => r.id), viaWrite.rows.map((r) => r.id));

    // query_only fail-fast：混进只读连接的写当场报错，不会绕过队列偷写。
    assert.throws(
      () => readSvc.getStore().db.prepare('UPDATE nodes SET text = ? WHERE id = ?').run('偷写', a.id),
      /readonly|query_only|attempt to write/i
    );

    // WAL 可见性：写连接后续提交对只读连接立即可见。
    store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'b' });
    const after = await readSvc.read({ action: 'node.listChildren', docId: doc.id, parentId: doc.rootNodeId });
    assert.equal(after.rows.length, viaRead.rows.length + 1, '新提交对只读连接可见');

    // withReadSnapshot：只读连接上 BEGIN DEFERRED 不炸、结果正常。
    const snap = await readSvc.getStore().withReadSnapshot(() => (
      readSvc.read({ action: 'node.listChildren', docId: doc.id, parentId: doc.rootNodeId })
    ));
    assert.equal(snap.rows.length, after.rows.length);
  } finally {
    readSvc?.close();
    writeSvc?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
