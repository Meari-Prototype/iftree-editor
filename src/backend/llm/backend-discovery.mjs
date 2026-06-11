// 共享后端的发现与连接描述（projectneed 18-6-1）。
// 描述文件放数据库同目录（一库一后端，键天然成立）：本地管道名 + 进程标识 + 启动时间。
// 管道名由数据库绝对路径确定性派生——描述文件丢失时双方仍能在同一名字会合。
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

// 与 headless-agent-host 的 dbPath() 同一套解析：IFTREE_DB 优先，否则 projectRoot/database/store.sqlite。
export function resolveBackendDbPath(projectRoot, env = process.env) {
  const fromEnv = String(env.IFTREE_DB || '').trim();
  return resolve(fromEnv || join(resolve(String(projectRoot || process.cwd())), 'database', 'store.sqlite'));
}

export function backendPipeName(dbPath) {
  // Windows 路径大小写不敏感：统一小写后哈希，避免同库派生出两个管道名。
  const hash = createHash('sha1').update(resolve(String(dbPath)).toLowerCase()).digest('hex').slice(0, 12);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\iftree-backend-${hash}`
    : join(dirname(resolve(String(dbPath))), `iftree-backend-${hash}.sock`);
}

export function backendDescriptorPath(dbPath) {
  return join(dirname(resolve(String(dbPath))), 'backend-connection.json');
}

export function backendLogPath(dbPath) {
  return join(dirname(resolve(String(dbPath))), 'backend-shared.log');
}

export function readBackendDescriptor(descriptorPath) {
  try {
    const parsed = JSON.parse(readFileSync(descriptorPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeBackendDescriptor(descriptorPath, info = {}) {
  mkdirSync(dirname(descriptorPath), { recursive: true });
  writeFileSync(descriptorPath, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
}

// 只清自己写的描述：被接管后旧进程退出时不得抹掉新后端的描述文件。
export function removeBackendDescriptorIfOwn(descriptorPath, pid) {
  const current = readBackendDescriptor(descriptorPath);
  if (!current || Number(current.pid) !== Number(pid)) return false;
  try {
    rmSync(descriptorPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

// 拉起共享后端：detached + unref，存活不系于拉起方；stderr 落日志文件供人工排查。
export function spawnSharedBackend({
  processPath = process.execPath,
  hostScriptPath = null,
  projectRoot = null,
  env = process.env,
  logPath = null
} = {}) {
  if (!hostScriptPath) throw new Error('spawnSharedBackend requires hostScriptPath');
  let logFd = null;
  if (logPath) {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      logFd = openSync(logPath, 'a');
    } catch {
      logFd = null;
    }
  }
  const child = spawn(processPath, [hostScriptPath, '--shared'], {
    cwd: projectRoot,
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
      IFTREE_HEADLESS_AGENT: '1'
    },
    detached: true,
    stdio: ['ignore', 'ignore', logFd ?? 'ignore'],
    windowsHide: true
  });
  child.unref();
  if (logFd !== null) {
    // fd 已由子进程持有，父进程侧关闭自己的句柄即可。
    try { closeSync(logFd); } catch { /* 已关闭 */ }
  }
  return child;
}
