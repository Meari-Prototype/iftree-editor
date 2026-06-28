import {
  IftreeStore,
  runDatabaseRead,
  runDatabaseWrite,
  databaseReadActions,
  databaseWriteActions,
  createDatabaseService
} from './database-service.js';

interface BackendOptions {
  ctx?: unknown;
  readContext?: unknown;
  writeContext?: unknown;
  seed?: unknown;
}

interface BackendDatabaseService {
  store: unknown;
  read(payload: unknown): unknown;
  write(payload: unknown): unknown;
  close(): void;
}

const createDatabaseServiceTyped = createDatabaseService as unknown as (options: {
  dbPath: string;
  readContext?: unknown;
  writeContext?: unknown;
  seed?: unknown;
}) => BackendDatabaseService;

export function createBackend(dbPath: string, options: BackendOptions = {}) {
  const database = createDatabaseServiceTyped({
    dbPath,
    readContext: options.readContext || options.ctx,
    writeContext: options.writeContext || options.ctx,
    seed: options.seed
  });

  return {
    database,
    get store() {
      return database.store;
    },
    read(payload: unknown) {
      return database.read(payload);
    },
    write(payload: unknown) {
      return database.write(payload);
    },
    close() {
      database.close();
    }
  };
}

export {
  IftreeStore,
  runDatabaseRead,
  runDatabaseWrite,
  createDatabaseService,
  databaseReadActions,
  databaseWriteActions
};
