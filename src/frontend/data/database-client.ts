import { hasIftreeMethod, rawIftreeApi } from './iftree-api.js';
import { debugElapsedMs, debugLog, debugStartedAt, summarizePayload, summarizeResult } from '../lib/debug-log.js';

type DatabasePayload = Record<string, unknown>;
type DatabaseIpcMethod = (payload: unknown) => Promise<unknown>;

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown } | null | undefined)?.message || error || '').slice(0, 240);
}

export function canReadDatabase() {
  return hasIftreeMethod('readDatabase');
}

export function canWriteDatabase() {
  return hasIftreeMethod('writeDatabase');
}

export function canRunDatabaseCommand() {
  return hasIftreeMethod('runDatabaseCommand');
}

export async function runDatabaseCommand(command: unknown): Promise<unknown> {
  const api = rawIftreeApi();
  if (typeof api.runDatabaseCommand !== 'function') {
    throw new Error('IFTree database command is unavailable');
  }
  const startedAt = debugStartedAt();
  debugLog('renderer.database.command.start', { payload: summarizePayload(command) });
  try {
    const result = await (api.runDatabaseCommand as DatabaseIpcMethod)(command || {});
    debugLog('renderer.database.command.end', {
      ok: true,
      ms: debugElapsedMs(startedAt),
      payload: summarizePayload(command),
      result: summarizeResult(result)
    });
    return result;
  } catch (error) {
    debugLog('renderer.database.command.end', {
      ok: false,
      ms: debugElapsedMs(startedAt),
      payload: summarizePayload(command),
      error: errorMessage(error)
    });
    throw error;
  }
}

export async function readDatabase(payload: DatabasePayload): Promise<unknown> {
  const api = rawIftreeApi();
  if (typeof api.readDatabase === 'function') {
    const startedAt = debugStartedAt();
    debugLog('renderer.database.read.start', { payload: summarizePayload(payload) });
    try {
      const result = await (api.readDatabase as DatabaseIpcMethod)(payload || {});
      debugLog('renderer.database.read.end', {
        ok: true,
        ms: debugElapsedMs(startedAt),
        payload: summarizePayload(payload),
        result: summarizeResult(result)
      });
      return result;
    } catch (error) {
      debugLog('renderer.database.read.end', {
        ok: false,
        ms: debugElapsedMs(startedAt),
        payload: summarizePayload(payload),
        error: errorMessage(error)
      });
      throw error;
    }
  }
  throw new Error('IFTree database read is unavailable');
}

export async function writeDatabase(payload: DatabasePayload): Promise<unknown> {
  const api = rawIftreeApi();
  if (typeof api.writeDatabase === 'function') {
    const startedAt = debugStartedAt();
    debugLog('renderer.database.write.start', { payload: summarizePayload(payload) });
    try {
      const result = await (api.writeDatabase as DatabaseIpcMethod)(payload || {});
      debugLog('renderer.database.write.end', {
        ok: true,
        ms: debugElapsedMs(startedAt),
        payload: summarizePayload(payload),
        result: summarizeResult(result)
      });
      return result;
    } catch (error) {
      debugLog('renderer.database.write.end', {
        ok: false,
        ms: debugElapsedMs(startedAt),
        payload: summarizePayload(payload),
        error: errorMessage(error)
      });
      throw error;
    }
  }
  throw new Error('IFTree database write is unavailable');
}
