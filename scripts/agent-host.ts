#!/usr/bin/env node
// @ts-nocheck
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHeadlessAgentHost } from '../src/backend/llm/headless-agent-host.js';
import { createSharedBackendServer } from '../src/backend/llm/backend-shared-server.js';
import {
  backendDescriptorPath,
  backendPipeName,
  removeBackendDescriptorIfOwn,
  resolveBackendDbPath,
  writeBackendDescriptor
} from '../src/backend/llm/backend-discovery.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHARED_MODE = process.argv.includes('--shared');

function writeJson(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorPayload(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || ''
  };
}

function fetchers() {
  return typeof fetch === 'function' ? [(target, init) => fetch(target, init)] : [];
}

async function main() {
  let host = null;
  let queue = Promise.resolve();
  let shuttingDown = false;
  let stdinClosed = false;
  const bufferedLines = [];
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  process.stdin.resume();

  function finishIfClosed() {
    if (!stdinClosed || shuttingDown || !host) return;
    queue = queue.finally(() => {
      host.close();
      process.exit(0);
    });
  }

  async function processRequest(request) {
    try {
      const result = await host.handleRequest(request);
      writeJson({ id: request.id, type: 'result', result });
      if (request.type === 'shutdown') {
        shuttingDown = true;
        rl.close();
        host.close();
        process.exit(0);
      }
    } catch (error) {
      writeJson({ id: request.id, type: 'error', error: errorPayload(error) });
    }
  }

  function handleLine(line) {
    const raw = String(line || '').trim();
    if (!raw || shuttingDown) return;
    if (!host) {
      bufferedLines.push(raw);
      return;
    }
    let request = null;
    try {
      request = JSON.parse(raw);
    } catch (error) {
      writeJson({ id: null, type: 'error', error: errorPayload(error) });
      return;
    }
    if (request.type === 'agent.cancel' || request.type === 'summary.cancelNode' || request.type === 'summary.generateNode') {
      processRequest(request);
      return;
    }
    queue = queue.then(() => processRequest(request));
    finishIfClosed();
  }

  rl.on('line', handleLine);

  rl.on('close', () => {
    stdinClosed = true;
    finishIfClosed();
  });

  host = createHeadlessAgentHost({
    projectRoot: PROJECT_ROOT,
    fetchers,
    sendEvent: (event) => writeJson(event)
  });
  writeJson({ id: null, type: 'ready', pid: process.pid });
  for (const line of bufferedLines.splice(0)) handleLine(line);
  finishIfClosed();
}

// 共享模式（projectneed 18-6-1）：监听本地管道服务多客户端，写连接描述文件；
// 存活不系于任何客户端（detached 拉起），退出只经 shutdown 请求或系统信号。
async function mainShared() {
  const dbPath = resolveBackendDbPath(PROJECT_ROOT);
  const pipeName = backendPipeName(dbPath);
  const descriptorPath = backendDescriptorPath(dbPath);
  let host = null;

  const exitCleanly = () => {
    removeBackendDescriptorIfOwn(descriptorPath, process.pid);
    try { host?.close(); } catch { /* 已关闭 */ }
    process.exit(0);
  };

  const server = createSharedBackendServer({
    handleRequest: (request) => host.handleRequest(request),
    onShutdown: () => {
      server.close();
      exitCleanly();
    }
  });
  host = createHeadlessAgentHost({
    projectRoot: PROJECT_ROOT,
    fetchers,
    sendEvent: (event) => server.sendEvent(event)
  });

  try {
    await server.listen(pipeName);
  } catch (error) {
    if (error?.code === 'IFTREE_BACKEND_EXISTS') {
      // 会合让位：已有共享后端在跑（双写实例同时启动只活一个）。stderr 是 detached
      // 模式下唯一落日志的通道，留一行痕迹供排查「为什么起过第二个后端」。
      process.stderr.write(`[agent-host] ${error.message}；本进程(pid=${process.pid})让位退出\n`);
      host.close();
      process.exit(0);
    }
    throw error;
  }
  writeBackendDescriptor(descriptorPath, {
    pipe: pipeName,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    projectRoot: PROJECT_ROOT,
    dbPath
  });
  writeJson({ id: null, type: 'ready', pid: process.pid, shared: true, pipe: pipeName });
  process.on('SIGINT', exitCleanly);
  process.on('SIGTERM', exitCleanly);
}

(SHARED_MODE ? mainShared() : main()).catch((error) => {
  // 错误双写：共享模式 detached 拉起时 stdout 被丢弃、只有 stderr 接进日志文件，
  // 不双写的话致命错误会无声消失。
  process.stderr.write(`[agent-host] fatal: ${error?.stack || error?.message || error}\n`);
  writeJson({ id: null, type: 'error', error: errorPayload(error) });
  process.exit(1);
});
