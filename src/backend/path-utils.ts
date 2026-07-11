// 后端跨域路径值工具：只做规整与包含关系，不含 library/import 业务语义。

import { resolve, sep } from 'node:path';

export function pathKey(value: unknown): string {
  return resolve(String(value || '')).toLowerCase();
}

export function isSameOrChildPath(target: unknown, parent: unknown): boolean {
  const targetKey = pathKey(target);
  const parentKey = pathKey(parent);
  return targetKey === parentKey || targetKey.startsWith(`${parentKey}${sep}`);
}

export function normalizeRelativePath(value: unknown = ''): string {
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
