import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

import {
  LIBRARY_NAVIGATION_DOC_ID,
  LIBRARY_NAVIGATION_DOC_TITLE
} from './virtual-docs.js';
import { shouldIgnoreLibraryEntry } from './library-fs.js';

export type LibraryEntryType = 'folder' | 'file';

export interface LibraryEntry {
  type: LibraryEntryType;
  name: string;
  relativePath: string;
  extension: string;
  size: number | null;
  children?: LibraryEntry[];
  isSymlink?: boolean;
  symlinkTarget?: string | null;
  symlinkDangling?: boolean;
}

export interface SemanticStatus {
  status?: string;
  vectorCount?: number;
  nodeCount?: number;
  [extra: string]: unknown;
}

export interface ImportedDoc {
  docId?: unknown;
  id?: unknown;
  sourcePath?: string;
  relativePath?: string;
  path?: string;
  source?: { path?: string };
  summary?: string;
  description?: string;
  note?: string;
  hostAnchor?: string | null;
  meta?: {
    textChars?: unknown;
    semantic?: SemanticStatus | null;
    summary?: string;
    description?: string;
    note?: string;
    [extra: string]: unknown;
  };
  [extra: string]: unknown;
}

interface NavigationLibraryEntry {
  type: LibraryEntryType;
  name: string;
  relativePath: string;
  extension: string;
  size: number | null;
  imported: boolean;
  docId: unknown;
  textChars: number;
  semantic: SemanticStatus | null;
  isSymlink: boolean;
  symlinkTarget: string | null;
  symlinkDangling: boolean;
  hostAnchor: string | null;
}

interface NavigationNode {
  id: string;
  docId: unknown;
  parentId: string | null;
  address: string;
  depth: number;
  sortOrder: number;
  childCount: number;
  nodeType: 'TEXT';
  title: string;
  text: string;
  note: string;
  libraryEntry: NavigationLibraryEntry;
  children: NavigationNode[];
}

interface BuildNavigationOptions {
  includeSummary?: boolean;
  importedOnly?: boolean;
  uuid?: boolean;
}

interface EntryEnumerateOptions {
  maxDepth?: number;
  limit?: number;
  includeHidden?: boolean;
}

interface SearchOptions {
  limit?: number;
}

type LibraryQueryPayload = Record<string, unknown>;

interface NavigationStats {
  maxDepth: number;
  depths: number[];
}

