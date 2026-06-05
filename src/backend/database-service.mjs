import { IftreeStore } from './store.mjs';
import { runDatabaseCommand } from './database-command.mjs';
import { createLibraryService } from './library-service.mjs';
import { runDatabaseRead, databaseReadActions } from './query-api.mjs';
import { runDatabaseWrite, databaseWriteActions } from './mutation-api.mjs';

function resolveContext(value) {
  if (typeof value === 'function') return value() || {};
  return value || {};
}

function mergeContext(base, override) {
  return {
    ...resolveContext(base),
    ...resolveContext(override)
  };
}

function resolveService(value) {
  return typeof value === 'function' ? value() : value;
}

export function createDatabaseService(options = {}) {
  const config = typeof options === 'string' ? { dbPath: options } : (options || {});
  const dbPath = String(config.dbPath || '').trim();
  const externalStore = config.store || null;
  let store = externalStore;
  let ownsStore = false;

  if (!externalStore && !dbPath) {
    throw new Error('createDatabaseService requires dbPath or store');
  }
  const library = config.library || (config.libraryRoot ? createLibraryService(config.libraryRoot) : null);

  function readContext(contextOverride = null) {
    return mergeContext({
      ...(resolveContext(config.readContext || config.ctx)),
      libraryTree: library ? (payload) => library.query(payload || {}) : null,
      libraryIndex: library ? (payload, docs) => library.index(payload || {}, docs || []) : null,
      libraryNavigation: library ? (payload, docs) => library.navigation(payload || {}, docs || []) : null,
      libraryRelativePath: library ? (value) => library.relativePathFor(value) : null
    }, contextOverride);
  }

  function getStore() {
    if (!store) {
      store = new IftreeStore(dbPath);
      store.init(config.initOptions || {});
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
    read(payload = {}, contextOverride = null) {
      const action = payload?.action || payload?.type;
      if (action === 'query.actions' || action === 'library.getTree') {
        return runDatabaseRead(null, payload, readContext(contextOverride));
      }
      return runDatabaseRead(getStore(), payload, readContext(contextOverride));
    },
    write(payload = {}, contextOverride = null) {
      const writeService = resolveService(config.writeService);
      if (writeService && writeService !== service && typeof writeService.write === 'function') {
        return writeService.write(payload, contextOverride);
      }
      if ((payload?.action || payload?.type) === 'mutation.actions') {
        return runDatabaseWrite(null, payload, mergeContext(config.writeContext || config.ctx, contextOverride));
      }
      return runDatabaseWrite(getStore(), payload, mergeContext(config.writeContext || config.ctx, contextOverride));
    },
    run(command = {}, fallbackOperation = 'read', contextOverride = null) {
      return runDatabaseCommand(service, command, fallbackOperation, contextOverride);
    },
    updateSourceBinding(payload = {}) {
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
