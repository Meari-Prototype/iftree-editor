// 共享后端的发现与连接描述（projectneed 18-6-1）。
// 描述文件放数据库同目录（一库一后端，键天然成立）：本地管道名 + 进程标识 + 启动时间。
// 管道名由数据库绝对路径确定性派生——描述文件丢失时双方仍能在同一名字会合。
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

// 与 headless-agent-host 的 dbPath() 同一套解析：IFTREE_DB 优先，否则 projectRoot/database/store.sqlite。
export function resolveBackendDbPath(projectRoot: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = String(env.IFTREE_DB || '').trim();
  return resolve(fromEnv || join(resolve(String(projectRoot || process.cwd())), 'database', 'store.sqlite'));
}

// 后端 host 必须跑 node runtime（路 B）：better-sqlite3 只编 node ABI，host 若继承 electron execPath 会变成
// electron-as-node（ABI 不同，加载 native 即崩）。任何拉起 host 的入口——electron 主进程、node 或 electron
// 启动的 mcp-server、私有 stdio 后端——都经此解析真 node，使 host 的 runtime 与「谁拉起它」彻底解耦。
// IFTREE_BACKEND_NODE 可选覆盖；否则在 PATH 找真 node；找不到报清晰错、绝不静默回退 electron。
export function resolveNodeExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.IFTREE_BACKEND_NODE || '').trim();
  if (explicit && existsSync(explicit)) return explicit;
  const exeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const pathSep = process.platform === 'win32' ? ';' : ':';
  for (const dir of String(env.PATH || '').split(pathSep)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const candidate = join(trimmed, exeName);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('未找到 node 可执行文件：headless 后端需 node runtime（把 node 加入 PATH，或设 IFTREE_BACKEND_NODE 指向 node 可执行）。');
}

export function backendPipeName(dbPath: unknown): string {
  // Windows 路径大小写不敏感：统一小写后哈希，避免同库派生出两个管道名。
  const hash = createHash('sha1').update(resolve(String(dbPath)).toLowerCase()).digest('hex').slice(0, 12);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\iftree-backend-${hash}`
    : join(dirname(resolve(String(dbPath))), `iftree-backend-${hash}.sock`);
}

export function backendDescriptorPath(dbPath: unknown): string {
  return join(dirname(resolve(String(dbPath))), 'backend-connection.json');
}

export function backendLogPath(dbPath: unknown): string {
  return join(dirname(resolve(String(dbPath))), 'backend-shared.log');
}

export function readBackendDescriptor(descriptorPath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(descriptorPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeBackendDescriptor(descriptorPath: string, info: Record<string, unknown> = {}): void {
  mkdirSync(dirname(descriptorPath), { recursive: true });
  writeFileSync(descriptorPath, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
}

// 只清自己写的描述：被接管后旧进程退出时不得抹掉新后端的描述文件。
export function removeBackendDescriptorIfOwn(descriptorPath: string, pid: unknown): boolean {
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
interface SpawnSharedBackendOptions {
  processPath?: string;
  hostScriptPath?: string | null;
  projectRoot?: string | null;
  env?: NodeJS.ProcessEnv;
  logPath?: string | null;
}

export function spawnSharedBackend({
  processPath = process.execPath,
  hostScriptPath = null,
  projectRoot = null,
  env = process.env,
  logPath = null
}: SpawnSharedBackendOptions = {}): ChildProcess {
  if (!hostScriptPath) throw new Error('spawnSharedBackend requires hostScriptPath');
  let logFd: number | null = null;
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
  } as unknown as SpawnOptions) as ChildProcess;
  child.unref();
  if (logFd !== null) {
    // fd 已由子进程持有，父进程侧关闭自己的句柄即可。
    try { closeSync(logFd); } catch { /* 已关闭 */ }
  }
  return child;
}
