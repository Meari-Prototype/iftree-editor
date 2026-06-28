import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';

type RequestPayload = Record<string, unknown>;
type RequestOptions = { id?: unknown; onEvent?: (event: unknown) => void };
type PipeChildProcess = ChildProcess & {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
};

interface HeadlessAgentClientOptions {
  processPath?: string;
  scriptPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStderr?: (chunk: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  onEvent?: (event: unknown) => void;
}

function errorFromPayload(payload: RequestPayload = {}) {
  const error = new Error(String(payload.message || 'Headless Agent request failed'));
  if (payload.name) error.name = String(payload.name);
  if (payload.stack) (error as { stack?: string }).stack = String(payload.stack);
  return error;
}

export function createHeadlessAgentClient(options: HeadlessAgentClientOptions = {}) {
  const processPath = String(options.processPath || process.execPath);
  const scriptPath = options.scriptPath;
  if (!scriptPath) throw new Error('createHeadlessAgentClient requires scriptPath');
  const resolvedScriptPath = scriptPath;
  const cwd = options.cwd || process.cwd();
  const env = {
    ...process.env,
    ...(options.env || {}),
    ELECTRON_RUN_AS_NODE: '1',
    IFTREE_HEADLESS_AGENT: '1'
  };
  let child: PipeChildProcess | null = null;
  let lineReader: Interface | null = null;
  let nextId = 1;
  const pending = new Map<string, PendingRequest>();

  function rejectAll(error: unknown): void {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  }

  function ensureStarted(): PipeChildProcess {
    if (child && !child.killed && child.exitCode == null) return child;
    const spawned = spawn(processPath, [resolvedScriptPath], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    } as SpawnOptions) as PipeChildProcess;
    child = spawned;
    spawned.stderr.on('data', (chunk: Buffer) => {
      options.onStderr?.(chunk.toString());
    });
    spawned.on('error', (error: Error) => {
      if (child !== spawned) return;
      rejectAll(error);
    });
    spawned.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (child !== spawned) return;
      child = null;
      lineReader = null;
      const error = new Error(`Headless Agent exited: code=${code ?? ''} signal=${signal ?? ''}`.trim());
      rejectAll(error);
    });
    const reader = createInterface({ input: spawned.stdout, crlfDelay: Infinity });
    lineReader = reader;
    reader.on('line', (line: string) => {
      if (child !== spawned) return;
      const raw = String(line || '').trim();
      if (!raw) return;
      let message: Record<string, unknown> | null = null;
      try {
        message = JSON.parse(raw) as Record<string, unknown>;
      } catch (error) {
        rejectAll(new Error(`Invalid Headless Agent JSON: ${(error as { message?: unknown }).message}`));
        return;
      }
      const parsed = message;
      const id = parsed.id == null ? '' : String(parsed.id);
      const item = pending.get(id);
      if (parsed.type === 'agent.stream') {
        item?.onEvent?.(parsed.event || {});
        return;
      }
      if (!item) return;
      if (parsed.type === 'result') {
        pending.delete(id);
        item.resolve(parsed.result);
        return;
      }
      if (parsed.type === 'error') {
        pending.delete(id);
        item.reject(errorFromPayload((parsed.error || {}) as RequestPayload));
      }
    });
    return spawned;
  }

  function request(type: string, payload: unknown = {}, requestOptions: RequestOptions = {}) {
    const running = ensureStarted();
    const id = String(requestOptions.id || nextId++);
    const message = {
      id,
      type,
      ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { payload })
    };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onEvent: requestOptions.onEvent });
      running.stdin.write(`${JSON.stringify(message)}\n`, 'utf8', (error) => {
        if (!error) return;
        pending.delete(id);
        reject(error);
      });
    });
  }

  async function shutdown() {
    const running = child;
    if (!running || running.killed || running.exitCode != null) return;
    try {
      await request('shutdown', {});
    } catch {
      // Process may already be closing.
    }
    if (child === running) running.stdin.end();
  }

  function close() {
    const running = child;
    const reader = lineReader;
    if (!running) return;
    for (const item of pending.values()) item.reject(new Error('Headless Agent client closed'));
    pending.clear();
    child = null;
    lineReader = null;
    reader?.close();
    running.stdin.end();
    running.kill();
  }

  return {
    request,
    shutdown,
    close,
    get pid() {
      return child?.pid || null;
    }
  };
}
