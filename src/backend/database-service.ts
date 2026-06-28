import { IftreeStore } from './store/index.js';
import { runDatabaseCommand } from './database-command.js';
import { createLibraryService } from './library-service.js';
import { runDatabaseRead, databaseReadActions } from './query-api.js';
import { runDatabaseWrite, databaseWriteActions } from './mutation-api.js';

type ContextValue = Record<string, unknown>;
type PayloadValue = Record<string, unknown>;

interface LibraryServiceLike {
  query(payload: PayloadValue): unknown;
  index(payload: PayloadValue, docs: unknown[]): unknown;
  navigation(payload: PayloadValue, docs: unknown[]): unknown;
  relativePathFor(value: unknown): unknown;
}

interface DatabaseServiceLike {
  write?(payload: PayloadValue, contextOverride?: unknown): unknown;
  updateSourceBinding?(payload: PayloadValue): unknown;
  close?(): void;
}

interface DatabaseServiceOptions {
  dbPath?: unknown;
  store?: IftreeStore | null;
  library?: LibraryServiceLike | null;
  libraryRoot?: string;
  readContext?: unknown;
  writeContext?: unknown;
  ctx?: unknown;
  initOptions?: unknown;
  seed?: (store: IftreeStore) => void;
  writeService?: DatabaseServiceLike | (() => DatabaseServiceLike) | null;
}

const runDatabaseReadTyped = runDatabaseRead as unknown as (
  store: unknown,
  payload: PayloadValue,
  context: ContextValue
) => unknown;
const runDatabaseWriteTyped = runDatabaseWrite as unknown as (
  store: unknown,
  payload: PayloadValue,
  context: ContextValue
) => unknown;
const runDatabaseCommandTyped = runDatabaseCommand as unknown as (
  service: unknown,
  command: PayloadValue,
  fallbackOperation: string,
  contextOverride: unknown
) => unknown;

function resolveContext(value: unknown): ContextValue {
  if (typeof value === 'function') return ((value as () => ContextValue | null | undefined)() || {});
  return (value || {}) as ContextValue;
}

function mergeContext(base: unknown, override: unknown): ContextValue {
  return {
    ...resolveContext(base),
    ...resolveContext(override)
  };
}

function resolveService(value: DatabaseServiceLike | (() => DatabaseServiceLike) | null | undefined): DatabaseServiceLike | null | undefined {
  return typeof value === 'function' ? (value as () => DatabaseServiceLike)() : value;
}

export function createDatabaseService(options: string | DatabaseServiceOptions = {}) {
  const config: DatabaseServiceOptions = typeof options === 'string' ? { dbPath: options } : (options || {});
  const dbPath = String(config.dbPath || '').trim();
  const externalStore = config.store || null;
  let store: IftreeStore | null = externalStore;
  let ownsStore = false;

  if (!externalStore && !dbPath) {
    throw new Error('createDatabaseService requires dbPath or store');
  }
  const library = (config.library || (config.libraryRoot ? createLibraryService(config.libraryRoot) : null)) as LibraryServiceLike | null;

  function readContext(contextOverride: unknown = null) {
    return mergeContext({
      ...(resolveContext(config.readContext || config.ctx)),
      libraryTree: library ? (payload: PayloadValue) => library.query(payload || {}) : null,
      libraryIndex: library ? (payload: PayloadValue, docs: unknown[]) => library.index(payload || {}, docs || []) : null,
      libraryNavigation: library ? (payload: PayloadValue, docs: unknown[]) => library.navigation(payload || {}, docs || []) : null,
      libraryRelativePath: library ? (value: unknown) => library.relativePathFor(value) : null
    }, contextOverride);
  }

  function getStore() {
    if (!store) {
      // init 失败（典型：restart_backend 强杀旧后端后库文件锁/WAL 尚未释放，new Database 开库失败）
      // 必须把半成品丢弃、保持 store 未赋值再 rethrow；否则带 db=null 的实例会被钉进 store 缓存，
      // 之后每次读都命中 query-api 的 `!store?.db` → 持续报 'read query store is not available'，
      // 整个 host 进程不可自愈（projectneed 18-6）。复位后下次工具调用会重建 store、重试开库。
      const candidate = new IftreeStore(dbPath);
      try {
        candidate.init(config.initOptions || {});
      } catch (error) {
        try { candidate.close?.(); } catch { /* 半成品句柄清理，吞掉次生错误 */ }
        throw error;
      }
      store = candidate;
      ownsStore = true;
      if (typeof config.seed === 'function') config.seed(store);
    }
    return store;
  }

  const service = {
    get store() {
      return getStore();
    },
    getStore,
    read(payload: PayloadValue = {}, contextOverride: unknown = null) {
      const action = payload?.action || payload?.type;
      if (action === 'query.actions' || action === 'library.getTree') {
        return runDatabaseReadTyped(null, payload, readContext(contextOverride));
      }
      return runDatabaseReadTyped(getStore(), payload, readContext(contextOverride));
    },
    write(payload: PayloadValue = {}, contextOverride: unknown = null) {
      const writeService = resolveService(config.writeService);
      if (writeService && writeService !== service && typeof writeService.write === 'function') {
        return writeService.write(payload, contextOverride);
      }
      if ((payload?.action || payload?.type) === 'mutation.actions') {
        return runDatabaseWriteTyped(null, payload, mergeContext(config.writeContext || config.ctx, contextOverride));
      }
      return runDatabaseWriteTyped(getStore(), payload, mergeContext(config.writeContext || config.ctx, contextOverride));
    },
    run(command: PayloadValue = {}, fallbackOperation = 'read', contextOverride: unknown = null) {
      return runDatabaseCommandTyped(service, command, fallbackOperation, contextOverride);
    },
    updateSourceBinding(payload: PayloadValue = {}) {
      const writeService = resolveService(config.writeService);
      if (writeService && writeService !== service && typeof writeService.updateSourceBinding === 'function') {
        return writeService.updateSourceBinding(payload);
      }
      return getStore().updateSourceBinding(payload || {});
    },
    close() {
      if (ownsStore && store?.close) store.close();
      if (ownsStore) store = null;
    }
  };
  return service;
}

export {
  IftreeStore,
  runDatabaseRead,
  runDatabaseWrite,
  databaseReadActions,
  databaseWriteActions
};