function cleanPathPart(value: unknown = ''): string {
  return String(value || '').replace(/[\\/:*?"<>|]/g, '_').trim();
}

function normalizeRelativePath(value: unknown = ''): string {
  const text = String(value || '').replace(/\\/g, '/').trim();
  return text
    .split('/')
    .filter((part) => part && part !== '.')
    .map(cleanPathPart)
    .filter(Boolean)
    .join('/');
}

function ensureInside(root: string, target: string): string {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${sep}`)) {
    throw new Error('Library path cannot escape the library folder');
  }
  return targetPath;
}

function clipText(value: unknown, limit = 100): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const size = Math.max(0, Number(limit) || 0);
  if (!size || text.length <= size) return text;
  return `${text.slice(0, Math.max(0, size - 3))}...`;
}

function compareEntries(left: LibraryEntry, right: LibraryEntry): number {
  if (left.type !== right.type) return left.type === 'folder' ? -1 : 1;
  return left.name.localeCompare(right.name, 'zh-Hans-CN', { sensitivity: 'base', numeric: true });
}

function entryLabel(entry: LibraryEntry): string {
  if (entry.type === 'folder') return `${entry.name}/`;
  const suffix = Number.isFinite(entry.size) ? ` [${entry.size} bytes]` : '';
  return `${entry.name}${suffix}`;
}

interface AsciiNode {
  children?: AsciiNode[];
}

function treeToAscii<T extends AsciiNode>(root: T, label: (node: T) => string = entryLabel as unknown as (node: T) => string): string {
  const lines = [label(root)];
  function walk(children: T[] = [], prefix = ''): void {
    for (let index = 0; index < children.length; index += 1) {
      const entry = children[index];
      const isLast = index === children.length - 1;
      lines.push(`${prefix}${isLast ? '`-- ' : '|-- '}${label(entry)}`);
      if (entry.children?.length) walk(entry.children as T[], `${prefix}${isLast ? '    ' : '|   '}`);
    }
  }
  walk((root.children || []) as T[]);
  return lines.join('\n');
}

function includeSummary(payload: LibraryQueryPayload = {}): boolean {
  const include = Array.isArray(payload.include) ? payload.include : [];
  return include.includes('summary') || payload.includeSummary === true || payload.include_summary === true;
}

function docRelativePath(doc: ImportedDoc = {}): string {
  return normalizeRelativePath(doc.sourcePath || doc.relativePath || doc.path || doc.source?.path || '');
}

function docSummary(doc: ImportedDoc = {}): string {
  for (const key of ['summary', 'description', 'note'] as const) {
    const value = String(doc[key] || doc.meta?.[key] || '').trim();
    if (value) return value;
  }
  return '';
}

const NAVIGATION_DOC_ID = LIBRARY_NAVIGATION_DOC_ID;
const NAVIGATION_TITLE = LIBRARY_NAVIGATION_DOC_TITLE;

function normalizeAnchorPath(value: unknown = ''): string {
  return String(value || '').replace(/\\/g, '/').toLowerCase();
}

// 事件卷锚（symlink）校验标签：权威是 DB 里的 hostAnchor，与 symlink 实际 readlink 目标比对。
// 错位 / 悬空 / 无锚一律显式标出——忽略和没报错是两回事，绝不静默吞掉（projectneed 15-10）。
function symlinkAnchorLabel(entry: NavigationLibraryEntry): string {
  if (!entry.isSymlink) return '';
  const target = entry.symlinkTarget || '';
  const anchor = entry.hostAnchor || '';
  if (!anchor) return ' [!锚无 hostAnchor 可核对]';
  const anchorTarget = String(anchor).split('#')[0];
  if (normalizeAnchorPath(target) !== normalizeAnchorPath(anchorTarget)) {
    return ` [!锚错位 →${target || '?'}]`;
  }
  if (entry.symlinkDangling) return ` [!锚目标不可达 →${target}]`;
  return ' →锚';
}

function indexEntryLabel(node: NavigationNode, options: { includeSummary?: boolean; uuid?: boolean } = {}): string {
  const entry = node.libraryEntry;
  if (entry.type !== 'file') return node.address === '1' ? 'library/' : `${entry.name || node.text}/`;
  const textChars = Math.max(0, Number(entry.textChars) || 0);
  const textCharsSuffix = ` (${textChars}字)`;
  const semantic = entry.semantic || {};
  const vectorCount = Number(semantic.vectorCount) || 0;
  const nodeCount = Number(semantic.nodeCount) || 0;
  // 向量/节点 覆盖率（如 49/50），分子<分母即缺，比裸 vectors=N 直观、不误导。
  const coverage = (nodeCount > 0 || vectorCount > 0) ? ` ${vectorCount}/${nodeCount}` : '';
  const semanticLabel = semantic.status ? ` [semantic:${semantic.status}${coverage}]` : '';
  const summarySuffix = options.includeSummary && node.note ? ` summary=${clipText(node.note)}` : '';
  const idSuffix = options.uuid && entry.docId ? ` #${entry.docId}` : '';
  return `${entry.name || node.text}${idSuffix}${textCharsSuffix}${semanticLabel}${symlinkAnchorLabel(entry)}${summarySuffix}`;
}

function importedDocsByPath(docs: ImportedDoc[] = []): Map<string, ImportedDoc> {
  const byPath = new Map<string, ImportedDoc>();
  for (const doc of docs) {
    const path = docRelativePath(doc);
    if (path && !byPath.has(path)) byPath.set(path, doc);
  }
  return byPath;
}

function docForEntry(entry: LibraryEntry, docsByPath: Map<string, ImportedDoc>): ImportedDoc | null {
  return docsByPath.get(normalizeRelativePath(entry.relativePath)) || null;
}

function navigationNode(
  entry: LibraryEntry | null,
  doc: ImportedDoc | null,
  address: string,
  parentId: string | null,
  id: string,
  options: BuildNavigationOptions = {}
): NavigationNode {
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
      ? `${docId ? `打开文档：#${docId}` : '未导入原始文件'}\n${normalizeRelativePath(entry?.relativePath ?? '')}`
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
      semantic: doc?.meta?.semantic || null,
      isSymlink: entry?.isSymlink === true,
      symlinkTarget: entry?.symlinkTarget || null,
      symlinkDangling: entry?.symlinkDangling === true,
      hostAnchor: doc?.hostAnchor || null
    },
    children: []
  };
}

function flattenNavigationTree(root: NavigationNode | null): NavigationNode[] {
  const rows: NavigationNode[] = [];
  const stack: NavigationNode[] = root ? [root] : [];
  while (stack.length > 0) {
    const node = stack.pop()!;
    rows.push(node);
    for (let index = (node.children || []).length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]);
    }
  }
  return rows;
}

function navigationStats(root: NavigationNode | null): NavigationStats {
  const depths = new Set<number>();
  let maxDepth = 1;
  for (const node of flattenNavigationTree(root)) {
    const depth = Number(node.depth) || 1;
    depths.add(depth);
    maxDepth = Math.max(maxDepth, depth);
  }
  return { maxDepth, depths: [...depths].sort((left, right) => left - right) };
}

