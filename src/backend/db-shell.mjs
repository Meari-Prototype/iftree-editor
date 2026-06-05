import { normalizeStableId } from './db/ids.mjs';
import { normalizeNodeType, nodeTypeDisplayLabel } from '../core/node-model.mjs';

function cleanLine(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clip(value = '', limit = 80) {
  const text = cleanLine(value);
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

const READ_SUBTREE_TEXT_LIMIT = 10000;

function normalizeShellDocId(value, fallback = null) {
  return normalizeStableId(value, fallback);
}

function parseValue(value) {
  const raw = String(value ?? '').trim();
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

function normalizeArgv(argv = []) {
  const source = Array.isArray(argv) ? argv.map((item) => String(item)) : [];
  return source[0] === 'db' ? source.slice(1) : source;
}

function parseFlags(argv = []) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name === 'scope') {
      const docId = argv[index + 1];
      const address = argv[index + 2];
      if (!docId || !address || docId.startsWith('--') || address.startsWith('--')) {
        throw new Error('db --scope requires <doc_id> <node_address>');
      }
      flags.scopeDocId = parseValue(docId);
      flags.scopeAddress = address;
      index += 2;
      continue;
    }
    if (name === 'depth' || name === 'limit' || name === 'timeout-ms' || name === 'char-limit') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`db --${name} requires a value`);
      flags[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = parseValue(value);
      index += 1;
      continue;
    }
    if (name === 'summary' || name === 'tag') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        flags[name] = true;
        continue;
      }
      flags[name] = value;
      index += 1;
      continue;
    }
    if (['branch', 'base', 'owner', 'history', 'source-branch', 'target-branch', 'target-base', 'entry-id', 'entry-index', 'mode', 'doc-id', 'session-id', 'set', 'insert', 'cwd', 'at'].includes(name)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`db --${name} requires a value`);
      flags[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = parseValue(value);
      index += 1;
      continue;
    }
    if (name === 'folder') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('db --folder requires a library relative path');
      flags.folder = value;
      index += 1;
      continue;
    }
    if (name === 'from' || name === 'to') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`db --${name} requires a value`);
      flags[name] = value;
      index += 1;
      continue;
    }
    if (['tags', 'meta', 'node', 'source', 'axioms', 'links', 'neighbors', 'blame', 'all-docs', 'all', 'or', 'semantic', 'yes', 'detail', 'delete', 'uuid'].includes(name)) {
      flags[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true;
      continue;
    }
    if (name === 'fuzzy') throw new Error('db find --fuzzy is not supported; use db find --tags to expand related entities.');
    throw new Error(`Unknown db option: --${name}`);
  }
  return { flags, positional };
}

function parseLooseFlags(argv = [], valueFlagNames = []) {
  const flags = {};
  const positional = [];
  const valueFlags = new Set(valueFlagNames);
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--') {
      positional.push(...argv.slice(index + 1).map((item) => String(item)));
      break;
    }
    const name = token.startsWith('--') ? token.slice(2) : '';
    if (valueFlags.has(name)) {
      const value = argv[index + 1];
      if (!value || String(value).startsWith('--')) throw new Error(`db --${name} requires a value`);
      flags[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = parseValue(value);
      index += 1;
      continue;
    }
    positional.push(token);
  }
  return { flags, positional };
}

function currentDocIdFrom(context = {}) {
  return normalizeShellDocId(context.currentDocId ?? context.docId ?? process.env.IFTREE_CURRENT_DOC_ID, null);
}

function docScope(flags = {}, context = {}, options = {}) {
  if (flags.allDocs) return { allDocs: true };
  const scopedDocId = normalizeShellDocId(flags.scopeDocId, null);
  if (scopedDocId) return { docId: scopedDocId, scopeDocId: scopedDocId, scopeAddress: flags.scopeAddress || '' };
  const currentDocId = currentDocIdFrom(context);
  if (currentDocId) return { docId: currentDocId };
  if (options.allowMissing) return {};
  throw new Error('db command requires current document id, --scope, or --all-docs');
}

function nodeTitle(node = {}) {
  return clip(node.title || node.textPreview || node.text || '', 80);
}

function nodeTypeLabel(node = {}) {
  return nodeTypeDisplayLabel(node.type || node.nodeType || node.node_type || 'TEXT');
}

function nodeTrustLabel(node = {}) {
  const trust = node.tags?.trustLevel ?? node.trustLevel ?? node.trust_level ?? null;
  return `trust:${trust == null || trust === '' ? 'null' : cleanLine(trust)}`;
}

function docDisplayLabel(doc = {}, options = {}) {
  const docId = doc.docId ?? doc.doc_id ?? doc.id ?? options.docId ?? '';
  if (options.uuid) return docId ? `doc:${docId}` : '';
  return cleanLine(doc.title || doc.docTitle || doc.doc_title || doc.name || options.title || '') || (docId ? `doc:${docId}` : '');
}

function formatNodeLine(item = {}, options = {}) {
  const node = item.node || item;
  const docId = item.doc?.docId ?? item.doc?.id ?? node.docId ?? node.doc_id;
  const label = docDisplayLabel(item.doc || node.doc || {
    docId,
    title: options.docLabel ?? item.docTitle ?? item.doc_title ?? node.docTitle ?? node.doc_title
  }, { uuid: options.uuid, docId });
  const score = options.score ?? node.score ?? item.score ?? null;
  const parts = [label, node.address || '', nodeTypeLabel(node), nodeTitle(node)];
  if (score != null) parts.push(Number(score).toFixed(2));
  return parts.filter(Boolean).join(' ');
}

function formatEntityLabel(entity = {}, options = {}) {
  const literal = cleanLine(entity.literal || entity.term || '');
  const label = docDisplayLabel(entity.doc || entity, {
    uuid: options.uuid,
    docId: entity.docId ?? entity.doc_id
  });
  return literal ? `${literal}${label ? `(${label})` : ''}` : '';
}

function formatEntityTags(rows = [], options = {}) {
  const synonym = [];
  const related = [];
  for (const row of rows) {
    const label = formatEntityLabel(row.entity || row, options);
    if (!label) continue;
    if (row.relation === 'synonym') synonym.push(label);
    else related.push(label);
  }
  return [
    synonym.length ? `同义: ${synonym.join('；')}` : '',
    related.length ? `相关: ${related.join('；')}` : ''
  ].filter(Boolean).join('\n');
}

function formatHistoryLine(row = {}) {
  const id = row.id ?? row.historyId ?? row.history_id ?? '';
  const commit = row.commit_id ?? row.commitId ?? '';
  const savedAt = row.saved_at ?? row.savedAt ?? row.committed_at ?? row.committedAt ?? '';
  const summary = cleanLine(row.summary || '');
  const parts = [`history:${id}`];
  if (commit) parts.push(`commit:${commit}`);
  if (savedAt) parts.push(savedAt);
  if (summary) parts.push(summary);
  return parts.filter(Boolean).join(' ');
}

function historyRefSpec(flags = {}, positional = []) {
  const flaggedDocId = normalizeShellDocId(flags.docId ?? positional[0], null);
  if (flags.history) return { kind: 'id', value: flags.history, docId: flaggedDocId };
  if (flags.at) return { kind: 'saved_at', value: flags.at, docId: flaggedDocId };
  if (flags.tag && flags.tag !== true) return { kind: 'summary', value: flags.tag, docId: flaggedDocId };
  const ref = String(positional[0] || '').trim();
  const docId = normalizeShellDocId(flags.docId ?? positional[1], null);
  if (!ref) return { kind: '', value: '', docId };
  if (/^\d+$/.test(ref)) return { kind: 'id', value: ref, docId };
  return { kind: 'saved_at_or_summary', value: ref, docId };
}

