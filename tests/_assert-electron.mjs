// 测试运行时守卫：本项目绝对禁止使用 node 进行测试。
//
// 原生模块（better-sqlite3、@lancedb 等）按 Electron ABI 编译（NODE_MODULE_VERSION 跟随 electron），
// 用系统 node 跑会在 new Database / 索引重建处 ERR_DLOPEN_FAILED——而且要跑到那一步才炸，浪费时间、
// 还会因为 spawn 子进程的 db/* 用例"假装通过"而产生误判。
//
// 这里在每个测试文件加载的最早一刻就拦下：非 electron 运行时立即打印并退出，绝不等到 ABI 崩。
// 正确跑法：npm test（tests/*.test.mjs）/ npm run test:verbs（tests/db/*.test.mjs），
// 或 ELECTRON_RUN_AS_NODE=1 electron --test "tests/*.test.mjs" "tests/db/*.test.mjs"。
if (!process.versions.electron) {
  process.stderr.write(
    '\n========================================================================\n'
    + '本项目绝对禁止使用 node 进行测试。\n'
    + '原生模块按 Electron ABI 编译，必须用 electron 运行测试：\n'
    + '  npm test            # 顶层 tests/*.test.mjs\n'
    + '  npm run test:verbs  # tests/db/*.test.mjs\n'
    + '  或 ELECTRON_RUN_AS_NODE=1 electron --test "tests/*.test.mjs" "tests/db/*.test.mjs"\n'
    + `（当前运行时：node ${process.version}，process.versions.electron 未定义。）\n`
    + '========================================================================\n\n'
  );
  process.exit(1);
}
