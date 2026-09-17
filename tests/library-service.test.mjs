import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { createLibraryService } from '../dist/src/backend/library/library-service.js';

// mac 兼容回归：早年 normalizeRelativePath 套 Windows 非法字符集（\ / : * ? " < > |）
// 把每个路径段清洗成安全名，导致含 ? : 等合法字符的真实文件名在 library_index 里
// 被显示成 _、且不同名文件（会话?甲.md / 会话:甲.md）清洗后撞成同 key 只匹配一个 doc。
// 修复后：字符原样保留，仅做分隔符规整与越界防护。Windows 本机造不出这些字符，跑不到此用例。

async function withLibrary(files, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-libsvc-'));
  try {
    for (const rel of files) {
      const abs = join(dir, ...rel.split('/'));
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, 'x', 'utf8');
    }
    await fn(createLibraryService(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 用平台能落盘的字符做枚举/匹配验证（: ? " 在 NTFS 非法，换成 | 与 * 的同类合法字符）。
// 显示名原样保留 + 文档按键匹配成功，即证明字符清洗已移除。
const MAC_LEGAL_NAME = '会话*第|一版.md'; // NTFS 非法但 POSIX 合法 -> 本用例仅在 POSIX 平台有效

test('library_index 保留文件名字符原样，不清洗成下划线', { skip: process.platform === 'win32' }, async () => {
  await withLibrary(['docs/' + MAC_LEGAL_NAME], async (library) => {
    const docs = [{ docId: 'doc-1', sourcePath: 'docs/' + MAC_LEGAL_NAME, meta: {} }];
    const result = library.index({ uuid: true }, docs);
    assert.equal(result.kind, 'library.index');
    assert.match(result.text, new RegExp(MAC_LEGAL_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(result.text, /#doc-1/); // 匹配上文档 -> key 未被清洗错位
    assert.doesNotMatch(result.text, /_/); // 没有任何字符被替换成 _
  });
});

test('清洗碰撞消除：不同名文件各自匹配到自己的 doc', { skip: process.platform === 'win32' }, async () => {
  const a = 'docs/会话*甲.md';
  const b = 'docs/会话|甲.md'; // 旧逻辑下两者都清洗成 会话_甲.md 撞同 key
  await withLibrary([a, b], async (library) => {
    const docs = [
      { docId: 'doc-a', sourcePath: a, meta: {} },
      { docId: 'doc-b', sourcePath: b, meta: {} }
    ];
    const result = library.index({ uuid: true }, docs);
    assert.match(result.text, /#doc-a/);
    assert.match(result.text, /#doc-b/);
    assert.equal(result.count, 2);
  });
});

test('越界路径仍然被拒绝（不依赖字符清洗）', async () => {
  await withLibrary([], async (library) => {
    assert.throws(() => library.fullPath('../escape.md'), /cannot escape/i);
    assert.throws(() => library.fullPath('a/../../escape.md'), /cannot escape/i);
  });
});

test('相对路径规整：反斜杠归一、点段剔除、原样保留字符', async () => {
  await withLibrary([], async (library) => {
    // fullPath 只校验不抛错并落在根内即可；字符不做替换
    const p = library.fullPath('a\\b/./c d.md');
    assert.match(p.replace(/\\/g, '/'), /a\/b\/c d\.md$/);
  });
});

// search()/walk() 过去用 statSync（跟随 symlink）且不过忽略名单：库里有一个悬空的事件卷锚
// （.memory 下全是 symlink）就 ENOENT 抛出、整棵树搜不动；同时还会递归进 .memory / .git。
test('search：悬空 symlink 不炸、忽略目录不进结果也不被递归', async () => {
  await withLibrary(['docs/alpha.md', '.memory/agent/alpha.jsonl', '.git/alpha.txt'], async (library, dir) => {
    // 悬空 symlink：目标不存在（Windows 无权建 symlink 时跳过这一半，其余断言照跑）。
    let danglingCreated = false;
    try {
      await symlink(join(dir, 'missing-target.md'), join(dir, 'docs', 'alpha-link.md'));
      danglingCreated = true;
    } catch { /* EPERM：Windows 未开开发者模式，跳过 symlink 部分 */ }

    const result = library.query({ query: 'alpha', limit: 50 });
    const paths = result.results.map((item) => item.relativePath);

    assert.ok(paths.includes('docs/alpha.md'), '正常文件应命中');
    // 忽略名单：锚目录与 .git 既不进结果，也不被走进去。
    assert.equal(paths.some((path) => path.startsWith('.memory')), false);
    assert.equal(paths.some((path) => path.startsWith('.git')), false);
    if (danglingCreated) {
      // 悬空 symlink 自身仍可被列出（lstat 拿得到），关键是没把整次搜索带崩。
      assert.ok(paths.includes('docs/alpha-link.md'));
      assert.equal(result.results.find((item) => item.relativePath === 'docs/alpha-link.md').size, null);
    }
  });
});