function buildNavigationTree(rootEntry: LibraryEntry, docs: ImportedDoc[] = [], options: BuildNavigationOptions = {}): NavigationNode | null {
  const docsByPath = importedDocsByPath(docs);
  let nextId = 1;
  function build(entry: LibraryEntry | null, address: string, parentId: string | null): NavigationNode | null {
    const isRoot = !parentId;
    const doc = entry?.type === 'file' ? docForEntry(entry, docsByPath) : null;
    if (entry?.type === 'file' && options.importedOnly === true && !doc) return null;
    const node = isRoot
      ? navigationNode(
          { type: 'folder', name: NAVIGATION_TITLE, relativePath: '', extension: '', size: null, children: entry?.children || [] },
          null,
          address,
          null,
          `tmp-library-nav-${nextId++}`,
          options
        )
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

export interface LibraryService {
  root: string;
  fullPath: (relativePath?: string) => string;
  relativePathFor: (filePath?: string) => string;
  index: (payload?: LibraryQueryPayload, docs?: ImportedDoc[]) => Record<string, unknown>;
  navigation: (payload?: LibraryQueryPayload, docs?: ImportedDoc[]) => Record<string, unknown>;
  query: (payload?: LibraryQueryPayload) => Record<string, unknown>;
}

export function createLibraryService(rootPath: string): LibraryService {
  const root = resolve(rootPath);

  function ensureRoot(): string {
    mkdirSync(root, { recursive: true });
    return root;
  }

  function fullPath(relativePath: string = ''): string {
    const normalized = normalizeRelativePath(relativePath);
    return ensureInside(ensureRoot(), join(root, normalized));
  }

  function entry(relativePath: string = '', depth: number = 0, options: EntryEnumerateOptions = {}): LibraryEntry {
    const target = fullPath(relativePath);
    const linkStat = lstatSync(target);
    const isSymlink = linkStat.isSymbolicLink();
    // 事件卷锚是 symlink：不跟随目标 stat，避免目标悬空时 statSync 抛错把整树枚举带崩。
    const stat = isSymlink ? linkStat : statSync(target);
    const name = relativePath ? relativePath.split('/').pop() || '' : 'library';
    const isFolder = !isSymlink && stat.isDirectory();
    const item: LibraryEntry = {
      type: isFolder ? 'folder' : 'file',
      name,
      relativePath,
      extension: isFolder ? '' : extname(name).toLowerCase(),
      size: isFolder || isSymlink ? null : stat.size
    };
    if (isSymlink) {
      item.isSymlink = true;
      try {
        item.symlinkTarget = readlinkSync(target);
        item.symlinkDangling = !existsSync(target);
      } catch {
        item.symlinkTarget = null;
        item.symlinkDangling = true;
      }
    }
    const maxDepth = options.maxDepth === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : (Number.isInteger(options.maxDepth) ? (options.maxDepth as number) : 2);
    if (item.type === 'folder' && depth < maxDepth) {
      const children = readdirSync(target, { withFileTypes: true })
        .filter((dirent) => !shouldIgnoreLibraryEntry(dirent.name, { includeHidden: options.includeHidden === true }))
        .map((dirent) => entry(normalizeRelativePath(join(relativePath, dirent.name)), depth + 1, options))
        .sort(compareEntries);
      const limit = Object.prototype.hasOwnProperty.call(options, 'limit') ? Math.floor(Number(options.limit) || 0) : 500;
      item.children = limit > 0 ? children.slice(0, limit) : children;
    }
    return item;
  }

  interface SearchResult {
    type: LibraryEntryType;
    name: string;
    relativePath: string;
    extension: string;
    size: number | null;
  }

  function search(query: string, options: SearchOptions = {}): SearchResult[] {
    const q = String(query || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 80));
    const results: SearchResult[] = [];
    function walk(relativePath: string = ''): void {
      if (results.length >= limit) return;
      const target = fullPath(relativePath);
      for (const dirent of readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))) {
        if (results.length >= limit) break;
        const childRelativePath = normalizeRelativePath(join(relativePath, dirent.name));
        const text = childRelativePath.toLowerCase();
        const stat = statSync(fullPath(childRelativePath));
        const item: SearchResult = {
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

  function relativePathFor(filePath: string = ''): string {
    const target = resolve(String(filePath || ''));
    const rootPath = ensureRoot();
    if (target !== rootPath && !target.startsWith(`${rootPath}${sep}`)) return '';
    return normalizeRelativePath(relative(rootPath, target));
  }

  function query(payload: LibraryQueryPayload = {}): Record<string, unknown> {
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
    const rootEntry = entry(normalizeRelativePath(payload.path || ''), 0, { maxDepth, limit, includeHidden: true });
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

  function index(payload: LibraryQueryPayload = {}, docs: ImportedDoc[] = []): Record<string, unknown> {
    const rootEntry = entry(normalizeRelativePath(payload.path || ''), 0, {
      maxDepth: Number.POSITIVE_INFINITY,
      limit: 0,
      includeHidden: payload.includeHidden === true || payload.include_hidden === true
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
      text: tree
        ? treeToAscii(tree, (item: NavigationNode) => indexEntryLabel(item, { includeSummary: withSummary, uuid: withUuid }))
        : ''
    };
  }

  function navigation(payload: LibraryQueryPayload = {}, docs: ImportedDoc[] = []): Record<string, unknown> {
    const rootEntry = entry(normalizeRelativePath(payload.path || ''), 0, {
      maxDepth: Number.POSITIVE_INFINITY,
      limit: 0,
      includeHidden: true
    });
    const tree = buildNavigationTree(rootEntry, docs, {
      includeSummary: includeSummary(payload),
      importedOnly: true
    });
    const rows = flattenNavigationTree(tree);
    const idByAddress: Record<string, string> = {};
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