async function resolveHistoryRef(database, spec = {}, options = {}) {
  const value = String(spec.value ?? '').trim();
  if (!value) throw new Error('history ref requires history id, saved_at, or tag');

  const clauses = [];
  const params = {};
  if (spec.kind === 'id') {
    clauses.push('id = @value');
    params.value = Number(value);
  } else if (spec.kind === 'saved_at') {
    clauses.push('saved_at = @value');
    params.value = value;
  } else if (spec.kind === 'summary') {
    clauses.push('summary = @value');
    params.value = value;
  } else if (spec.kind === 'saved_at_or_summary') {
    clauses.push('(saved_at = @value OR summary = @value)');
    params.value = value;
  } else {
    throw new Error(`db restore unsupported ref kind: ${spec.kind || '(empty)'}`);
  }
  if (spec.docId) {
    clauses.push('doc_id = @docId');
    params.docId = spec.docId;
  }
  const columns = options.includeDiff
    ? 'id, doc_id, commit_id, saved_at, summary, diff'
    : 'id, doc_id, commit_id, saved_at, summary';
  const sql = `
    SELECT ${columns}
    FROM save_history
    WHERE ${clauses.join(' AND ')}
    ORDER BY saved_at DESC, id DESC
  `;
  const result = await database.run({
    operation: 'read',
    payload: { action: 'debug.sql', sql, params, limit: 2 }
  }, 'read');
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  if (rows.length === 0) {
    const scope = spec.docId ? ` in doc ${spec.docId}` : '';
    throw new Error(`db restore history ref not found${scope}: ${value}`);
  }
  if (rows.length > 1) {
    throw new Error(`db restore history ref is ambiguous: ${value}; pass doc_id or history id`);
  }
  return rows[0];
}

function historyRefFromReadAt(ref, docId) {
  const value = String(ref || '').trim();
  if (/^\d+$/.test(value)) return { kind: 'id', value, docId };
  return { kind: 'saved_at_or_summary', value, docId };
}

function formatAxiomLine(row = {}) {
  const label = cleanLine(row.label || row.address || row.id || '');
  const status = cleanLine(row.status || '');
  const content = clip(row.content || row.text || row.node_title || row.nodeTitle || '', 160);
  return [label, status ? `[${status}]` : '', content].filter(Boolean).join(' ');
}

function formatRefLine(row = {}) {
  const source = `${row.source_type || row.sourceType || '?'}:${row.source_id ?? row.sourceId ?? '?'}`;
  const target = `${row.target_type || row.targetType || '?'}:${row.target_id ?? row.targetId ?? '?'}`;
  const kind = cleanLine(row.ref_kind || row.refKind || row.kind || '');
  const note = clip(row.note || '', 120);
  return [`${source} -> ${target}`, kind ? `[${kind}]` : '', note].filter(Boolean).join(' ');
}

function valueOrNull(value) {
  return value === null || value === undefined || value === '' ? 'null' : String(value);
}

function formatSourceSpanLine(row = {}) {
  const id = row.id ?? row.spanId ?? row.span_id ?? '';
  const sentence = row.sentence_index ?? row.sentenceIndex ?? '';
  const start = row.absolute_start_offset ?? row.absoluteStartOffset ?? row.start_offset ?? row.startOffset ?? '';
  const end = row.absolute_end_offset ?? row.absoluteEndOffset ?? row.end_offset ?? row.endOffset ?? '';
  const parts = [];
  if (id !== '') parts.push(`span:${id}`);
  if (sentence !== '') parts.push(`sentence:${sentence}`);
  if (start !== '' || end !== '') parts.push(`offsets:${valueOrNull(start)}-${valueOrNull(end)}`);
  return parts.join(' ') || cleanLine(JSON.stringify(row));
}

function formatDiffEntry(entry = {}) {
  const node = entry.node_id ?? entry.nodeId ?? entry.id ?? '';
  const field = entry.field || entry.kind || entry.action || '';
  const oldValue = clip(entry.old ?? entry.before ?? '', 80);
  const newValue = clip(entry.new ?? entry.after ?? '', 80);
  if (oldValue || newValue) return [`node:${node}`, field, `${oldValue} -> ${newValue}`].filter(Boolean).join(' ');
  return cleanLine(JSON.stringify(entry));
}

function parseBranchEntryCounts(branch = {}) {
  try {
    const diff = JSON.parse(branch.diff || '{}');
    const entries = Array.isArray(diff.entries) ? diff.entries : [];
    let active = 0;
    let undone = 0;
    for (const entry of entries) {
      if (entry?.status === 'undone') undone += 1;
      else active += 1;
    }
    return { active, undone };
  } catch {
    return { active: 0, undone: 0 };
  }
}

function formatBranchLine(branch = {}) {
  const counts = parseBranchEntryCounts(branch);
  return [
    `branch:${branch.id}`,
    `doc:${branch.base_doc_id}`,
    `owner:${branch.owner || ''}`,
    `active:${counts.active}`,
    `undone:${counts.undone}`,
    branch.updated_at || ''
  ].filter(Boolean).join('\t');
}

function selectedBranch(context = {}) {
  return context.shellState?.selectedBranch || {};
}

function updateSelectedBranch(context = {}, next = {}) {
  if (!context.shellState) context.shellState = {};
  context.shellState.selectedBranch = {
    branchId: next.branchId ?? null,
    baseDocId: next.baseDocId ?? null,
    owner: next.owner ?? null
  };
  return context.shellState.selectedBranch;
}

function branchTarget(flags = {}, context = {}, fallbackBaseDocId = null) {
  const selected = selectedBranch(context);
  const baseDocId = normalizeShellDocId(fallbackBaseDocId, null);
  return {
    branchId: flags.branch ?? selected.branchId ?? null,
    baseDocId: flags.base ?? baseDocId ?? selected.baseDocId ?? null,
    owner: flags.owner ? String(flags.owner) : (selected.owner || null)
  };
}

function branchTargetLabel(target = {}) {
  return [
    target.branchId ? `branch:${target.branchId}` : '',
    target.baseDocId ? `doc:${target.baseDocId}` : '',
    target.owner ? `owner:${target.owner}` : ''
  ].filter(Boolean).join(' ');
}

function contextFunction(context = {}, name) {
  const fn = context[name];
  if (typeof fn !== 'function') throw new Error(`db ${name} context is not available`);
  return fn;
}

function parseJsonObjectArgument(value = '', fallback = {}) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('db edit json_payload must be a JSON object');
  }
  return parsed;
}

function normalizeEditSetField(value = '') {
  const field = String(value || '').trim();
  if (field === 'text') return 'text';
  if (field === 'title' || field === 'node_title' || field === 'nodeTitle') return 'node_title';
  if (field === 'note' || field === 'node_note' || field === 'nodeNote') return 'node_note';
  if (field === 'type' || field === 'node_type' || field === 'nodeType') return 'node_type';
  if (field === 'trust_level' || field === 'trustLevel') return 'trust_level';
  throw new Error(`db edit --set unsupported field: ${field || '(empty)'}`);
}

function requireEditNodeArgs(positional = [], action = 'edit') {
  const docId = normalizeShellDocId(positional[0], null);
  const address = String(positional[1] || '').trim();
  if (!docId || !address) throw new Error(`db edit ${action} requires <doc_id> <address>`);
  return { docId, address };
}

