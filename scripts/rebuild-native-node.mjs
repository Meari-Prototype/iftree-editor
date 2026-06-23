#!/usr/bin/env node
// 把 better-sqlite3 构建成 node ABI——headless 后端 / docker / 桌面统一的构建路径。
// 前端去 native 后桌面 electron 不再 in-process 用 better-sqlite3，全仓库只剩 node 一套 ABI。projectneed `18` 解耦。
//
// 机制：npm rebuild 触发 better-sqlite3 的 install 脚本 `prebuild-install || node-gyp rebuild`，
// prebuild-install 下载匹配当前 node 的预编译版（无需 VS build tools）。@lancedb/lancedb 是
// N-API 预编译、node/electron 通用，不进 rebuild；onnxruntime-node 默认不装（HTTP 嵌入首选），
// 要本地嵌入兜底时 npm install 它即得 node ABI，同样不必特殊处理。
//
// headless 干净环境（容器/CI）里 `npm install` 默认就装 node ABI 预编译版、无需本脚本；本脚本是给
// 被 electron-rebuild 污染过的本机开发树「切回 node ABI」用的。
//
// 前置释放锁：Windows 下 better_sqlite3.node 被加载它的进程锁住时无法覆写。这里按
// backend-connection.json 记录的 pid 关停现役共享后端（electron 或 node host 都认）再 rebuild。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  backendDescriptorPath,
  readBackendDescriptor,
  removeBackendDescriptorIfOwn,
  resolveBackendDbPath
} from '../src/backend/llm/backend-discovery.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function releaseSharedBackend() {
  const descriptorPath = backendDescriptorPath(resolveBackendDbPath(PROJECT_ROOT));
  const descriptor = readBackendDescriptor(descriptorPath);
  const pid = Number(descriptor?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid);
    console.log(`[rebuild:node] 关停现役共享后端 pid=${pid}（释放 better_sqlite3.node 锁）`);
  } catch (error) {
    console.log(`[rebuild:node] 共享后端 pid=${pid} 已不在（${error.code || error.message}）`);
    removeBackendDescriptorIfOwn(descriptorPath, pid);
    return;
  }
  // 等进程真正退出、OS 回收 .node 句柄后再 rebuild（signal 0 抛 ESRCH 即进程没了）。
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { break; }
    await sleep(150);
  }
  removeBackendDescriptorIfOwn(descriptorPath, pid);
}

function rebuild() {
  return new Promise((resolveCode) => {
    // Windows: .cmd 须经 shell（直接 spawn 会 EINVAL）；整条命令走 command 串、args 留空，避免
    // DEP0190（shell + args 拼接告警）。linux/docker 正常 spawn npm、不用 shell。
    const isWin = process.platform === 'win32';
    const child = spawn(
      isWin ? 'npm.cmd rebuild better-sqlite3' : 'npm',
      isWin ? [] : ['rebuild', 'better-sqlite3'],
      { cwd: PROJECT_ROOT, stdio: 'inherit', windowsHide: true, shell: isWin }
    );
    child.on('exit', (code) => resolveCode(code ?? 1));
    child.on('error', (error) => {
      console.error(error?.message || error);
      resolveCode(1);
    });
  });
}

// 检测 better-sqlite3 是否已是匹配本 node 的 ABI：能 require + 开内存库即是。
// 省去每次 preapp 无谓重 rebuild——只有被 electron-rebuild 污染过、ABI 不匹配时才真 rebuild。
// （require 成功会加载 .node 锁住它，但此分支不 rebuild、进程退出即释放；require 失败说明 ABI
// 不匹配，.node 未加载、无锁，可安全 rebuild。）
function betterSqlite3IsNodeAbi() {
  try {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3');
    new Database(':memory:').close();
    return true;
  } catch {
    return false;
  }
}

// 关停现役共享后端总是做（重启应用应刷新后端状态、避免跑旧代码）；rebuild 仅在 ABI 不匹配时做。
await releaseSharedBackend();
if (betterSqlite3IsNodeAbi()) {
  console.log('[rebuild:node] better-sqlite3 已是 node ABI，跳过 rebuild（已关停后端、下次拉起即刷新）');
  process.exit(0);
}
const code = await rebuild();
process.exit(code);
