import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 回归：启动器页面 script 混入 TS 语法导致整页 JS 全灭（watchdog 表观失效）。
//
// launcherHtml() 的浏览器端 <script> 嵌在模板字符串里——类型检查器看不进字符串字面量，
// esbuild 转译也不碰字符串内容，混入的 TS 语法（如 `(error as { message?: string })`，
// commit 14a82d4 引入）会原样落到 dist，浏览器解析整个 <script> 块 SyntaxError、一行不执行：
// 文档列表连「暂无导入文档。」占位都不渲染、启动/刷新按钮 listener 绑不上、失败信息永不显示。
// 唯一能拦住的位置就是对构建产物里的内嵌 script 做一次真实 JS 语法解析。

const distMainPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'electron', 'main.js');

test('dist/electron/main.js 内嵌 <script> 均为合法纯 JS（launcher 页面脚本不含 TS 语法）', () => {
  const source = readFileSync(distMainPath, 'utf8');
  const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 1, '产物中应至少有 launcher 页面一块内嵌 <script>');
  for (const [index, match] of scripts.entries()) {
    const body = match[1];
    let syntaxError = null;
    try {
      new Function(body);
    } catch (error) {
      syntaxError = error;
    }
    assert.equal(
      syntaxError,
      null,
      `内嵌 <script> #${index} 语法非法（浏览器将整块拒绝执行）：${syntaxError && syntaxError.message}`
    );
  }
});