async function readEditTargetNode(database, docId, address) {
  const result = await database.run({
    operation: 'read',
    payload: { action: 'content.getNode', docId, address, detail: 'summary' }
  }, 'read');
  const node = result?.node || null;
  if (!node?.id) throw new Error(`db edit target not found: doc ${docId} ${address}`);
  return node;
}

function editBranchWriteTarget(flags = {}, context = {}, docId = null) {
  const target = branchTarget(flags, context);
  if (target.baseDocId && docId && String(target.baseDocId) !== String(docId)) {
    throw new Error('db edit target doc_id must match selected --base doc_id');
  }
  return {
    owner: target.owner || 'llm',
    baseDocId: target.baseDocId || docId
  };
}

async function runFriendlyEdit(database, flags = {}, positional = [], context = {}) {
  if (flags.set) {
    const { docId, address } = requireEditNodeArgs(positional, '--set');
    const field = normalizeEditSetField(flags.set);
    const rawValue = positional.slice(2).join(' ');
    if (rawValue === '') throw new Error('db edit --set requires value');
    const value = field === 'node_type' ? normalizeNodeType(rawValue) : rawValue;
    const node = await readEditTargetNode(database, docId, address);
    const target = editBranchWriteTarget(flags, context, docId);
    const payload = {
      action: 'node.update',
      nodeId: node.id,
      patch: { [field]: value },
      editBranchOwner: target.owner,
      editBranchBaseDocId: target.baseDocId
    };
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_edit', text: JSON.stringify(result, null, 2) };
  }

  if (flags.delete) {
    const { docId, address } = requireEditNodeArgs(positional, '--delete');
    const node = await readEditTargetNode(database, docId, address);
    const target = editBranchWriteTarget(flags, context, docId);
    const payload = {
      action: 'node.delete',
      nodeId: node.id,
      editBranchOwner: target.owner,
      editBranchBaseDocId: target.baseDocId
    };
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_edit', text: JSON.stringify(result, null, 2) };
  }

  if (flags.insert) {
    const mode = String(flags.insert || '').trim();
    if (mode !== 'child' && mode !== 'sibling') throw new Error('db edit --insert requires child or sibling');
    const { docId, address } = requireEditNodeArgs(positional, '--insert');
    const text = positional.slice(2).join(' ');
    if (text === '') throw new Error('db edit --insert requires text');
    const node = await readEditTargetNode(database, docId, address);
    if (mode === 'sibling' && !node.parentId) throw new Error('db edit --insert sibling cannot target the document root');
    const target = editBranchWriteTarget(flags, context, docId);
    const payload = {
      action: 'node.insert',
      parentId: mode === 'child' ? node.id : node.parentId,
      text,
      editBranchOwner: target.owner,
      editBranchBaseDocId: target.baseDocId
    };
    if (mode === 'sibling') payload.afterNodeId = node.id;
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_edit', text: JSON.stringify(result, null, 2) };
  }

  return null;
}

