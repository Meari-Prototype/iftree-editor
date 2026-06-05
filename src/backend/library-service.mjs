import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

import {
  LIBRARY_NAVIGATION_DOC_ID,
  LIBRARY_NAVIGATION_DOC_TITLE
} from './virtual-docs.mjs';

function cleanPathPart(value = '') {
  return String(value || '').replace(/[\\/:*?"<>|]/g, '_').trim();
}

function normalizeRelativePath(value = '') {
  const text = String(value || '').replace(/\\/g, '/').trim();
  return text
    .split('/')
    .filter((part) => part && part !== '.')
    .map(cleanPathPart)
    .filter(Boolean)
    .join('/');
}

function ensureInside(root, target) {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${sep}`)) {
    throw new Error('Library path cannot escape the library folder');
  }
  return targetPath;
}

function clipText(value, limit = 100) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const size = Math.max(0, Number(limit) || 0);
  if (!size || text.length <= size) return text;
  return `${text.slice(0, Math.max(0, size - 3))}...`;
}

function compareEntries(left, right) {
  if (left.type !== right.type) return left.type === 'folder' ? -1 : 1;
  return left.name.localeCompare(right.name, 'zh-Hans-CN', { sensitivity: 'base', numeric: true });
}

function entryLabel(entry) {
  if (entry.type === 'folder') return `${entry.name}/`;
  const suffix = Number.isFinite(entry.size) ? ` [${entry.size} bytes]` : '';
  return `${entry.name}${suffix}`;
}

function treeToAscii(root, label = entryLabel) {
  const lines = [label(root)];
  function walk(children = [], prefix = '') {
    for (let index = 0; index < children.length; index += 1) {
      const entry = children[index];
      const isLast = index === children.length - 1;
      lines.push(`${prefix}${isLast ? '`-- ' : '|-- '}${label(entry)}`);
      if (entry.children?.length) walk(entry.children, `${prefix}${isLast ? '    ' : '|   '}`);
    }
  }
  walk(root.children || []);
  return lines.join('\n');
}

function includeSummary(payload = {}) {
  const include = Array.isArray(payload.include) ? payload.include : [];
  return include.includes('summary') || payload.includeSummary === true || payload.include_summary === true;
}

function docRelativePath(doc = {}) {
  return normalizeRelativePath(doc.sourcePath || doc.relativePath || doc.path || doc.source?.path || '');
}

function docSummary(doc = {}) {
  for (const key of ['summary', 'description', 'note']) {
    const value = String(doc[key] || doc.meta?.[key] || '').trim();
    if (value) return value;
  }
  return '';
}

const NAVIGATION_DOC_ID = LIBRARY_NAVIGATION_DOC_ID;
const NAVIGATION_TITLE = LIBRARY_NAVIGATION_DOC_TITLE;

function indexEntryLabel(node, options = {}) {
  const entry = node.libraryEntry || {};
  if (entry.type !== 'file') return node.address === '1' ? 'library/' : `${entry.name || node.text}/`;
  const textChars = Math.max(0, Number(entry.textChars) || 0);
  const textCharsSuffix = ` (${textChars}字)`;
  const semantic = entry.semantic || {};
  const semanticLabel = semantic.status
    ? ` [semantic:${semantic.status}${Number(semantic.vectorCount) > 0 ? ` vectors=${Number(semantic.vectorCount)}` : ''}]`
    : '';
  const summarySuffix = options.includeSummary && node.note ? ` summary=${clipText(node.note)}` : '';
  const idSuffix = options.uuid && entry.docId ? ` #${entry.docId}` : '';
  return `${entry.name || node.text}${idSuffix}${textCharsSuffix}${semanticLabel}${summarySuffix}`;
}

function importedDocsByPath(docs = []) {
  const byPath = new Map();
  for (const doc of docs) {
    const path = docRelativePath(doc);
    if (path && !byPath.has(path)) byPath.set(path, doc);
  }
  return byPath;
}

function docForEntry(entry = {}, docsByPath) {
  return docsByPath.get(normalizeRelativePath(entry.relativePath)) || null;
}

function navigationNode(entry, doc, address, parentId, id, options = {}) {
  const isFile = entry?.type === 'file';
  const docId = doc?.docId ?? doc?.id ?? null;
  const summary = options.includeSummary && doc ? docSummary(doc) : '';
  return {
    id,
    docId: NAVIGATION_DOC_ID,
    parentId,
    address,
    depth: address.split('-').length,
    sortOrder: Number(address.split('-').pop()) || 1,
    childCount: 0,
    nodeType: 'TEXT',
    title: '',
    text: isFile
      ? `${docId ? `打开文档：#${docId}` : '未导入原始文件'}\n${normalizeRelativePath(entry.relativePath)}`
      : String(entry?.name || NAVIGATION_TITLE),
    note: summary,
    libraryEntry: {
      type: entry?.type || 'folder',
      name: entry?.name || '',
      relativePath: normalizeRelativePath(entry?.relativePath || ''),
      extension: entry?.extension || '',
      size: entry?.size ?? null,
      imported: Boolean(docId),
      docId,
      textChars: Math.max(0, Number(doc?.meta?.textChars) || 0),
      semantic: doc?.meta?.semantic || null
    },
    children: []
  };
}

function flattenNavigationTree(root) {
  const rows = [];
  const stack = root ? [root] : [];
  while (stack.length > 0) {
    const node = stack.pop();
    rows.push(node);
    for (let index = (node.children || []).length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]);
    }
  }
  return rows;
}

