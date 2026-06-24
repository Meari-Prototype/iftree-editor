import { existsSync, readdirSync, type Dirent } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vectors']);

interface DocMeta {
  sourcePath?: string;
  [key: string]: unknown;
}

interface ImageResolveOptions {
  src: unknown;
  docMeta?: DocMeta | string;
  appHome?: string;
  searchRoots?: string[];
  fileExists?: (path: string) => boolean;
}

export function resolveMarkdownImageUrl({ src, docMeta = {}, appHome, searchRoots = [], fileExists = existsSync }: ImageResolveOptions): string {
  const value = cleanImageSrc(src);
  if (!value) return src as string || '';
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

export function resolveMarkdownImagePath({ src, docMeta = {}, appHome, searchRoots = [], fileExists = existsSync }: ImageResolveOptions): string | null {
  const value = cleanImageSrc(src);
  if (!value || isUrlLike(value)) return null;

  for (const candidate of imagePathCandidates({ src: value, docMeta, appHome })) {
    if (fileExists(candidate)) return candidate;
  }

  const found = findRelativeImagePath(value, searchRoots, fileExists);
  return found || null;
}

export function imagePathCandidates({ src, docMeta = {}, appHome }: { src: unknown; docMeta?: DocMeta | string; appHome?: string }): string[] {
  const value = cleanImageSrc(src);
  if (!value || isUrlLike(value)) return [];

  if (isFilePathAbsolute(value)) return [normalize(value)];

  const candidates: string[] = [];
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

export function normalizeDocMeta(meta: DocMeta | string | null | undefined): DocMeta {
  if (!meta) return {};
  if (typeof meta === 'object') return meta;
  try {
    const parsed = JSON.parse(String(meta));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function workspaceSearchRoots(sourcePath: unknown): string[] {
  if (!sourcePath) return [];

  const normalized = normalize(String(sourcePath));
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  const roots: string[] = [];

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

function findRelativeImagePath(src: string, searchRoots: string[], fileExists: (path: string) => boolean): string | null {
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

function findPathBySuffix(root: string, relative: string): string | null {
  const normalizedSuffix = normalize(relative).toLowerCase();
  const stack: string[] = [root];
  let visited = 0;

  while (stack.length > 0 && visited < 120000) {
    const current = stack.pop()!;
    visited += 1;

    let entries: Dirent[];
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

function cleanImageSrc(src: unknown): string {
  const trimmed = String(src || '').trim();
  if (!trimmed) return '';
  if (isUrlLike(trimmed)) return trimmed;
  try {
    return decodeURI(trimmed);
  } catch {
    return trimmed;
  }
}

function isUrlLike(value: string): boolean {
  if (isFilePathAbsolute(value)) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function isFilePathAbsolute(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value) || isAbsolute(value);
}

function startsWithPathSegment(value: string, segment: string): boolean {
  const first = value.split(/[\\/]+/).find(Boolean);
  return first?.toLowerCase() === segment.toLowerCase();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
