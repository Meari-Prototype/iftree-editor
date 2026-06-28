// 共享后端的管道客户端 + 写档实例的发现/接管/回退编排（projectneed 18-6-1）。
// 写档实例启动：读连接描述文件 → 能连上就复用共享后端；连不上（进程已死/描述过期）
// 就自行拉起共享后端并由它重写描述文件；拉起也失败（单机离线等）回退私有 stdio 后端，
// 单人模式不受影响。对上层暴露与 stdio 客户端同形的 request/shutdown/close/pid。
import { connect, type Socket } from 'node:net';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { join } from 'node:path';

import { createHeadlessAgentClient } from './headless-agent-client.js';
import {
  backendDescriptorPath,
  backendLogPath,
  backendPipeName,
  readBackendDescriptor,
  resolveBackendDbPath,
  spawnSharedBackend
} from './backend-discovery.js';

interface ErrorPayload {
  message?: string;
  name?: string;
  stack?: string;
}

interface ConnectionErrorMarker {
  isConnectionError?: boolean;
}

type ConnectionError = Error & ConnectionErrorMarker;

function errorFromPayload(payload: ErrorPayload = {}): Error {
  const error = new Error(payload.message || 'Shared backend request failed');
  if (payload.name) error.name = payload.name;
  if (payload.stack) (error as { stack?: string }).stack = payload.stack;
  return error;
}

function connectionError(message: string, cause: unknown = null): ConnectionError {
  const error = new Error(message) as ConnectionError;
  // 自定义标记：连接层失败（可重发现），区别于请求级业务错误（原样上抛）。
  error.isConnectionError = true;
  if (cause) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

type StreamEvent = Record<string, unknown>;

interface PendingItem {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  onEvent?: (event: StreamEvent) => void;
}

export interface PipeBackendClientOptions {
  pipeName?: string | null;
  connectTimeoutMs?: number;
}

export interface BackendRequestOptions {
  id?: string | number;
  onEvent?: (event: StreamEvent) => void;
}

export interface PipeBackendClient {
  ensureReady(): Promise<void>;
  request(type: string, payload?: Record<string, unknown>, requestOptions?: BackendRequestOptions): Promise<unknown>;
  shutdown(): Promise<void>;
  close(): void;
  readonly pid: number | null;
  readonly connected: boolean;
}

interface BackendPipeMessage {
  type?: string;
  id?: unknown;
  pid?: unknown;
  event?: StreamEvent;
  result?: unknown;
  error?: ErrorPayload;
  [extra: string]: unknown;
}

// 单连接管道客户端：JSON-L 解析与 stdio 客户端同构；连接以服务端 ready 帧为就绪信号。
export function createPipeBackendClient({ pipeName = null, connectTimeoutMs = 3000 }: PipeBackendClientOptions = {}): PipeBackendClient {
  if (!pipeName) throw new Error('createPipeBackendClient requires pipeName');
  let socket: Socket | null = null;
  let readline: ReadlineInterface | null = null;
  let readyPromise: Promise<void> | null = null;
  let remotePid: number | null = null;
  let nextId = 1;
  const pending = new Map<string, PendingItem>();

  function rejectAll(error: unknown): void {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  }

  function reset(error: unknown): void {
    const current = socket;
    const currentRl = readline;
    socket = null;
    readline = null;
    readyPromise = null;
    remotePid = null;
    if (error) rejectAll(error);
    currentRl?.close();
    current?.destroy();
  }

  function ensureReady(): Promise<void> {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      let ready = false;
      const s = connect(pipeName as string);
      socket = s;
      const timer = setTimeout(() => {
        if (!ready) {
          rejectReady(connectionError(`连接共享后端超时：${pipeName}`));
          reset(null);
        }
      }, connectTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      const rl = createInterface({ input: s, crlfDelay: Infinity });
      readline = rl;
      // readline 会把 input 的 error 转发 re-emit 到 Interface 自身；不挂监听，
      // 连接中断的 EPIPE/ECONNRESET 会以 uncaughtException 炸掉客户端进程。
      rl.on('error', () => { /* socket 侧 error 已走 reset 流程 */ });
      rl.on('line', (line: string) => {
        const raw = String(line || '').trim();
        if (!raw) return;
        let message: BackendPipeMessage | null = null;
        try {
          message = JSON.parse(raw) as BackendPipeMessage;
        } catch (error) {
          reset(connectionError(`共享后端返回非法 JSON：${(error as { message?: string }).message}`));
          return;
        }
        if (!message) return;
        if (message.type === 'ready') {
          remotePid = Number(message.pid) || null;
          if (!ready) {
            ready = true;
            clearTimeout(timer);
            resolveReady();
          }
          return;
        }
        const id = message.id == null ? '' : String(message.id);
        const item = pending.get(id);
        if (message.type === 'agent.stream') {
          item?.onEvent?.(message.event || {});
          return;
        }
        if (!item) return;
        if (message.type === 'result') {
          pending.delete(id);
          item.resolve(message.result);
          return;
        }
        if (message.type === 'error') {
          pending.delete(id);
          item.reject(errorFromPayload(message.error || {}));
        }
      });
      s.on('error', (error: Error) => {
        if (!ready) {
          clearTimeout(timer);
          rejectReady(connectionError(`连接共享后端失败：${error.message}`, error));
        }
        if (socket === s) reset(connectionError(`共享后端连接中断：${error.message}`, error));
      });
      s.on('close', () => {
        if (socket === s) reset(connectionError('共享后端连接已关闭'));
      });
    });
    return readyPromise;
  }

  async function request(type: string, payload: Record<string, unknown> = {}, requestOptions: BackendRequestOptions = {}): Promise<unknown> {
    await ensureReady();
    const running = socket;
    if (!running || running.destroyed) throw connectionError('共享后端连接不可用');
    const id = String(requestOptions.id || nextId++);
    const message: Record<string, unknown> = {
      id,
      type,
      ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { payload })
    };
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject, onEvent: requestOptions.onEvent });
      running.write(`${JSON.stringify(message)}\n`, (error?: Error | null) => {
        if (!error) return;
        pending.delete(id);
        reject(connectionError(`共享后端写入失败：${error.message}`, error));
      });
    });
  }

  async function shutdown(): Promise<void> {
    if (!socket || socket.destroyed) return;
    try {
      await request('shutdown', {});
    } catch {
      // 后端可能已在退出。
    }
    reset(null);
  }

  function close(): void {
    reset(new Error('Shared backend client closed'));
  }

  return {
    ensureReady,
    request,
    shutdown,
    close,
    get pid() {
      return remotePid;
    },
    get connected() {
      return Boolean(socket && !socket.destroyed && remotePid !== null);
    }
  };
}

