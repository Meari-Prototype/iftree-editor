import {
  IftreeStore,
  runDatabaseRead,
  runDatabaseWrite,
  databaseReadActions,
  databaseWriteActions,
  createDatabaseService
} from './database-service.mjs';

export function createBackend(dbPath, options = {}) {
  const database = createDatabaseService({
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
    read(payload) {
      return database.read(payload);
    },
    write(payload) {
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