function navigationStats(root) {
  const depths = new Set();
  let maxDepth = 1;
  for (const node of flattenNavigationTree(root)) {
    const depth = Number(node.depth) || 1;
    depths.add(depth);
    maxDepth = Math.max(maxDepth, depth);
  }
  return { maxDepth, depths: [...depths].sort((left, right) => left - right) };
}

function buildNavigationTree(rootEntry, docs = [], options = {}) {
  const docsByPath = importedDocsByPath(docs);
  let nextId = 1;
  function build(entry, address, parentId) {
    const isRoot = !parentId;
    const doc = entry?.type === 'file' ? docForEntry(entry, docsByPath) : null;
    if (entry?.type === 'file' && options.importedOnly === true && !doc) return null;
    const node = isRoot
      ? navigationNode({ type: 'folder', name: NAVIGATION_TITLE, relativePath: '', children: entry?.children || [] }, null, address, null, `tmp-library-nav-${nextId++}`, options)
      : navigationNode(entry, doc, address, parentId, `tmp-library-nav-${nextId++}`, options);
    let childIndex = 1;
    for (const child of entry?.children || []) {
      const childNode = build(child, `${address}-${childIndex}`, node.id);
      if (!childNode) continue;
      node.children.push(childNode);
      childIndex += 1;
    }
    node.childCount = node.children.length;
    return node;
  }
  return build(rootEntry, '1', null);
}

