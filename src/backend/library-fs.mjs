// library 目录枚举与 LLM 工作区测量的唯一权威实现。
// main 进程与 headless 进程此前各持一份手抄副本（逐字相同但随时可能漂移）。
// 进程特异的只有根路径来自哪里——用 create* 工厂注入，其余全部共享。
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, parse, relative, resolve, sep } from 'node:path';

export const DEFAULT_LLM_WORKSPACE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
// 工作区产物（智能导入的一次性脚本与 JSON 等）默认保留 30 天（projectneed 4-3-2-1）。
const LLM_WORKSPACE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function pathKey(value) {
  return resolve(String(value || '')).toLowerCase();
}

export function isSameOrChildPath(target, parent) {
  const targetKey = pathKey(target);
  const parentKey = pathKey(parent);
  return targetKey === parentKey || targetKey.startsWith(`${parentKey}${sep}`);
}

export function normalizeLibraryRelativePath(value = '') {
  const normalized = String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('/');
  if (!normalized || normalized === '.') return '';
  if (normalized.split('/').some((part) => part === '..')) {
    throw new Error('Library path cannot escape the library folder');
  }
  return normalized;
}

export function sortLibraryEntries(left, right) {
  if (left.type !== right.type) return left.type === 'folder' ? -1 : 1;
  return String(left.name || '').localeCompare(String(right.name || ''), 'zh-Hans-CN', { numeric: true });
}

// library 枚举的统一忽略策略（唯一权威，避免各处 filter 漂移）：
// 系统垃圾文件始终忽略；. 开头隐藏项默认忽略，includeHidden=true 时保留。
const ALWAYS_IGNORED_ENTRIES = new Set(['.DS_Store', 'Thumbs.db']);

export function shouldIgnoreLibraryEntry(name, { includeHidden = false } = {}) {
  const entryName = String(name || '');
  if (ALWAYS_IGNORED_ENTRIES.has(entryName)) return true;
  if (!includeHidden && entryName.startsWith('.')) return true;
  return false;
}

export function measureWorkspaceEntry(entryPath) {
  const stat = statSync(entryPath);
  let sizeBytes = stat.size;
  if (stat.isDirectory()) {
    for (const entry of readdirSync(entryPath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      sizeBytes += measureWorkspaceEntry(join(entryPath, entry.name)).sizeBytes;
    }
  }
  return { sizeBytes, mtimeMs: stat.mtimeMs };
}

export function createLibraryFs({ ensureRoot }) {
  function libraryPath(relativePath = '') {
    const root = ensureRoot();
    const rel = normalizeLibraryRelativePath(relativePath);
    const target = resolve(root, rel);
    const rootKey = pathKey(root);
    const targetKey = pathKey(target);
    if (targetKey !== rootKey && !targetKey.startsWith(`${rootKey}${sep}`)) {
      throw new Error('Library path cannot escape the library folder');
    }
    return target;
  }

  function libraryEntry(relativePath, dirent) {
    const abs = libraryPath(relativePath);
    const stat = statSync(abs);
    const type = dirent?.isDirectory?.() || stat.isDirectory() ? 'folder' : 'file';
    const entry = {
      type,
      name: parse(abs).base,
      relativePath: normalizeLibraryRelativePath(relativePath),
      fullPath: abs,
      extension: type === 'file' ? extname(abs).toLowerCase() : '',
      size: stat.size,
      mtimeMs: stat.mtimeMs
    };
    if (type === 'folder') entry.children = listLibraryChildren(entry.relativePath);
    return entry;
  }

  function listLibraryChildren(relativePath = '', { includeHidden = false } = {}) {
    const folder = libraryPath(relativePath);
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => !shouldIgnoreLibraryEntry(entry.name, { includeHidden }) && !entry.isSymbolicLink())
      .map((entry) => libraryEntry(normalizeLibraryRelativePath(join(relativePath, entry.name)), entry))
      .sort(sortLibraryEntries);
  }

  function libraryRelativePathForAgent(filePath = '') {
    if (!filePath) return '';
    const root = ensureRoot();
    const target = resolve(String(filePath));
    const rootKey = pathKey(root);
    const targetKey = pathKey(target);
    if (targetKey !== rootKey && !targetKey.startsWith(`${rootKey}${sep}`)) return '';
    return normalizeLibraryRelativePath(relative(root, target));
  }

  return { libraryPath, libraryEntry, listLibraryChildren, libraryRelativePathForAgent };
}

export function createLlmWorkspace({ workspaceRoot, workspaceBin, projectRoot, readProjectConfig }) {
  function llmWorkspaceLimitBytes() {
    const configured = Number(
      process.env.IFTREE_LLM_WORKSPACE_LIMIT_BYTES
      || readProjectConfig().llm?.agent?.workspaceLimitBytes
      || readProjectConfig().llmWorkspaceLimitBytes
    );
    return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_LLM_WORKSPACE_LIMIT_BYTES;
  }

  function ensureLlmWorkspaceRoot() {
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(workspaceBin, { recursive: true });
    const dbScript = join(projectRoot, 'scripts', 'db.mjs');
    writeFileSync(join(workspaceBin, 'db.cmd'), [
      '@echo off',
      `"${process.execPath}" "${dbScript}" %*`
    ].join('\r\n'), 'utf8');
    writeFileSync(join(workspaceBin, 'db'), [
      '#!/bin/sh',
      `exec "${process.execPath}" "${dbScript}" "$@"`
    ].join('\n'), 'utf8');
    return workspaceRoot;
  }

  // 纯计算：返回工作区状态，由调用方决定缓存在哪。
  function refreshLlmWorkspaceState() {
    const root = ensureLlmWorkspaceRoot();
    const limitBytes = llmWorkspaceLimitBytes();
    const measured = measureWorkspaceEntry(root);
    const cleanupCandidates = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.name !== '.bin' && !entry.isSymbolicLink())
      .map((entry) => {
        const fullPath = join(root, entry.name);
        const item = measureWorkspaceEntry(fullPath);
        return {
          name: entry.name,
          relativePath: relative(root, fullPath).replace(/\\/g, '/'),
          type: entry.isDirectory() ? 'folder' : 'file',
          sizeBytes: item.sizeBytes,
          mtimeMs: item.mtimeMs
        };
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    return {
      root,
      relativePath: '.iftree-llm-workspace',
      sizeBytes: measured.sizeBytes,
      limitBytes,
      overLimit: measured.sizeBytes > limitBytes,
      cleanupCandidates: measured.sizeBytes > limitBytes ? cleanupCandidates : []
    };
  }

  // 启动时清理顶层过期条目（按 mtime；目录被写入会刷新 mtime，活跃目录不会被清）。
  // .bin 工具目录除外；占用中的条目删除失败留给下次启动。
  function cleanupExpiredWorkspaceEntries(now = Date.now()) {
    const root = ensureLlmWorkspaceRoot();
    const removed = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name === '.bin' || entry.isSymbolicLink()) continue;
      const fullPath = join(root, entry.name);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs <= LLM_WORKSPACE_TTL_MS) continue;
      try {
        rmSync(fullPath, { recursive: true, force: true });
        removed.push(entry.name);
      } catch {
        // 被占用时跳过，下次启动再清。
      }
    }
    return removed;
  }

  return { llmWorkspaceLimitBytes, ensureLlmWorkspaceRoot, refreshLlmWorkspaceState, cleanupExpiredWorkspaceEntries };
}
