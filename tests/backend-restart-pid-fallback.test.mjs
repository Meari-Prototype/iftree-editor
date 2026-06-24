import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { createSharedBackendClient } from '../dist/src/backend/llm/backend-pipe-client.js';
import { createBackendClient } from '../dist/src/backend/llm/backend-client.js';
import { backendDescriptorPath, resolveBackendDbPath } from '../dist/src/backend/llm/backend-discovery.js';

// 回归：restart_backend 漏杀游离共享后端。
//
// client.pid 来自 ready 帧——本 mcp-server 进程还没 request 过后端时 channel 为 null、pid 为 null。
// restart_backend 旧实现 `const pid = client.pid` 据此误判「当前未启动」、什么都不杀；而真正在跑、
// 被别的客户端/GUI 续住的共享后端 pid 一直记在 backend-connection.json 里。漏杀后下次工具调用复用
// 旧进程跑旧代码，表现为「改了没生效」、且报错栈与改前一字不差，极易误判修复无效。
//
// 修复：新增 sharedBackendPid，未连接时回退描述文件 pid。本测试不连接、不拉后端，纯验 getter 取数。

async function withProjectRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'iftree-restart-pid-'));
  const env = { ...process.env };
  delete env.IFTREE_DB; // 隔离：描述文件锚 projectRoot/database，不受外部 IFTREE_DB 影响
  try {
    await fn(root, env);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeDescriptor(root, env, info) {
  const descriptorPath = backendDescriptorPath(resolveBackendDbPath(root, env));
  await mkdir(join(root, 'database'), { recursive: true });
  await writeFile(descriptorPath, JSON.stringify(info, null, 2), 'utf8');
  return descriptorPath;
}

test('sharedBackendPid：未连接时回退描述文件拿到游离后端 pid（client.pid 仍为 null）', async () => {
  await withProjectRoot(async (root, env) => {
    await writeDescriptor(root, env, { pid: 99999, pipe: '\\\\.\\pipe\\fake' });
    const client = createSharedBackendClient({ projectRoot: root, env });
    try {
      assert.equal(client.pid, null, '没 request 过：ready 帧 pid 为 null（旧实现据此漏杀）');
      assert.equal(client.sharedBackendPid, 99999, '回退描述文件，拿到在跑的共享后端 pid');
    } finally {
      client.close();
    }
  });
});

test('sharedBackendPid：描述文件缺失或 pid 非法时为 null（不去杀随机进程）', async () => {
  await withProjectRoot(async (root, env) => {
    const noFile = createSharedBackendClient({ projectRoot: root, env });
    try {
      assert.equal(noFile.sharedBackendPid, null, '无描述文件：null');
    } finally {
      noFile.close();
    }

    await writeDescriptor(root, env, { pipe: '\\\\.\\pipe\\fake' }); // 无 pid 字段
    const noPid = createSharedBackendClient({ projectRoot: root, env });
    try {
      assert.equal(noPid.sharedBackendPid, null, 'pid 缺失：null');
    } finally {
      noPid.close();
    }
  });
});

// 回归（本次新增）：mcp-server 实际走 backend-client SDK，不是直连 createSharedBackendClient。
// 底层 getter 修过了，但 SDK 包装层漏透传 sharedBackendPid，client.sharedBackendPid 取到 undefined、
// restart_backend 仍永远误判「当前未启动」漏杀。这一层必须有独立断言、不被底层测试覆盖所掩盖。
test('sharedBackendPid：backend-client SDK 层透传（mcp-server 走这层，漏透传则 restart 永远漏杀）', async () => {
  await withProjectRoot(async (root, env) => {
    await writeDescriptor(root, env, { pid: 88888, pipe: '\\\\.\\pipe\\fake' });
    const client = createBackendClient({ projectRoot: root, mode: 'shared', env });
    try {
      assert.equal(client.sharedBackendPid, 88888, 'SDK 透传 transport.sharedBackendPid（未连接回退描述文件 pid）');
    } finally {
      client.close();
    }
  });
});