export function createLibraryService(rootPath) {
  const root = resolve(rootPath);

  function ensureRoot() {
    mkdirSync(root, { recursive: true });
    return root;
  }

  function fullPath(relativePath = '') {
    const normalized = normalizeRelativePath(relativePath);
    return ensureInside(ensureRoot(), join(root, normalized));
  }

  function entry(relativePath = '', depth = 0, options = {}) {
    const target = fullPath(relativePath);
    const stat = statSync(target);
    const name = relativePath ? relativePath.split('/').pop() : 'library';
    const item = {
      type: stat.isDirectory() ? 'folder' : 'file',
      name,
      relativePath,
      extension: stat.isDirectory() ? '' : extname(name).toLowerCase(),
      size: stat.isDirectory() ? null : stat.size
    };
    const maxDepth = options.maxDepth === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : (Number.isInteger(options.maxDepth) ? options.maxDepth : 2);
    if (item.type === 'folder' && depth < maxDepth) {
      const children = readdirSync(target, { withFileTypes: true })
        .map((dirent) => entry(normalizeRelativePath(join(relativePath, dirent.name)), depth + 1, options))
        .sort(compareEntries);
      const limit = Object.prototype.hasOwnProperty.call(options, 'limit') ? Math.floor(Number(options.limit) || 0) : 500;
      item.children = limit > 0 ? children.slice(0, limit) : children;
    }
    return item;
  }

  function search(query, options = {}) {
    const q = String(query || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 80));
    const results = [];
    function walk(relativePath = '') {
      if (results.length >= limit) return;
      const target = fullPath(relativePath);
      for (const dirent of readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))) {
        if (results.length >= limit) break;
        const childRelativePath = normalizeRelativePath(join(relativePath, dirent.name));
        const text = childRelativePath.toLowerCase();
        const stat = statSync(fullPath(childRelativePath));
        const item = {
          type: dirent.isDirectory() ? 'folder' : 'file',
          name: dirent.name,
          relativePath: childRelativePath,
          extension: dirent.isDirectory() ? '' : extname(dirent.name).toLowerCase(),
          size: dirent.isDirectory() ? null : stat.size
        };
        if (!q || text.includes(q) || dirent.name.toLowerCase().includes(q)) results.push(item);
        if (dirent.isDirectory()) walk(childRelativePath);
      }
    }
    walk('');
    return results;
  }

  function relativePathFor(filePath = '') {
    const target = resolve(String(filePath || ''));
    const rootPath = ensureRoot();
    if (target !== rootPath && !target.startsWith(`${rootPath}${sep}`)) return '';
    return normalizeRelativePath(relative(rootPath, target));
  }

  function query(payload = {}) {
    const queryText = String(payload.query ?? payload.q ?? '').trim();
    const maxDepth = Math.max(0, Math.min(12, Math.floor(Number(payload.depth ?? payload.maxDepth ?? payload.max_depth ?? 2) || 2)));
    const limit = Math.max(1, Math.min(2000, Math.floor(Number(payload.limit) || 500)));
    if (queryText) {
      const results = search(queryText, { limit });
      if (payload.format === 'ascii_tree' || payload.output === 'ascii_tree') {
        return {
          kind: 'library.getTree',
          format: 'ascii_tree',
          query: queryText,
          text: results.map((item) => `${item.type === 'folder' ? '[dir]' : '[file]'} ${clipText(item.relativePath, 160)}`).join('\n')
        };
      }
      return { kind: 'library.getTree', query: queryText, results };
    }
    const rootEntry = entry(normalizeRelativePath(payload.path || ''), 0, { maxDepth, limit });
    if (payload.format === 'ascii_tree' || payload.output === 'ascii_tree') {
      return {
        kind: 'library.getTree',
        format: 'ascii_tree',
        root: rootEntry.relativePath,
        text: treeToAscii(rootEntry)
      };
    }
    return { kind: 'library.getTree', root: rootEntry.relativePath, tree: rootEntry };
  }

  function index(payload = {}, docs = []) {
    const rootEntry = entry(normalizeRelativePath(payload.path || ''), 0, {
      maxDepth: Number.POSITIVE_INFINITY,
      limit: 0
    });
    const withSummary = includeSummary(payload);
    const withUuid = payload.uuid === true || payload.showUuid === true || payload.show_uuid === true;
    const tree = buildNavigationTree(rootEntry, docs, { includeSummary: withSummary, importedOnly: true });
    const count = flattenNavigationTree(tree).filter((node) => node.libraryEntry?.type === 'file').length;
    if (payload.format === 'json' || payload.output === 'json') {
      return { kind: 'library.index', root: '', count, tree };
    }
    return {
      kind: 'library.index',
      format: 'ascii_tree',
      root: '',
      count,
      text: treeToAscii(tree, (item) => indexEntryLabel(item, { includeSummary: withSummary, uuid: withUuid }))
    };
  }

  function navigation(payload = {}, docs = []) {
    const rootEntry = entry(normalizeRelativePath(payload.path || ''), 0, {
      maxDepth: Number.POSITIVE_INFINITY,
      limit: 0
    });
    const tree = buildNavigationTree(rootEntry, docs, {
      includeSummary: includeSummary(payload),
      importedOnly: true
    });
    const rows = flattenNavigationTree(tree);
    const idByAddress = {};
    for (const node of rows) idByAddress[node.address] = node.id;
    return {
      kind: 'library.navigation',
      virtual: true,
      virtualType: 'libraryNavigation',
      doc: {
        id: NAVIGATION_DOC_ID,
        title: NAVIGATION_TITLE,
        node_count: rows.length
      },
      tree,
      nodes: rows,
      idByAddress,
      treeDepthStats: navigationStats(tree),
      axioms: [],
      refs: [],
      history: []
    };
  }

  return {
    root,
    fullPath,
    relativePathFor,
    index,
    navigation,
    query
  };
}
