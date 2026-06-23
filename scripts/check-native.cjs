#!/usr/bin/env node
// Headless native 自检（projectneed `18` 解耦）：在纯 node runtime 下确认两个 native 依赖可加载、可用——
// better-sqlite3（node ABI，prebuild-install 下载）与 @lancedb/lancedb（N-API 预编译，node/electron 通用）。
// 只用 node、不依赖 electron / display，docker slim 里能直接验（旧的 electron + app.whenReady() 版已退役）。
//   node scripts/check-native.cjs   (= npm run check:native / check:native:node)
const Database = require('better-sqlite3');

(async () => {
  // 不止 require：实开一次内存库并查询，确认 ABI 真能用（NODE_MODULE_VERSION 对得上，不是只解析到 .node 文件）。
  const db = new Database(':memory:');
  const probe = db.prepare('SELECT 1 AS ok').get();
  db.close();

  // @lancedb/lancedb 的 native addon 在 import 时加载；import 不抛即 N-API 预编译加载成功。
  const lancedb = await import('@lancedb/lancedb');

  console.log(JSON.stringify({
    node: process.versions.node,
    modules: process.versions.modules,
    betterSqlite3: typeof Database,
    betterSqlite3Open: Boolean(probe && probe.ok === 1),
    lancedbConnect: typeof lancedb.connect
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
