const { app } = require('electron');

app.whenReady().then(async () => {
  const Database = require('better-sqlite3');
  const lancedb = await import('@lancedb/lancedb');
  console.log(JSON.stringify({
    electron: process.versions.electron,
    node: process.versions.node,
    modules: process.versions.modules,
    betterSqlite3: typeof Database,
    lancedb: typeof lancedb.connect
  }, null, 2));
  app.quit();
}).catch((error) => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
