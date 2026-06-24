// @ts-nocheck
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

function errorFromPayload(payload = {}) {
  const error = new Error(payload.message || 'Headless Agent request failed');
  if (payload.name) error.name = payload.name;
  if (payload.stack) error.stack = payload.stack;
  return error;
}

export function createHeadlessAgentClient(options = {}) {
  const processPath = options.processPath || process.execPath;
  const scriptPath = options.scriptPath;
  if (!scriptPath) throw new Error('createHeadlessAgentClient requires scriptPath');
  const cwd = options.cwd || process.cwd();
  const env = {
    ...process.env,
    ...(options.env || {}),
    ELECTRON_RUN_AS_NODE: '1',
    IFTREE_HEADLESS_AGENT: '1'
  };
  let child = null;
  let lineReader = null;
  let nextId = 1;
  const pending = new Map();

  function rejectAll(error) {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  }

  function ensureStarted() {
    if (child && !child.killed && child.exitCode == null) return child;
    const spawned = spawn(processPath, [scriptPath], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    child = spawned;
    spawned.stderr.on('data', (chunk) => {
      options.onStderr?.(chunk.toString());
    });
    spawned.on('error', (error) => {
      if (child !== spawned) return;
      rejectAll(error);
    });
    spawned.on('exit', (code, signal) => {
      if (child !== spawned) return;
      child = null;
      lineReader = null;
      const error = new Error(`Headless Agent exited: code=${code ?? ''} signal=${signal ?? ''}`.trim());
      rejectAll(error);
    });
    const reader = createInterface({ input: spawned.stdout, crlfDelay: Infinity });
    lineReader = reader;
    reader.on('line', (line) => {
      if (child !== spawned) return;
      const raw = String(line || '').trim();
      if (!raw) return;
      let message = null;
      try {
        message = JSON.parse(raw);
      } catch (error) {
        rejectAll(new Error(`Invalid Headless Agent JSON: ${error.message}`));
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
    return spawned;
  }

  function request(type, payload = {}, requestOptions = {}) {
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
