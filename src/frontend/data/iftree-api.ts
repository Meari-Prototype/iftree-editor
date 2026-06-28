import { debugElapsedMs, debugLog, debugStartedAt, summarizeArgs, summarizeResult } from '../lib/debug-log.js';

type IftreeMethod = (...args: unknown[]) => Promise<unknown>;
type IftreeCallback = (payload: unknown) => void;
type IftreeUnsubscribe = () => void;
type IftreeApi = Record<string, IftreeMethod | ((callback: IftreeCallback) => IftreeUnsubscribe) | undefined>;

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown } | null | undefined)?.message || error || '').slice(0, 240);
}

export function getIftreeApi(): IftreeApi {
  if (typeof window === 'undefined') return {};
  return (window.iftree as IftreeApi | undefined) || {};
}

export function rawIftreeApi(): IftreeApi {
  return getIftreeApi();
}

export function hasIftreeMethod(name: string): boolean {
  return typeof getIftreeApi()[name] === 'function';
}

export function callIftree(name: string, ...args: unknown[]): Promise<unknown> {
  const fn = getIftreeApi()[name];
  if (typeof fn !== 'function') {
    return Promise.reject(new Error(`IFTree backend method is unavailable: ${name}`));
  }
  const startedAt = debugStartedAt();
  debugLog('renderer.ipc.start', {
    method: name,
    args: summarizeArgs(args)
  });
  return (fn as IftreeMethod)(...args)
    .then((result: unknown) => {
      debugLog('renderer.ipc.end', {
        method: name,
        ok: true,
        ms: debugElapsedMs(startedAt),
        result: summarizeResult(result)
      });
      return result;
    })
    .catch((error: unknown) => {
      debugLog('renderer.ipc.end', {
        method: name,
        ok: false,
        ms: debugElapsedMs(startedAt),
        error: errorMessage(error)
      });
      throw error;
    });
}

export function subscribeIftree(name: string, callback: IftreeCallback): IftreeUnsubscribe | undefined {
  const fn = getIftreeApi()[name];
  if (typeof fn !== 'function') return undefined;
  return (fn as (callback: IftreeCallback) => IftreeUnsubscribe)(callback);
}

export function minimizeWindow() {
  return callIftree('minimizeWindow');
}

export function toggleMaximizeWindow() {
  return callIftree('toggleMaximizeWindow');
}

export function closeWindow() {
  return callIftree('closeWindow');
}

export function startupHeartbeat(payload: unknown): void {
  const fn = getIftreeApi().startupHeartbeat;
  if (typeof fn === 'function') (fn as (...args: unknown[]) => unknown)(payload);
}

export function getStartupOptions() {
  return callIftree('getStartupOptions');
}

export function captureE2EWindow(payload: unknown) {
  return callIftree('captureE2EWindow', payload);
}

export function reportStartupSuccess(payload: unknown) {
  return callIftree('reportStartupSuccess', payload);
}

export function reportStartupFailure(payload: unknown) {
  return callIftree('reportStartupFailure', payload);
}

export function onProgress(callback: IftreeCallback) {
  return subscribeIftree('onProgress', callback);
}

export function onLibraryChanged(callback: IftreeCallback) {
  return subscribeIftree('onLibraryChanged', callback);
}

export function onAgentStream(callback: IftreeCallback) {
  return subscribeIftree('onAgentStream', callback);
}
