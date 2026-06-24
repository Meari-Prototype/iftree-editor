// @ts-nocheck
import { hasIftreeMethod, rawIftreeApi } from './iftree-api.js';
import { debugElapsedMs, debugLog, debugStartedAt, summarizePayload, summarizeResult } from '../lib/debug-log.js';

export function canReadDatabase() {
  return hasIftreeMethod('readDatabase');
}

export function canWriteDatabase() {
  return hasIftreeMethod('writeDatabase');
}

export function canRunDatabaseCommand() {
  return hasIftreeMethod('runDatabaseCommand');
}

export async function runDatabaseCommand(command) {
  const api = rawIftreeApi();
  if (typeof api.runDatabaseCommand !== 'function') {
    throw new Error('IFTree database command is unavailable');
  }
  const startedAt = debugStartedAt();
  debugLog('renderer.database.command.start', { payload: summarizePayload(command) });
  try {
    const result = await api.runDatabaseCommand(command || {});
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
      error: String(error?.message || error || '').slice(0, 240)
    });
    throw error;
  }
}

export async function readDatabase(payload) {
  const api = rawIftreeApi();
  if (typeof api.readDatabase === 'function') {
    const startedAt = debugStartedAt();
    debugLog('renderer.database.read.start', { payload: summarizePayload(payload) });
    try {
      const result = await api.readDatabase(payload || {});
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
        error: String(error?.message || error || '').slice(0, 240)
      });
      throw error;
    }
  }
  throw new Error('IFTree database read is unavailable');
}

export async function writeDatabase(payload) {
  const api = rawIftreeApi();
  if (typeof api.writeDatabase === 'function') {
    const startedAt = debugStartedAt();
    debugLog('renderer.database.write.start', { payload: summarizePayload(payload) });
    try {
      const result = await api.writeDatabase(payload || {});
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
        error: String(error?.message || error || '').slice(0, 240)
      });
      throw error;
    }
  }
  throw new Error('IFTree database write is unavailable');
}
