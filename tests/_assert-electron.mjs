// 测试运行时守卫（headless 解耦后反转）：本项目测试现用 node 运行。
//
// 后端原生模块（better-sqlite3、@lancedb 等）已随主线改为 node ABI（NODE_MODULE_VERSION 跟随系统
// node），测试用 node --test 直跑。原守卫禁 node（那时原生模块是 electron ABI、node 跑会 ERR_DLOPEN）；
// 解耦后方向反转——用 electron(-as-node) 跑测试才会在 new Database / 索引重建处 ERR_DLOPEN_FAILED。
//
// 这里在每个测试文件加载最早一刻拦下 electron 运行时，绝不等到 ABI 崩。文件名 _assert-electron 是
// 历史遗留（55 处 import 沿用未改名），逻辑已反转为「assert node runtime」。
// 正确跑法：npm test（tests/*.test.mjs）/ npm run test:verbs（tests/db/*.test.mjs），或 node --test。
if (process.versions.electron) {
  process.stderr.write(
    '\n========================================================================\n'
    + '本项目测试已改用 node 运行（headless 解耦：后端原生模块改 node ABI）。\n'
    + '检测到 electron 运行时——better-sqlite3 是 node ABI，electron(-as-node) 跑会\n'
    + '在 new Database 处 ERR_DLOPEN（electron ABI ≠ node ABI）。请用 node 跑：\n'
    + '  npm test            # 顶层 tests/*.test.mjs\n'
    + '  npm run test:verbs  # tests/db/*.test.mjs\n'
    + '  或 node --test "tests/*.test.mjs" "tests/db/*.test.mjs"\n'
    + `（当前运行时：electron ${process.versions.electron}。）\n`
    + '========================================================================\n\n'
  );
  process.exit(1);
}
