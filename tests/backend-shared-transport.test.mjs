import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  backendDescriptorPath,
  backendPipeName,
  readBackendDescriptor,
  removeBackendDescriptorIfOwn,
  resolveBackendDbPath,
  writeBackendDescriptor
} from '../dist/src/backend/llm/backend-discovery.js';
import { createSharedBackendServer, probeBackendPipe } from '../dist/src/backend/llm/backend-shared-server.js';
import { createPipeBackendClient } from '../dist/src/backend/llm/backend-pipe-client.js';

let pipeSeq = 0;
function testPipeName(dir) {
  pipeSeq += 1;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\iftree-test-${process.pid}-${pipeSeq}`
    : join(dir, `iftree-test-${pipeSeq}.sock`);
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
  }
  throw new Error('waitFor timeout');
}

test('发现派生：管道名按库路径确定且大小写不敏感，描述文件读写/按 pid 清理', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-discovery-'));
  try {
    const dbPath = join(dir, 'database', 'store.sqlite');
    assert.equal(resolveBackendDbPath(dir, {}), dbPath);
    assert.equal(resolveBackendDbPath(dir, { IFTREE_DB: dbPath }), dbPath);

    const pipeA = backendPipeName(dbPath);
    assert.equal(backendPipeName(dbPath.toUpperCase()), pipeA);
    assert.notEqual(backendPipeName(join(dir, 'other.sqlite')), pipeA);
    if (process.platform === 'win32') assert.match(pipeA, /^\\\\\.\\pipe\\iftree-backend-/);

    const descriptorPath = backendDescriptorPath(dbPath);
    writeBackendDescriptor(descriptorPath, { pipe: pipeA, pid: 1234, startedAt: 'x' });
    assert.equal(readBackendDescriptor(descriptorPath).pipe, pipeA);
    // 非本人 pid 不清；本人 pid 清掉。
    assert.equal(removeBackendDescriptorIfOwn(descriptorPath, 999), false);
    assert.equal(removeBackendDescriptorIfOwn(descriptorPath, 1234), true);
    assert.equal(readBackendDescriptor(descriptorPath), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('共享传输：双客户端撞 id 各自正确收响应与流事件（服务端按连接重写 envelope id）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-pipe-'));
  let server = null;
  const clients = [];
  try {
    const pipeName = testPipeName(dir);
    server = createSharedBackendServer({
      handleRequest: async (request) => {
        if (request.type === 'stream.me') {
          server.sendEvent({ id: request.id, type: 'agent.stream', event: { tag: request.tag } });
          return { ok: true, sawId: request.id, tag: request.tag };
        }
        return { echo: request.payload ?? null, sawId: request.id };
      }
    });
    await server.listen(pipeName);

    const a = createPipeBackendClient({ pipeName });
    const b = createPipeBackendClient({ pipeName });
    clients.push(a, b);

    const eventsA = [];
    const eventsB = [];
    // 两个客户端都用 id='1'：不重写必然串线。
    const [ra, rb] = await Promise.all([
      a.request('stream.me', { tag: 'A' }, { id: '1', onEvent: (event) => eventsA.push(event) }),
      b.request('stream.me', { tag: 'B' }, { id: '1', onEvent: (event) => eventsB.push(event) })
    ]);
    assert.equal(ra.tag, 'A');
    assert.equal(rb.tag, 'B');
    assert.notEqual(ra.sawId, rb.sawId);
    assert.match(ra.sawId, /^c\d+:1$/);
    assert.deepEqual(eventsA, [{ tag: 'A' }]);
    assert.deepEqual(eventsB, [{ tag: 'B' }]);
    assert.ok(a.pid === process.pid && b.pid === process.pid);
  } finally {
    for (const client of clients) client.close();
    server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('shutdown：响应先到再触发 onShutdown；自检探测让第二个服务端让位', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-pipe-'));
  let server = null;
  let client = null;
  try {
    const pipeName = testPipeName(dir);
    let shutdownCalled = false;
    let resolveShutdownFired = null;
    const shutdownFired = new Promise((resolveFired) => {
      resolveShutdownFired = resolveFired;
    });
    server = createSharedBackendServer({
      handleRequest: async (request) => ({ ok: true, type: request.type }),
      onShutdown: () => {
        shutdownCalled = true;
        server.close();
        resolveShutdownFired();
      }
    });
    await server.listen(pipeName);
    assert.equal(await probeBackendPipe(pipeName), true);

    // 同名第二个服务端：自检发现已有人在听 → IFTREE_BACKEND_EXISTS。
    const rival = createSharedBackendServer({ handleRequest: async () => ({}) });
    await assert.rejects(rival.listen(pipeName), (/** @type {any} */ error) => error.code === 'IFTREE_BACKEND_EXISTS');

    client = createPipeBackendClient({ pipeName });
    const result = await client.request('shutdown', {});
    assert.equal(result.ok, true);
    // 响应先冲刷再触发 onShutdown：客户端收到响应时回调可能尚未执行，等它真正落地。
    await shutdownFired;
    assert.equal(shutdownCalled, true);

    // 服务端已关：后续请求失败为连接层错误（上层据此重发现）。
    const dead = createPipeBackendClient({ pipeName });
    await assert.rejects(dead.request('ping', {}), (/** @type {any} */ error) => error.isConnectionError === true);
    dead.close();
  } finally {
    client?.close();
    server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('bulk 独占闸门：多客户端拒 begin；会话期他人写被拒读放行；独占者掉线自动恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-pipe-'));
  let server = null;
  const clients = [];
  try {
    const pipeName = testPipeName(dir);
    let resolveAutoEnd = null;
    const autoEndFired = new Promise((resolveFired) => {
      resolveAutoEnd = resolveFired;
    });
    server = createSharedBackendServer({
      handleRequest: async (request) => {
        if (request.payload?.action === 'stream.bulkEnd' && String(request.id).includes('auto-bulk-end')) {
          resolveAutoEnd();
        }
        return { ok: true };
      }
    });
    await server.listen(pipeName);

    const a = createPipeBackendClient({ pipeName });
    const b = createPipeBackendClient({ pipeName });
    clients.push(a, b);
    await a.ensureReady();
    await b.ensureReady();

    // 有其他客户端在线：begin 被拒（异步写 pragma 对共享连接是全局的，开启必须独占）。
    await assert.rejects(
      a.request('database.write', { payload: { action: 'stream.bulkBegin' } }),
      /独占/
    );

    b.close();
    await waitFor(() => server.connectionCount === 1);
    const begun = await a.request('database.write', { payload: { action: 'stream.bulkBegin' } });
    assert.equal(begun.ok, true);

    // 会话期间新客户端：写被拒、读放行、不能替开启方 end。
    const c = createPipeBackendClient({ pipeName });
    clients.push(c);
    await assert.rejects(
      c.request('database.write', { payload: { action: 'stream.push' } }),
      /批量导入进行中/
    );
    const read = await c.request('database.read', { payload: { action: 'doc.list' } });
    assert.equal(read.ok, true);
    await assert.rejects(
      c.request('database.write', { payload: { action: 'stream.bulkEnd' } }),
      /开启方/
    );

    // 独占者掉线：服务端自动补 bulkEnd 恢复安全设置，其他客户端的写解封。
    a.close();
    await autoEndFired;
    const resumed = await c.request('database.write', { payload: { action: 'stream.push' } });
    assert.equal(resumed.ok, true);
  } finally {
    for (const item of clients) item.close();
    server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// 双活竞态的根修复是 listen-first（先抢监听，被占才判活）；陈尸场景：posix 进程崩死
// 留下 socket 文件，bind 报 EADDRINUSE，探测无人应答即清掉重试。Windows 命名管道随进程
// 消失，无陈尸形态，跳过。
test('posix 陈尸清理：残留文件占住 socket 路径时 listen 清掉后成功', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-pipe-'));
  let server = null;
  try {
    const pipeName = testPipeName(dir);
    writeFileSync(pipeName, '');
    server = createSharedBackendServer({ handleRequest: async () => ({ ok: true }) });
    await server.listen(pipeName);
    assert.equal(await probeBackendPipe(pipeName), true);
  } finally {
    server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