export interface SharedBackendClientOptions {
  projectRoot?: string | null;
  hostScriptPath?: string | null;
  processPath?: string;
  env?: NodeJS.ProcessEnv;
  onStderr?: ((chunk: string) => void) | null;
  onStatus?: ((text: string) => void) | null;
}

interface PrivateFallbackClient {
  request(type: string, payload?: Record<string, unknown>, requestOptions?: BackendRequestOptions): Promise<unknown>;
  shutdown(): Promise<void> | void;
  close(): void;
  readonly pid: number | null;
  readonly connected?: boolean;
}

interface ActiveChannel {
  kind: 'pipe' | 'private';
  client: PipeBackendClient | PrivateFallbackClient;
}

export interface SharedBackendClient {
  request(type: string, payload?: Record<string, unknown>, requestOptions?: BackendRequestOptions): Promise<unknown>;
  shutdown(): Promise<void>;
  close(): void;
  readonly pid: number | null;
  readonly sharedBackendPid: number | null;
  readonly mode: 'pipe' | 'private' | null;
}

function isConnectionErrorLike(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as ConnectionErrorMarker).isConnectionError === true);
}

// 发现/接管/回退编排（18-6-1 主流程）。返回与 stdio 客户端同形的句柄；
// 连接层失败自动重发现（含 restart_backend 后的再拉起），业务错误原样上抛。
export function createSharedBackendClient({
  projectRoot = null,
  hostScriptPath = null,
  processPath = process.execPath,
  env = process.env,
  onStderr = null,
  onStatus = null
}: SharedBackendClientOptions = {}): SharedBackendClient {
  if (!projectRoot) throw new Error('createSharedBackendClient requires projectRoot');
  const script = hostScriptPath || join(projectRoot, 'dist', 'scripts', 'agent-host.js');
  const dbPath = resolveBackendDbPath(projectRoot, env);
  const derivedPipe = backendPipeName(dbPath);
  const descriptorPath = backendDescriptorPath(dbPath);
  const status = (text: string): void => { onStatus?.(`${text}\n`); };

  let channel: ActiveChannel | null = null;
  let connecting: Promise<ActiveChannel> | null = null;

  async function tryConnectPipe(pipeName: string): Promise<PipeBackendClient | null> {
    const client = createPipeBackendClient({ pipeName });
    try {
      await client.ensureReady();
      return client;
    } catch (error) {
      client.close();
      if (isConnectionErrorLike(error)) return null;
      throw error;
    }
  }

  async function discoverChannel(): Promise<ActiveChannel> {
    // 1) 描述文件给的管道优先（人工可改端点），同名派生管道兜底。
    const descriptor = readBackendDescriptor(descriptorPath);
    const descriptorPipe = descriptor?.pipe;
    const candidates = [
      ...new Set([typeof descriptorPipe === 'string' ? descriptorPipe : '', derivedPipe].filter(Boolean))
    ] as string[];
    for (const pipeName of candidates) {
      const client = await tryConnectPipe(pipeName);
      if (client) {
        status(`[iftree] 复用共享后端 pid=${client.pid} pipe=${pipeName}`);
        return { kind: 'pipe', client };
      }
    }
    // 2) 连不上：自行拉起共享后端（它监听成功后重写描述文件），轮询会合。
    try {
      spawnSharedBackend({
        processPath,
        hostScriptPath: script,
        projectRoot,
        env,
        logPath: backendLogPath(dbPath)
      });
      status(`[iftree] 已拉起共享后端，等待 ${derivedPipe}`);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const client = await tryConnectPipe(derivedPipe);
        if (client) {
          status(`[iftree] 共享后端就绪 pid=${client.pid}`);
          return { kind: 'pipe', client };
        }
        await sleep(250);
      }
      status('[iftree] 共享后端拉起后未能会合，回退私有后端');
    } catch (error) {
      status(`[iftree] 拉起共享后端失败（${(error as { message?: string } | null | undefined)?.message || error}），回退私有后端`);
    }
    // 3) 回退私有 stdio 后端：单人模式不受影响。
    const fallback = createHeadlessAgentClient({
      cwd: projectRoot || undefined,
      scriptPath: script,
      processPath,
      env,
      onStderr: onStderr || undefined
    }) as unknown as PrivateFallbackClient;
    return { kind: 'private', client: fallback };
  }

  async function ensureChannel(): Promise<ActiveChannel> {
    if (channel) {
      if (channel.kind === 'private' || (channel.client as PipeBackendClient).connected) return channel;
      channel = null;
    }
    if (!connecting) {
      connecting = discoverChannel().finally(() => {
        connecting = null;
      });
    }
    channel = await connecting;
    return channel;
  }

  // 非幂等动词连接中断后不自动重发：从头重跑会重复 LLM 调用与不可逆副作用（草稿/卷/导入）。
  // agent.run（长任务）与 import.*（导入/删档）上抛、由调用方决定是否重试；幂等读写（database.* 带
  // 请求级防抖键、vector.ensureDoc 等）仍重发现重发，吸收连接抖动。
  const isNonRetriable = (verb: string): boolean => verb === 'agent.run' || String(verb).startsWith('import.');

  async function request(type: string, payload: Record<string, unknown> = {}, requestOptions: BackendRequestOptions = {}): Promise<unknown> {
    const active = await ensureChannel();
    try {
      return await active.client.request(type, payload, requestOptions);
    } catch (error) {
      if (active.kind === 'pipe' && isConnectionErrorLike(error)) {
        // 连接层失败（后端被重启/退出）：标记重发现，下个请求重连。
        channel = null;
        // 幂等动词重发现一次再发；非幂等动词上抛（连接已置空，调用方重试时自会重连）。不重试业务错误。
        if (!isNonRetriable(type)) {
          const next = await ensureChannel();
          return next.client.request(type, payload, requestOptions);
        }
      }
      throw error;
    }
  }

  async function shutdown(): Promise<void> {
    const active = channel;
    channel = null;
    await active?.client.shutdown();
  }

  function close(): void {
    const active = channel;
    channel = null;
    active?.client.close();
  }

  return {
    request,
    shutdown,
    close,
    get pid() {
      return channel?.client.pid ?? null;
    },
    // 解析在跑的共享后端 pid（供 restart_backend 强杀）：已连接取 ready 帧 pid；本进程还没 request 过、
    // channel 仍为 null 时回退描述文件——别的客户端/GUI 续住的游离后端 pid 一直记在那里。否则
    // restart_backend 首调会因 client.pid 为 null 误判「未启动」而漏杀，下次调用复用旧进程跑旧代码。
    get sharedBackendPid() {
      const live = channel?.client.pid;
      if (live) return live;
      const recorded = Number(readBackendDescriptor(descriptorPath)?.pid);
      return Number.isInteger(recorded) && recorded > 0 ? recorded : null;
    },
    get mode() {
      return channel?.kind ?? null;
    }
  };
}