function treeFromFlatNodes(nodes = []) {
  const byId = new Map();
  const roots = [];
  for (const node of nodes) byId.set(String(node.id), { ...node, children: [] });
  for (const node of byId.values()) {
    const parent = byId.get(String(node.parentId || ''));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function formatIndexNode(node = {}, depth = 0) {
  const title = nodeTitle(node);
  const chars = Number(node.meta?.subtreeTextChars ?? node.meta?.textChars) || 0;
  const semantic = semanticLabel(node.meta?.semantic);
  const line = `${'  '.repeat(depth)}${node.address || ''} ${nodeTypeLabel(node)}${title ? ` ${title}` : ''} (${chars})${semantic ? ` ${semantic}` : ''}`.trimEnd();
  const children = Array.isArray(node.children) ? node.children : [];
  return [line, ...children.flatMap((child) => formatIndexNode(child, depth + 1))];
}

function semanticLabel(semantic = null) {
  if (!semantic?.status) return '';
  const vectors = Number(semantic.vectorCount) > 0 ? ` vectors=${Number(semantic.vectorCount)}` : '';
  return `[semantic:${semantic.status}${vectors}]`;
}

async function readDocDisplayLabel(database, docId, options = {}) {
  if (options.docLabel !== undefined) return options.docLabel;
  try {
    const doc = await database.run({
      operation: 'read',
      payload: { action: 'doc.get', docId, includeNodes: false, includeEditBranch: false }
    }, 'read');
    return docDisplayLabel(doc?.doc || {}, { uuid: options.uuid, docId });
  } catch {
    return docDisplayLabel({}, { uuid: options.uuid, docId });
  }
}

function limitReadText(text = '', options = {}) {
  const value = String(text || '');
  const limit = Number(options.limit) || 0;
  if (limit > 0 && value.length > limit) {
    return [
      `该子树正文 ${value.length} 字，超过 ${limit} 字。`,
      `请先用 tree 查看 doc ${options.docId || ''} ${options.address || ''} 的下级地址，再分批 read 更小子树。`
    ].join('\n');
  }
  return value;
}

function readNodeText(node = {}, options = {}) {
  if (!options.meta) {
    const parts = [];
    function visit(current = {}) {
      if (current.text) parts.push(String(current.text));
      for (const child of current.children || []) visit(child);
    }
    visit(node);
    const text = parts.filter((part) => part.trim()).join('\n');
    return limitReadText(text, { ...options, docId: node.docId, address: node.address });
  }

  const parts = [];
  const chars = Number(node.meta?.textChars) || 0;
  const semantic = semanticLabel(node.meta?.semantic);
  const title = node.title ? ` ${String(node.title)}` : '';
  const header = [docDisplayLabel(node.doc || {}, {
    uuid: options.uuid,
    docId: node.docId ?? node.doc_id,
    title: options.docLabel
  }), node.address || '', nodeTypeLabel(node)];
  if (options.includeTrust) header.push(nodeTrustLabel(node));
  if (title) header.push(title.trim());
  header.push(`(${chars})${semantic ? ` ${semantic}` : ''}`);
  parts.push(`[${header.filter(Boolean).join(' ')}]`);
  if (node.text) parts.push(String(node.text));
  if (node.note) parts.push(`[note] ${String(node.note)}`);
  for (const child of node.children || []) parts.push(readNodeText(child, options));
  return parts.filter(Boolean).join('\n');
}

async function readNeighborNodes(database, docId, address, options = {}) {
  const indexResult = await database.run({
    operation: 'read',
    payload: { action: 'content.getIndex', docId, depth: 10000, detail: 'summary', limit: 0 }
  }, 'read');
  const nodes = Array.isArray(indexResult.nodes) ? indexResult.nodes : [];
  const target = nodes.find((node) => String(node.address || '') === String(address || '')) || null;
  if (!target?.id) throw new Error(`db read --neighbors target not found: doc ${docId} ${address}`);
  const siblings = nodes
    .filter((node) => String(node.parentId ?? '') === String(target.parentId ?? ''))
    .sort((left, right) => {
      const order = Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
      return order || String(left.address || '').localeCompare(String(right.address || ''));
    });
  const index = siblings.findIndex((node) => String(node.id) === String(target.id));
  const selected = [
    index > 0 ? siblings[index - 1] : null,
    target,
    index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null
  ];
  const labels = ['previous', 'target', 'next'];
  const sections = [];
  for (let i = 0; i < selected.length; i += 1) {
    const node = selected[i];
    if (!node) continue;
    const payload = options.node || options.meta
      ? { action: 'content.getNode', docId, address: node.address, detail: 'full', include: options.include || [] }
      : { action: 'content.getSubtree', docId, address: node.address, format: 'text', textLimit: options.limit || READ_SUBTREE_TEXT_LIMIT, limit: 0 };
    const result = await database.run({ operation: 'read', payload }, 'read');
    const body = !options.node && !options.meta && typeof result.text === 'string'
      ? result.text
      : readNodeText(result.node || result.tree || {}, {
        meta: options.node || options.meta,
        includeTrust: options.node || options.meta,
        limit: options.node ? 0 : (options.limit || READ_SUBTREE_TEXT_LIMIT),
        uuid: options.uuid,
        docLabel: options.docLabel
      });
    sections.push(`[${labels[i]} ${node.address || ''} ${nodeTypeLabel(node)} ${nodeTitle(node)}]`.trimEnd());
    if (body) sections.push(body);
  }
  return sections.join('\n');
}

function dbReadTargetNotFoundError(docId, address) {
  return new Error(`db read target not found: doc ${docId} ${address}`);
}

async function requireDbReadTargetNode(database, docId, address) {
  const result = await database.run({
    operation: 'read',
    payload: { action: 'content.getNode', docId, address, detail: 'summary' }
  }, 'read');
  const node = result?.node || null;
  if (!node?.id) throw dbReadTargetNotFoundError(docId, address);
  return node;
}

async function readSourceBlame(database, docId, address, options = {}) {
  const nodeResult = await database.run({
    operation: 'read',
    payload: { action: 'content.getNode', docId, address, detail: 'summary', include: ['source', 'timestamps', 'tags'] }
  }, 'read');
  const node = nodeResult?.node || null;
  if (!node?.id) throw new Error(`db read --blame target not found: doc ${docId} ${address}`);

  const doc = await database.run({
    operation: 'read',
    payload: { action: 'doc.get', docId, includeNodes: false, includeEditBranch: false }
  }, 'read');
  const sourceDocument = doc?.sourceDocument || null;
  const docLabel = docDisplayLabel(doc?.doc || {}, { uuid: options.uuid, docId });
  const lines = [
    `[${docLabel} ${node.address || address} ${nodeTypeLabel(node)} ${nodeTrustLabel(node)} ${nodeTitle(node)}]`.trim(),
    `node_id: ${node.id}`,
    `source_position: ${valueOrNull(node.source?.position)}`,
    `node_created_at: ${valueOrNull(node.createdAt)}`,
    `node_updated_at: ${valueOrNull(node.updatedAt)}`
  ];

  if (!sourceDocument) {
    lines.push('source: none');
    return lines.join('\n');
  }

  lines.push(`source: ${valueOrNull(sourceDocument.source_type || sourceDocument.sourceType)} ${valueOrNull(sourceDocument.original_path || sourceDocument.originalPath)}`);
  if (sourceDocument.created_at || sourceDocument.createdAt) {
    lines.push(`source_created_at: ${valueOrNull(sourceDocument.created_at || sourceDocument.createdAt)}`);
  }

  const article = await database.run({
    operation: 'read',
    payload: {
      action: 'content.getArticle',
      docId,
      nodeId: node.id,
      include: ['spans'],
      ...(options.limit ? { limit: options.limit } : {})
    }
  }, 'read');
  const directSpans = (Array.isArray(article?.sourceSpans) ? article.sourceSpans : [])
    .filter((span) => String(span.node_id ?? span.nodeId ?? '') === String(node.id));
  const hasAnchor = directSpans.length > 0 || node.source?.position !== null && node.source?.position !== undefined;
  if (hasAnchor && article?.window) {
    lines.push(`window: ${article.window.startOffset}-${article.window.endOffset}/${article.window.totalLength} before:${Boolean(article.window.hasBefore)} after:${Boolean(article.window.hasAfter)}`);
  } else {
    lines.push('window: none');
  }
  lines.push('[source_spans]');
  lines.push(...(directSpans.length ? directSpans.map(formatSourceSpanLine) : ['none']));
  return lines.join('\n');
}

function parseHistorySnapshot(row = {}) {
  let payload = {};
  try {
    payload = JSON.parse(row.diff || '{}');
  } catch {
    payload = {};
  }
  const snapshot = payload.snapshot || (payload.kind === 'snapshot' ? payload : null);
  if (!Array.isArray(snapshot?.nodes)) throw new Error(`history snapshot is not readable: ${row.id ?? ''}`);
  return snapshot;
}

function snapshotNodeId(row = {}) {
  return String(row.id ?? row.nodeId ?? row.node_id ?? '');
}

function snapshotParentId(row = {}) {
  const parent = row.parent_id ?? row.parentId ?? null;
  return parent === null || parent === undefined ? '' : String(parent);
}

function snapshotChildrenByParent(rows = []) {
  const byParent = new Map();
  for (const row of rows) {
    const key = snapshotParentId(row);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(row);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((left, right) => {
      const order = Number(left.sort_order ?? left.sortOrder ?? 0) - Number(right.sort_order ?? right.sortOrder ?? 0);
      return order || String(left.address || '').localeCompare(String(right.address || ''));
    });
  }
  return byParent;
}

function snapshotTextChars(row = {}) {
  return String(row.text || '').length;
}

function snapshotSubtreeTextChars(row, byParent) {
  return snapshotTextChars(row) + (byParent.get(snapshotNodeId(row)) || [])
    .reduce((sum, child) => sum + snapshotSubtreeTextChars(child, byParent), 0);
}

function snapshotReadNode(row, byParent) {
  const children = byParent.get(snapshotNodeId(row)) || [];
  return {
    id: row.id,
    docId: row.doc_id ?? row.docId,
    parentId: row.parent_id ?? row.parentId ?? null,
    address: row.address || '',
    depth: row.depth ?? null,
    sortOrder: row.sort_order ?? row.sortOrder ?? null,
    type: row.node_type ?? row.nodeType ?? 'TEXT',
    title: row.node_title ?? row.nodeTitle ?? '',
    text: row.text || '',
    note: row.node_note ?? row.nodeNote ?? '',
    childCount: children.length,
    tags: {
      trustLevel: row.trust_level ?? row.trustLevel ?? null
    },
    meta: {
      textChars: snapshotTextChars(row),
      subtreeTextChars: snapshotSubtreeTextChars(row, byParent)
    },
    children: children.map((child) => snapshotReadNode(child, byParent))
  };
}

function snapshotSubtreeRows(root, byParent) {
  const rows = [root];
  for (const child of byParent.get(snapshotNodeId(root)) || []) rows.push(...snapshotSubtreeRows(child, byParent));
  return rows;
}

function snapshotBodyText(root, byParent, options = {}) {
  const text = snapshotSubtreeRows(root, byParent)
    .filter((row) => (byParent.get(snapshotNodeId(row)) || []).length === 0)
    .map((row) => String(row.text || ''))
    .filter((text) => text.trim())
    .join('\n');
  return limitReadText(text, {
    ...options,
    docId: options.docId || root.doc_id || root.docId,
    address: options.address || root.address
  });
}

function snapshotLinkLines(refs = [], nodeId = '') {
  return refs
    .filter((row) => (
      (row.source_type === 'node' && String(row.source_id) === String(nodeId))
      || (row.target_type === 'node' && String(row.target_id) === String(nodeId))
    ))
    .map(formatRefLine);
}

async function readHistorySnapshot(database, docId, address, flags = {}) {
  if (flags.source || flags.blame) {
    throw new Error('db read --at does not support --source/--blame because save_history snapshots do not store source spans');
  }
  const history = await resolveHistoryRef(database, historyRefFromReadAt(flags.at, docId), { includeDiff: true });
  const snapshot = parseHistorySnapshot(history);
  if (String(snapshot.doc?.id ?? docId) !== String(docId)) {
    throw new Error(`db read --at history ${history.id} belongs to another doc`);
  }
  const rows = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const target = rows.find((row) => String(row.address || '') === String(address || '')) || null;
  if (!target) throw new Error(`db read --at target not found: doc ${docId} ${address}`);
  const byParent = snapshotChildrenByParent(rows);
  const docLabel = docDisplayLabel(snapshot.doc || {}, { uuid: flags.uuid, docId });
  if (flags.axioms || flags.links) {
    const sections = [];
    if (flags.axioms) sections.push(['[axioms]', ...((snapshot.axioms || []).map(formatAxiomLine))].join('\n'));
    if (flags.links) sections.push(['[links]', ...snapshotLinkLines(snapshot.refs || [], snapshotNodeId(target))].join('\n'));
    return sections.join('\n\n');
  }
  if (flags.neighbors) {
    const siblings = byParent.get(snapshotParentId(target)) || [];
    const index = siblings.findIndex((row) => snapshotNodeId(row) === snapshotNodeId(target));
    return [
      index > 0 ? ['previous', siblings[index - 1]] : null,
      ['target', target],
      index >= 0 && index < siblings.length - 1 ? ['next', siblings[index + 1]] : null
    ].filter(Boolean).map(([label, row]) => {
      const node = snapshotReadNode(row, byParent);
      const body = flags.node || flags.meta
        ? readNodeText(node, { meta: true, includeTrust: true, limit: flags.node ? 0 : (flags.limit || READ_SUBTREE_TEXT_LIMIT), uuid: flags.uuid, docLabel })
        : snapshotBodyText(row, byParent, {
          docId,
          address: row.address || '',
          limit: flags.limit || READ_SUBTREE_TEXT_LIMIT
        });
      return [`[${label} ${row.address || ''} ${nodeTypeLabel(node)} ${nodeTitle(node)}]`.trimEnd(), body].filter(Boolean).join('\n');
    }).join('\n');
  }
  if (!flags.node && !flags.meta) {
    return snapshotBodyText(target, byParent, {
      docId,
      address,
      limit: flags.limit || READ_SUBTREE_TEXT_LIMIT
    });
  }
  return readNodeText(snapshotReadNode(target, byParent), {
    meta: true,
    includeTrust: true,
    limit: flags.node ? 0 : (flags.limit || READ_SUBTREE_TEXT_LIMIT),
    uuid: flags.uuid,
    docLabel
  });
}

export function dbShellHelp() {
  return [
    'Usage:',
    '  db find <term>... [--semantic] [--scope <doc_id> <address>] [--all-docs] [--tags] [--limit N] [--uuid]',
    '  db index [--folder <library_relative_path>] [--summary] [--uuid]',
    '  db tree <doc_id> [address] [--from <address>] [--depth N] [--uuid]',
    '  db read <doc_id> <address> [--node] [--meta] [--source] [--axioms] [--links] [--neighbors] [--at <ref>] [--blame] [--limit N] [--uuid]',
    '  db log <doc_id> [--limit N]',
    '  db diff <doc_id> <history_id> | <doc_id> <from_history_id> <to_history_id>',
    '  db sql <SELECT_or_WITH_sql> [--limit N]',
    '  db ask_agent <prompt> [--doc-id <doc_id>] [--session-id <id>]',
    '  db edit <database_write_action> [json_payload] [--owner <owner>] [--base <doc_id>]',
    '  db edit <doc_id> <address> --set <field> <value> [--owner <owner>] [--base <doc_id>]',
    '    --set fields: text/node_title/node_note/node_type/trust_level；node_type: 文本/如果/那么/否则/循环/遍历/跳出/继续/错误/人工-阻塞/人工-汇总',
    '  db edit <doc_id> <address> --insert child|sibling <text> [--owner <owner>] [--base <doc_id>]',
    '  db edit <doc_id> <address> --delete [--owner <owner>] [--base <doc_id>]',
    '  db export <doc_id>',
    '  db restore <history_id|saved_at|tag> [doc_id]',
    '  db import <library_relative_path> [--mode simple|complete|direct|smart|vector]',
    '  db vectors <doc_id>',
    '  db forget <doc_id>',
    '  db changes [doc_id] [--detail] [--branch <id> | --base <doc_id>] [--owner <owner>]',
    '  db discard --branch <id> | --base <doc_id> [--owner <owner>] [--yes]',
    '  db undo --branch <id> | --base <doc_id> [--owner <owner>]',
    '  db redo --branch <id> | --base <doc_id> [--owner <owner>]',
    '  db branch list [doc_id] [--owner <owner>]',
    '  db branch begin <doc_id> [--owner <owner>]',
    '  db branch diff [doc_id] | --branch <id> | --base <doc_id> [--owner <owner>]',
    '  db branch merge [doc_id] | --branch <id> | --base <doc_id> [--owner <owner>] --all [--yes]',
    '  db branch drop [doc_id] | --branch <id> | --base <doc_id> [--owner <owner>] [--yes]',
    '  db switch --branch <id> | --base <doc_id> [--owner <owner>]',
    '  db commit --branch <id> | --base <doc_id> [--owner <owner>] [--summary text] [--tag text]',
    '  db merge --branch <id> | --base <doc_id> [--owner <owner>] [--yes]',
    '  db rebase --branch <id> | --base <doc_id> [--owner <owner>]',
    '  db cherry-pick --history <id> | --source-branch <id> [--target-branch <id> | --target-base <doc_id>] [--entry-index N]',
    '  db shell [--cwd workspace|library|path] [--timeout-ms N] [--] <command>',
    '  db web search <query> [--limit N]',
    '  db web open <url> [--char-limit N]',
    '  db keyword/query ... (compat aliases for db find)'
  ].join('\n');
}

export async function runDbShellArgv(database, argv = [], context = {}) {
  if (!database?.run) throw new Error('db command requires database service');
  const args = normalizeArgv(argv);
  const command = args[0] || '';
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { kind: 'db_help', text: dbShellHelp() };
  }

  if (command === 'find') {
    const { flags, positional } = parseFlags(args.slice(1));
    if (flags.semantic && flags.tags) throw new Error('db find cannot combine --semantic and --tags');
    if (flags.or) throw new Error('db find --or is not supported; run db find once per term for OR.');
    if (flags.semantic) {
      const query = positional.join(' ').trim();
      if (!query) throw new Error('db find --semantic requires natural language text');
      const scope = docScope(flags, context);
      const payload = scope.allDocs
        ? { action: 'content.searchAll', query, searchMode: 'vector', allDocs: true, limit: flags.limit }
        : { action: 'content.search', query, searchMode: 'vector', docId: scope.docId, limit: flags.limit };
      const result = await database.run({ operation: 'read', payload }, 'read');
      if (result.error) throw new Error(result.error);
      let rows = result.rows || [];
      if (!scope.allDocs && flags.scopeAddress) {
        rows = rows.filter((node) => node.address === flags.scopeAddress || String(node.address || '').startsWith(`${flags.scopeAddress}-`));
      }
      const docLabel = scope.allDocs ? '' : await readDocDisplayLabel(database, scope.docId, { uuid: flags.uuid });
      return {
        kind: 'db_find',
        text: rows.map((row) => {
          if (row.node) return formatNodeLine(row, { score: row.node.score, uuid: flags.uuid, docLabel });
          return formatNodeLine(row, { score: row.score, uuid: flags.uuid, docLabel });
        }).join('\n')
      };
    }
    if (positional.length === 0) throw new Error('db find requires at least one term');
    if (flags.tags) {
      const result = await database.run({
        operation: 'read',
        payload: {
          action: 'entity.listRelated',
          terms: positional,
          ...docScope(flags, context),
          limit: flags.limit
        }
      }, 'read');
      return {
        kind: 'db_find_tags',
        text: formatEntityTags(result.rows || [], { uuid: flags.uuid })
      };
    }
    const result = await database.run({
      operation: 'read',
      payload: {
        action: 'content.searchKeyword',
        terms: positional,
        matchMode: 'and',
        ...docScope(flags, context),
        limit: flags.limit
      }
    }, 'read');
    return {
      kind: 'db_find',
      text: (result.rows || []).map((row) => formatNodeLine(row, { uuid: flags.uuid })).join('\n')
    };
  }

  if (command === 'keyword') {
    return runDbShellArgv(database, ['find', ...args.slice(1)], context);
  }

  if (command === 'query') {
    return runDbShellArgv(database, ['find', '--semantic', ...args.slice(1)], context);
  }

  if (command === 'index') {
    const { flags, positional } = parseFlags(args.slice(1));
    if (positional.length > 0) throw new Error('db index does not accept doc id; use db tree <doc_id> for document structure');
    const payload = { action: 'library.index', format: 'ascii_tree' };
    if (flags.folder) payload.path = flags.folder;
    if (flags.summary) payload.includeSummary = true;
    if (flags.uuid) payload.uuid = true;
    const result = await database.run({ operation: 'read', payload }, 'read');
    return {
      kind: 'db_index',
      text: result.text || ''
    };
  }

  if (command === 'tree') {
    const { flags, positional } = parseFlags(args.slice(1));
    const docId = normalizeShellDocId(positional[0], null);
    if (!docId) throw new Error('db tree requires doc_id');
    const positionalAddress = String(positional[1] || '').trim();
    if (positionalAddress && flags.from && positionalAddress !== String(flags.from).trim()) {
      throw new Error('db tree address and --from must match when both are provided');
    }
    const address = String(flags.from || positionalAddress || '').trim();
    const payload = address
      ? { action: 'content.getSubtree', docId, address, levels: flags.depth, detail: 'summary', limit: 0 }
      : { action: 'content.getIndex', docId, depth: flags.depth, detail: 'summary', limit: 0 };
    if (flags.uuid) payload.uuid = true;
    const result = await database.run({ operation: 'read', payload }, 'read');
    const roots = result.tree ? [result.tree] : treeFromFlatNodes(result.nodes || []);
    return {
      kind: 'db_tree',
      text: roots.flatMap((root) => formatIndexNode(root)).join('\n')
    };
  }

  if (command === 'read') {
    const { flags, positional } = parseFlags(args.slice(1));
    const docId = normalizeShellDocId(positional[0], null);
    const address = String(positional[1] || '').trim();
    if (!docId || !address) throw new Error('db read requires <doc_id> <address>');
    if (flags.at) {
      return {
        kind: 'db_read_at',
        text: await readHistorySnapshot(database, docId, address, flags)
      };
    }
    let targetNode = null;
    let targetDocLabel;
    const readTargetNode = async () => {
      if (!targetNode) targetNode = await requireDbReadTargetNode(database, docId, address);
      return targetNode;
    };
    const readTargetDocLabel = async () => {
      if (targetDocLabel === undefined) {
        targetDocLabel = await readDocDisplayLabel(database, docId, { uuid: flags.uuid });
      }
      return targetDocLabel;
    };
    if (flags.blame) {
      await readTargetNode();
      return {
        kind: 'db_read_blame',
        text: await readSourceBlame(database, docId, address, { limit: flags.limit, uuid: flags.uuid })
      };
    }
    if (flags.source) {
      const node = await readTargetNode();
      const payload = { action: 'content.getArticle', docId };
      payload.nodeId = node.id;
      if (flags.limit) payload.limit = flags.limit;
      const article = await database.run({ operation: 'read', payload }, 'read');
      return { kind: 'db_read_source', text: article?.text || '' };
    }
    if (flags.axioms || flags.links) {
      const node = await readTargetNode();
      const doc = await database.run({
        operation: 'read',
        payload: { action: 'doc.get', docId, includeNodes: false, includeEditBranch: false }
      }, 'read');
      const sections = [];
      if (flags.axioms) {
        sections.push(['[axioms]', ...(doc?.axioms || []).map(formatAxiomLine)].join('\n'));
      }
      if (flags.links) {
        let refs = doc?.refs || [];
        refs = refs.filter((row) => (
          (row.source_type === 'node' && String(row.source_id) === String(node.id))
          || (row.target_type === 'node' && String(row.target_id) === String(node.id))
        ));
        sections.push(['[links]', ...refs.map(formatRefLine)].join('\n'));
      }
      return { kind: 'db_read_lens', text: sections.join('\n\n') };
    }
    const include = [];
    if (flags.node || flags.meta) include.push('tags');
    if (flags.meta) include.push('note');
    const textLimit = flags.limit || READ_SUBTREE_TEXT_LIMIT;
    if (flags.neighbors) {
      await readTargetNode();
      return {
        kind: 'db_read_neighbors',
        text: await readNeighborNodes(database, docId, address, {
          node: flags.node,
          meta: flags.meta,
          include,
          limit: textLimit,
          uuid: flags.uuid,
          docLabel: await readTargetDocLabel()
        })
      };
    }
    const payload = flags.node
      ? { action: 'content.getNode', docId, address, detail: 'full', include }
      : flags.meta
        ? { action: 'content.getSubtree', docId, address, detail: 'full', limit: 0, include }
        : { action: 'content.getSubtree', docId, address, format: 'text', textLimit, limit: 0 };
    await readTargetNode();
    const result = await database.run({ operation: 'read', payload }, 'read');
    if (!flags.node && !flags.meta && typeof result.text === 'string') {
      return { kind: 'db_read', text: result.text };
    }
    const root = result.node || result.tree;
    return {
      kind: 'db_read',
      text: root ? readNodeText(root, {
        meta: flags.node || flags.meta,
        includeTrust: flags.node || flags.meta,
        limit: flags.node ? 0 : textLimit,
        uuid: flags.uuid,
        docLabel: flags.node || flags.meta ? await readTargetDocLabel() : undefined
      }) : ''
    };
  }

  if (command === 'log') {
    const { flags, positional } = parseFlags(args.slice(1));
    const docId = normalizeShellDocId(positional[0], null);
    if (!docId) throw new Error('db log requires doc_id');
    const result = await database.run({
      operation: 'read',
      payload: { action: 'doc.get', docId, includeNodes: false, includeEditBranch: false }
    }, 'read');
    const rows = Array.isArray(result?.history) ? result.history : [];
    const limitedRows = flags.limit ? rows.slice(0, Number(flags.limit)) : rows;
    return {
      kind: 'db_log',
      text: limitedRows.map(formatHistoryLine).join('\n')
    };
  }

  if (command === 'diff') {
    const { flags, positional } = parseFlags(args.slice(1));
    const docId = normalizeShellDocId(positional[0], null);
    if (!docId) throw new Error('db diff requires doc_id');
    const fromHistoryId = flags.from || positional[1] || '';
    const toHistoryId = flags.to || positional[2] || positional[1] || '';
    if (!toHistoryId) throw new Error('db diff requires history id');
    const payload = { action: 'history.diff', docId, toHistoryId };
    if (fromHistoryId && fromHistoryId !== toHistoryId) payload.fromHistoryId = fromHistoryId;
    const result = await database.run({ operation: 'read', payload }, 'read');
    return {
      kind: 'db_diff',
      text: (result.entries || []).map(formatDiffEntry).join('\n')
    };
  }

  if (command === 'sql') {
    const { flags, positional } = parseFlags(args.slice(1));
    const sql = positional.join(' ').trim();
    if (!sql) throw new Error('db sql requires a SELECT/WITH query');
    const payload = { action: 'debug.sql', sql };
    if (flags.limit) payload.limit = flags.limit;
    const result = await database.run({ operation: 'read', payload }, 'read');
    return { kind: 'db_sql', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'ask_agent') {
    const { flags, positional } = parseFlags(args.slice(1));
    const prompt = positional.join(' ').trim();
    if (!prompt) throw new Error('db ask_agent requires prompt text');
    const payload = { prompt };
    const docId = normalizeShellDocId(flags.docId, currentDocIdFrom(context));
    if (docId) payload.docId = docId;
    if (flags.sessionId) payload.sessionId = flags.sessionId;
    const result = await contextFunction(context, 'askAgent')(payload);
    const answer = result?.answer || result?.error || '';
    const session = result?.sessionId != null ? `\n\n[sessionId: ${result.sessionId}]` : '';
    return { kind: 'db_ask_agent', text: `${answer}${session}` };
  }

  if (command === 'edit') {
    const { flags, positional } = parseFlags(args.slice(1));
    const friendly = await runFriendlyEdit(database, flags, positional, context);
    if (friendly) return friendly;
    const action = String(positional[0] || '').trim();
    if (!action) throw new Error('db edit requires database_write action');
    const payload = parseJsonObjectArgument(positional.slice(1).join(' '), {});
    const target = branchTarget(flags, context);
    const writePayload = {
      ...payload,
      action,
      editBranchOwner: target.owner || 'llm'
    };
    if (target.baseDocId) writePayload.editBranchBaseDocId = target.baseDocId;
    const result = await database.run({ operation: 'write', payload: writePayload }, 'write');
    return { kind: 'db_edit', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'export') {
    const { positional } = parseFlags(args.slice(1));
    const docId = normalizeShellDocId(positional[0], null);
    if (!docId) throw new Error('db export requires doc_id');
    const result = await database.run({
      operation: 'read',
      payload: { action: 'doc.exportMarkdown', docId }
    }, 'read');
    return {
      kind: 'db_export',
      text: result?.text || ''
    };
  }

  if (command === 'restore') {
    const { flags, positional } = parseFlags(args.slice(1));
    const history = await resolveHistoryRef(database, historyRefSpec(flags, positional));
    const payload = { action: 'history.restore', historyId: history.id, docId: history.doc_id };
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_restore', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'import') {
    const { flags, positional } = parseFlags(args.slice(1));
    const relativePath = String(positional[0] || '').trim();
    if (!relativePath) throw new Error('db import requires library_relative_path');
    const payload = { relativePath };
    if (flags.mode) payload.mode = String(flags.mode);
    const result = await contextFunction(context, 'importLibraryDocument')(payload);
    return { kind: 'db_import', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'vectors') {
    const { positional } = parseFlags(args.slice(1));
    const docId = normalizeShellDocId(positional[0], null);
    if (!docId) throw new Error('db vectors requires doc_id');
    const result = await contextFunction(context, 'ensureDocVectors')({ docId });
    return { kind: 'db_vectors', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'forget') {
    const { positional } = parseFlags(args.slice(1));
    const docId = normalizeShellDocId(positional[0], null);
    if (!docId) throw new Error('db forget requires doc_id');
    if (typeof context.deleteImportedDocument === 'function') {
      const result = await context.deleteImportedDocument({ docId });
      return { kind: 'db_forget', text: JSON.stringify(result, null, 2) };
    }
    const result = await database.run({
      operation: 'write',
      payload: { action: 'doc.delete', docId }
    }, 'write');
    return { kind: 'db_forget', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'branch') {
    const { flags, positional } = parseFlags(args.slice(1));
    const subcommand = String(positional[0] || 'list').trim();
    if (subcommand === 'list') {
      const docId = normalizeShellDocId(positional[1], null);
      const payload = { action: 'editBranch.listPending' };
      if (flags.owner) payload.owner = String(flags.owner);
      const result = await database.run({ operation: 'read', payload }, 'read');
      const branches = (result.branches || []).filter((branch) => (
        docId ? String(branch.base_doc_id) === String(docId) : true
      ));
      return { kind: 'db_branch_list', text: branches.map(formatBranchLine).join('\n') };
    }
    if (subcommand === 'begin') {
      const docId = normalizeShellDocId(positional[1], null);
      if (!docId) throw new Error('db branch begin requires doc_id');
      const payload = { action: 'editBranch.begin', docId, includeDoc: false };
      if (flags.owner) payload.owner = String(flags.owner);
      const result = await database.run({ operation: 'write', payload }, 'write');
      return { kind: 'db_branch_begin', text: JSON.stringify(result, null, 2) };
    }
    if (subcommand === 'diff') {
      const target = branchTarget(flags, context, positional[1]);
      const payload = { action: 'editBranch.diffView' };
      if (target.branchId) payload.branchId = target.branchId;
      if (target.baseDocId) payload.baseDocId = target.baseDocId;
      if (target.owner) payload.owner = String(target.owner);
      const result = await database.run({ operation: 'read', payload }, 'read');
      return { kind: 'db_branch_diff', text: JSON.stringify(result, null, 2) };
    }
    if (subcommand === 'merge') {
      if (!flags.all) return { kind: 'db_branch_merge', text: 'db branch merge requires --all; --entry is not implemented' };
      const target = branchTarget(flags, context, positional[1]);
      if (!target.branchId && !target.baseDocId) throw new Error('db branch merge requires --branch or --base');
      if (!flags.yes) {
        return {
          kind: 'db_branch_merge',
          text: `would merge ${branchTargetLabel(target)}; rerun with --yes to apply`
        };
      }
      const payload = { action: 'editBranch.save', includeDoc: false };
      if (target.branchId) payload.branchId = target.branchId;
      if (target.baseDocId) payload.baseDocId = target.baseDocId;
      if (target.owner) payload.owner = String(target.owner);
      const result = await database.run({ operation: 'write', payload }, 'write');
      return { kind: 'db_branch_merge', text: JSON.stringify(result, null, 2) };
    }
    if (subcommand === 'drop') {
      const target = branchTarget(flags, context, positional[1]);
      if (!target.branchId && !target.baseDocId) throw new Error('db branch drop requires --branch or --base');
      if (!flags.yes) {
        return {
          kind: 'db_branch_drop',
          text: `would drop ${branchTargetLabel(target)}; rerun with --yes to apply`
        };
      }
      const payload = { action: 'editBranch.discard', includeDoc: false };
      if (target.branchId) payload.branchId = target.branchId;
      if (target.baseDocId) payload.baseDocId = target.baseDocId;
      if (target.owner) payload.owner = String(target.owner);
      const result = await database.run({ operation: 'write', payload }, 'write');
      return { kind: 'db_branch_drop', text: JSON.stringify(result, null, 2) };
    }
    throw new Error(`Unknown db branch command: ${subcommand}`);
  }

  if (command === 'changes') {
    const { flags, positional } = parseFlags(args.slice(1));
    if (flags.detail) {
      const target = branchTarget(flags, context, positional[0]);
      const payload = { action: 'editBranch.diffView' };
      if (target.branchId) payload.branchId = target.branchId;
      if (target.baseDocId) payload.baseDocId = target.baseDocId;
      if (target.owner) payload.owner = String(target.owner);
      if (!payload.branchId && !payload.baseDocId) throw new Error('db changes --detail requires --branch or --base');
      const result = await database.run({ operation: 'read', payload }, 'read');
      return { kind: 'db_changes', text: JSON.stringify(result, null, 2) };
    }
    const docId = normalizeShellDocId(positional[0], null);
    const payload = { action: 'editBranch.listPending' };
    if (flags.owner) payload.owner = String(flags.owner);
    const result = await database.run({ operation: 'read', payload }, 'read');
    const branches = (result.branches || []).filter((branch) => (
      docId ? String(branch.base_doc_id) === String(docId) : true
    ));
    return { kind: 'db_changes', text: branches.map(formatBranchLine).join('\n') };
  }

  if (command === 'discard') {
    const { flags } = parseFlags(args.slice(1));
    const target = branchTarget(flags, context);
    if (!target.branchId && !target.baseDocId) throw new Error('db discard requires --branch or --base');
    if (!flags.yes) {
      return {
        kind: 'db_discard',
        text: `would discard ${branchTargetLabel(target)}; rerun with --yes to apply`
      };
    }
    const payload = { action: 'editBranch.discard', includeDoc: false };
    if (target.branchId) payload.branchId = target.branchId;
    if (target.baseDocId) payload.baseDocId = target.baseDocId;
    if (target.owner) payload.owner = String(target.owner);
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_discard', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'undo' || command === 'redo') {
    const { flags } = parseFlags(args.slice(1));
    const target = branchTarget(flags, context);
    const payload = {
      action: command === 'undo' ? 'editBranch.undo' : 'editBranch.redo',
      includeDoc: false
    };
    if (target.branchId) payload.branchId = target.branchId;
    if (target.baseDocId) payload.baseDocId = target.baseDocId;
    if (target.owner) payload.owner = String(target.owner);
    if (!payload.branchId && !payload.baseDocId) throw new Error(`db ${command} requires --branch or --base`);
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: command === 'undo' ? 'db_undo' : 'db_redo', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'switch') {
    const { flags } = parseFlags(args.slice(1));
    if (!flags.branch && !flags.base) {
      const current = selectedBranch(context);
      return { kind: 'db_switch', text: current.branchId || current.baseDocId ? JSON.stringify(current, null, 2) : '(未选择分支)' };
    }
    const next = updateSelectedBranch(context, {
      branchId: flags.branch ?? null,
      baseDocId: flags.base ?? null,
      owner: flags.owner ? String(flags.owner) : null
    });
    return { kind: 'db_switch', text: JSON.stringify(next, null, 2) };
  }

  if (command === 'commit' || command === 'merge') {
    const { flags } = parseFlags(args.slice(1));
    const target = branchTarget(flags, context);
    if (command === 'merge' && !target.branchId && !target.baseDocId) throw new Error('db merge requires --branch or --base');
    if (command === 'merge' && !flags.yes) {
      return {
        kind: 'db_merge',
        text: `would merge ${branchTargetLabel(target)}; rerun with --yes to apply`
      };
    }
    const payload = { action: 'editBranch.save', includeDoc: false };
    if (target.branchId) payload.branchId = target.branchId;
    if (target.baseDocId) payload.baseDocId = target.baseDocId;
    if (target.owner) payload.owner = String(target.owner);
    if (flags.summary && flags.summary !== true) payload.summary = String(flags.summary);
    else if (flags.tag && flags.tag !== true) payload.summary = String(flags.tag);
    if (!payload.branchId && !payload.baseDocId) throw new Error(`db ${command} requires --branch or --base`);
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: command === 'commit' ? 'db_commit' : 'db_merge', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'rebase') {
    const { flags } = parseFlags(args.slice(1));
    const target = branchTarget(flags, context);
    const payload = { action: 'editBranch.rebase', includeDoc: false };
    if (target.branchId) payload.branchId = target.branchId;
    if (target.baseDocId) payload.baseDocId = target.baseDocId;
    if (target.owner) payload.owner = String(target.owner);
    if (!payload.branchId && !payload.baseDocId) throw new Error('db rebase requires --branch or --base');
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_rebase', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'cherry-pick') {
    const { flags } = parseFlags(args.slice(1));
    const target = branchTarget({ branch: flags.targetBranch, base: flags.targetBase, owner: flags.owner }, context);
    const payload = { action: 'editBranch.cherryPick', includeDoc: false };
    if (flags.history) payload.sourceHistoryId = flags.history;
    if (flags.sourceBranch) payload.sourceBranchId = flags.sourceBranch;
    if (target.branchId) payload.targetBranchId = target.branchId;
    if (target.baseDocId) payload.targetBaseDocId = target.baseDocId;
    if (target.owner) payload.targetOwner = String(target.owner);
    if (flags.entryId) payload.entryId = String(flags.entryId);
    if (flags.entryIndex !== undefined) payload.entryIndex = flags.entryIndex;
    if (!payload.sourceHistoryId && !payload.sourceBranchId) throw new Error('db cherry-pick requires --history or --source-branch');
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_cherry_pick', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'shell') {
    const { flags, positional } = parseLooseFlags(args.slice(1), ['cwd', 'timeout-ms']);
    const shellCommand = positional.join(' ').trim();
    if (!shellCommand) throw new Error('db shell requires command');
    const result = await contextFunction(context, 'agentTool')({
      name: 'bash',
      mode: 'full',
      docId: currentDocIdFrom(context) || undefined,
      args: {
        command: shellCommand,
        ...(flags.cwd ? { cwd: String(flags.cwd) } : {}),
        ...(flags.timeoutMs ? { timeoutMs: flags.timeoutMs } : {})
      }
    });
    return { kind: 'db_shell', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'web') {
    const { flags, positional } = parseLooseFlags(args.slice(1), ['limit', 'char-limit']);
    const first = String(positional[0] || '').trim();
    const mode = first === 'search' || first === 'open'
      ? first
      : (/^https?:\/\//i.test(first) ? 'open' : 'search');
    const rest = positional.slice(first === 'search' || first === 'open' ? 1 : 0);
    if (mode !== 'search' && mode !== 'open') throw new Error('db web requires search or open');
    const value = rest.join(' ').trim();
    if (!value) throw new Error(`db web ${mode} requires ${mode === 'open' ? 'url' : 'query'}`);
    const toolArgs = mode === 'open'
      ? { mode, url: value }
      : { mode, query: value };
    if (flags.limit) toolArgs.limit = flags.limit;
    if (flags.charLimit) toolArgs.charLimit = flags.charLimit;
    const result = await contextFunction(context, 'agentTool')({
      name: 'web_search',
      mode: 'full',
      docId: currentDocIdFrom(context) || undefined,
      args: toolArgs
    });
    return { kind: 'db_web', text: JSON.stringify(result, null, 2) };
  }

  throw new Error(`Unknown db command: ${command}`);
}
