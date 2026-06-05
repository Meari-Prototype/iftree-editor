import { parseJsonObject, compareNodeAddress } from '../shared.mjs';
import {
  normalizeStableId,
  normalizeStableIdBatch
} from './ids.mjs';

const DEFAULT_DOC_FOLDER_NAME = '新建文件夹';
const MAX_DOC_FOLDER_NAME_LENGTH = 100;

export function normalizeDocFolderName(value) {
  const trimmed = String(value ?? '').trim();
  const source = trimmed || DEFAULT_DOC_FOLDER_NAME;
  return Array.from(source).slice(0, MAX_DOC_FOLDER_NAME_LENGTH).join('');
}

function normalizeIdArray(value) {
  const source = Array.isArray(value) ? value : [];
  const ids = [];
  const seen = new Set();
  for (const item of source) {
    const id = normalizeStableId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function normalizeTreeViewState(value) {
  const raw = typeof value === 'string' ? parseJsonObject(value) : (value || {});
  const depthLimit = Math.max(1, Math.floor(Number(raw.depthLimit) || 1));
  return JSON.stringify({
    depthLimit,
    collapsedNodeIds: normalizeIdArray(raw.collapsedNodeIds),
    expandedNodeIds: normalizeIdArray(raw.expandedNodeIds),
    outlineCollapsedNodeIds: normalizeIdArray(raw.outlineCollapsedNodeIds)
  });
}

export function normalizeSourcePosition(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function recordSentenceIndexes(record, fallbackIndex = null) {
  const raw = Array.isArray(record?.indexes)
    ? record.indexes
    : (record?.index != null ? [record.index] : (fallbackIndex != null ? [fallbackIndex] : []));
  return [...new Set(raw
    .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0))];
}

export function parentAddressOf(address) {
  const parts = String(address || '').split('-').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join('-') : '';
}

export function areRecordsAddressSorted(records) {
  for (let index = 1; index < records.length; index += 1) {
    if (compareNodeAddress(records[index - 1], records[index]) > 0) return false;
  }
  return true;
}

export function normalizePositiveNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizePositiveCount(value) {
  if (value == null || value === '') return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizePositiveId(value) {
  return normalizeStableId(value);
}

export function normalizeNodeSizeMode(value) {
  return value === 'manual' ? 'manual' : 'auto';
}

export function normalizeNullableText(value) {
  if (value == null || value === '') return null;
  return String(value);
}

export function normalizeNodeIdBatch(value, max = 500) {
  return normalizeStableIdBatch(value, max);
}

export function addressSortKey(address) {
  return String(address || '')
    .split('-')
    .filter(Boolean)
    .map((part) => String(Number(part)).padStart(10, '0'))
    .join('-');
}

export function mergePdfCharRects(chars) {
  const rects = [];
  for (const item of chars || []) {
    const pageNumber = Number(item.page_number);
    const x0 = Number(item.x0);
    const y0 = Number(item.y0);
    const x1 = Number(item.x1);
    const y1 = Number(item.y1);
    if (![pageNumber, x0, y0, x1, y1].every(Number.isFinite)) continue;
    const last = rects.at(-1);
    const height = Math.max(1, y1 - y0);
    if (
      last &&
      last.page_number === pageNumber &&
      Math.abs(last.y0 - y0) <= Math.max(4, height * 0.35) &&
      x0 <= last.x1 + Math.max(8, height * 0.8)
    ) {
      last.x0 = Math.min(last.x0, x0);
      last.y0 = Math.min(last.y0, y0);
      last.x1 = Math.max(last.x1, x1);
      last.y1 = Math.max(last.y1, y1);
      continue;
    }
    rects.push({ page_number: pageNumber, x0, y0, x1, y1 });
  }
  return rects;
}

export function patchValue(patch, snakeKey, camelKey, fallback) {
  if (Object.prototype.hasOwnProperty.call(patch, snakeKey)) return patch[snakeKey];
  if (Object.prototype.hasOwnProperty.call(patch, camelKey)) return patch[camelKey];
  return fallback;
}

export function hasPatchValue(patch, snakeKey, camelKey) {
  return Object.prototype.hasOwnProperty.call(patch, snakeKey) ||
    Object.prototype.hasOwnProperty.call(patch, camelKey);
}
