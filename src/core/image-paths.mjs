import { existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vectors']);

export function resolveMarkdownImageUrl({
  src,
  docMeta = {},
  appHome,
  searchRoots = [],
  fileExists = existsSync
}) {
  const value = cleanImageSrc(src);
  if (!value) return src || '';
  if (isUrlLike(value)) return value;

  const resolved = resolveMarkdownImagePath({
    src: value,
    docMeta,
    appHome,
    searchRoots,
    fileExists
  });

  return resolved ? pathToFileURL(resolved).href : value;
}

export function resolveMarkdownImagePath({
  src,
  docMeta = {},
  appHome,
  searchRoots = [],
  fileExists = existsSync
}) {
  const value = cleanImageSrc(src);
  if (!value || isUrlLike(value)) return null;

  for (const candidate of imagePathCandidates({ src: value, docMeta, appHome })) {
    if (fileExists(candidate)) return candidate;
  }

  const found = findRelativeImagePath(value, searchRoots, fileExists);
  return found || null;
}

export function imagePathCandidates({ src, docMeta = {}, appHome }) {
  const value = cleanImageSrc(src);
  if (!value || isUrlLike(value)) return [];

  if (isFilePathAbsolute(value)) return [normalize(value)];

  const candidates = [];
  const normalized = normalize(value);
  if (appHome && startsWithPathSegment(normalized, 'assets')) {
    candidates.push(resolve(appHome, normalized));
  }

  const meta = normalizeDocMeta(docMeta);
  if (meta.sourcePath) {
    candidates.push(resolve(dirname(meta.sourcePath), normalized));
  }

  return unique(candidates);
}

export function normalizeDocMeta(meta) {
  if (!meta) return {};
  if (typeof meta === 'object') return meta;
  try {
    const parsed = JSON.parse(String(meta));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function workspaceSearchRoots(sourcePath) {
  if (!sourcePath) return [];

  const normalized = normalize(sourcePath);
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  const roots = [];

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index].toLowerCase() !== 'workspace') continue;
    const prefix = normalized.startsWith('\\\\') ? '\\\\' : '';
    const root = prefix + parts.slice(0, index + 1).join('\\');
    roots.push(root);
    break;
  }

  roots.push(dirname(normalized));
  return unique(roots);
}

function findRelativeImagePath(src, searchRoots, fileExists) {
  if (!searchRoots?.length) return null;
  const relative = normalize(src);
  if (isFilePathAbsolute(relative) || relative.startsWith('..')) return null;

  for (const root of unique(searchRoots)) {
    const direct = resolve(root, relative);
    if (fileExists(direct)) return direct;
    const found = findPathBySuffix(root, relative);
    if (found) return found;
  }

  return null;
}

function findPathBySuffix(root, relative) {
  const normalizedSuffix = normalize(relative).toLowerCase();
  const stack = [root];
  let visited = 0;

  while (stack.length > 0 && visited < 120000) {
    const current = stack.pop();
    visited += 1;

    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (normalize(full).toLowerCase().endsWith(normalizedSuffix)) return full;
    }
  }

  return null;
}

function cleanImageSrc(src) {
  const trimmed = String(src || '').trim();
  if (!trimmed) return '';
  if (isUrlLike(trimmed)) return trimmed;
  try {
    return decodeURI(trimmed);
  } catch {
    return trimmed;
  }
}

function isUrlLike(value) {
  if (isFilePathAbsolute(value)) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function isFilePathAbsolute(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value) || isAbsolute(value);
}

function startsWithPathSegment(value, segment) {
  const first = value.split(/[\\/]+/).find(Boolean);
  return first?.toLowerCase() === segment.toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
