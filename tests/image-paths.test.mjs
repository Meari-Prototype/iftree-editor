import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { resolveMarkdownImageUrl } from '../src/core/image-paths.mjs';

async function withTempDir(fn) {
  const dir = join(tmpdir(), `iftree-images-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('resolveMarkdownImageUrl keeps external image URLs unchanged', () => {
  assert.equal(resolveMarkdownImageUrl({
    src: 'https://example.com/image%20one.png',
    docMeta: {},
    appHome: 'D:\\App'
  }), 'https://example.com/image%20one.png');
});

test('resolveMarkdownImageUrl resolves relative images from the imported source directory', async () => {
  await withTempDir(async (dir) => {
    const imagePath = join(dir, 'images', 'cover.png');
    await mkdir(join(dir, 'images'));
    await writeFile(imagePath, 'png');

    const url = resolveMarkdownImageUrl({
      src: 'images/cover.png',
      docMeta: { sourcePath: join(dir, 'doc.xlsx') },
      appHome: join(dir, '.iftree')
    });

    assert.equal(url, pathToFileURL(imagePath).href);
  });
});

test('resolveMarkdownImageUrl resolves app-managed asset paths from app home', async () => {
  await withTempDir(async (dir) => {
    const imagePath = join(dir, '.iftree', 'assets', 'doc-7', 'map.png');
    await mkdir(join(dir, '.iftree', 'assets', 'doc-7'), { recursive: true });
    await writeFile(imagePath, 'png');

    const url = resolveMarkdownImageUrl({
      src: 'assets/doc-7/map.png',
      docMeta: {},
      appHome: join(dir, '.iftree')
    });

    assert.equal(url, pathToFileURL(imagePath).href);
  });
});
