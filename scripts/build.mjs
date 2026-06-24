// 构建工具脚本（工具链豁免，不进迁移目标；同类于 vite.config.mjs/eslint.config.js 后置处理）。
// 把 src/** + electron/** + scripts/**(业务) 的 .ts 编译到 dist/ 镜像目录，供 Node/Electron/tests 运行产物。
// - ESM 源码 → .js（根 package.json type=module，运行时按 ESM 解析）
// - Electron preload → dist/electron/preload.cjs（保留 Electron preload 的 CommonJS 运行语义）
// ESM bundle:false：bare import 原样保留，由运行时 Node/Electron 从项目根 node_modules 解析。
import { build } from 'esbuild';
import { globSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const g = (/** @type {string} */ p) => globSync(p, { cwd: root });

const esm = [
  ...g('src/**/*.ts'),
  ...g('electron/**/*.ts').filter((f) => !f.endsWith('preload.ts')),
  ...g('scripts/**/*.ts')
];

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: false,
  splitting: false,
  sourcemap: false,
  logLevel: 'info',
  platform: 'node',
  target: 'node22',
  outbase: root,
  outdir: resolve(root, 'dist')
};

for (const dir of ['dist/src', 'dist/electron', 'dist/scripts']) {
  rmSync(resolve(root, dir), { recursive: true, force: true });
}

await build({
  ...common,
  entryPoints: esm,
  format: 'esm'
});

await build({
  bundle: true,
  packages: 'external',
  sourcemap: false,
  logLevel: 'info',
  platform: 'node',
  target: 'node22',
  entryPoints: [resolve(root, 'electron/preload.ts')],
  format: 'cjs',
  outfile: resolve(root, 'dist/electron/preload.cjs')
});

console.log(`build done: ${esm.length} esm + 1 cjs entry`);
