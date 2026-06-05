import { debugElapsedMs, debugLog, debugStartedAt, summarizeArgs, summarizeResult } from '../lib/debug-log.mjs';

export function getIftreeApi() {
  if (typeof window === 'undefined') return {};
  return window.iftree || {};
}

export function rawIftreeApi() {
  return getIftreeApi();
}

export function hasIftreeMethod(name) {
  return typeof getIftreeApi()[name] === 'function';
}

export function callIftree(name, ...args) {
  const fn = getIftreeApi()[name];
  if (typeof fn !== 'function') {
    return Promise.reject(new Error(`IFTree backend method is unavailable: ${name}`));
  }
  const startedAt = debugStartedAt();
  debugLog('renderer.ipc.start', {
    method: name,
    args: summarizeArgs(args)
  });
  return fn(...args)
    .then((result) => {
      debugLog('renderer.ipc.end', {
        method: name,
        ok: true,
        ms: debugElapsedMs(startedAt),
        result: summarizeResult(result)
      });
      return result;
    })
    .catch((error) => {
      debugLog('renderer.ipc.end', {
        method: name,
        ok: false,
        ms: debugElapsedMs(startedAt),
        error: String(error?.message || error || '').slice(0, 240)
      });
      throw error;
    });
}

export function subscribeIftree(name, callback) {
  const fn = getIftreeApi()[name];
  if (typeof fn !== 'function') return undefined;
  return fn(callback);
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

export function startupHeartbeat(payload) {
  const fn = getIftreeApi().startupHeartbeat;
  if (typeof fn === 'function') fn(payload);
}

export function getStartupOptions() {
  return callIftree('getStartupOptions');
}

export function captureE2EWindow(payload) {
  return callIftree('captureE2EWindow', payload);
}

export function reportStartupSuccess(payload) {
  return callIftree('reportStartupSuccess', payload);
}

export function reportStartupFailure(payload) {
  return callIftree('reportStartupFailure', payload);
}

export function onProgress(callback) {
  return subscribeIftree('onProgress', callback);
}

export function onLibraryChanged(callback) {
  return subscribeIftree('onLibraryChanged', callback);
}

export function onAgentStream(callback) {
  return subscribeIftree('onAgentStream', callback);
}
