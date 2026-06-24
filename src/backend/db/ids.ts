// @ts-nocheck
import {
  v7 as uuidv7,
  validate as validateUuid,
  version as uuidVersion
} from 'uuid';

export function newStableId() {
  return uuidv7();
}

export function isStableId(value) {
  if (typeof value !== 'string') return false;
  return validateUuid(value) && uuidVersion(value) === 7;
}

export function normalizeStableId(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? String(value) : fallback;
  }
  const text = String(value).trim();
  if (!text) return fallback;
  const numeric = Number(text);
  if (Number.isInteger(numeric) && numeric > 0 && String(numeric) === text) return text;
  return isStableId(text) ? text : fallback;
}

export function requireStableId(value, label = 'id') {
  const id = normalizeStableId(value);
  if (!id) throw new Error(`${label} is required`);
  return id;
}

export function sameStableId(left, right) {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return String(left) === String(right);
}

export function compareStableIds(left, right) {
  return String(left || '').localeCompare(String(right || ''), undefined, { numeric: true });
}

export function normalizeStableIdBatch(value, max = 500) {
  const ids = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const id = normalizeStableId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= max) break;
  }
  return ids;
}
