import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { dirname, extname, resolve, sep } from 'node:path';

import { databaseWriteToolSchema } from '../mutation-api.mjs';
import { databaseReadToolSchema } from '../query-api.mjs';
import { runDbShellArgv } from '../db-shell.mjs';
import { normalizeStableId, sameStableId } from '../db/ids.mjs';
import { normalizeNodeType } from '../../core/node-model.mjs';
import { configuredMaxOutputTokens, llmProtocol, normalizeReasoningEffort } from '../../agent/llm-api-config.mjs';
import { anthropicMessagesUrl, chatCompletionUrl, fetchLlmResponse, readJsonSseStream } from './chat-client.mjs';
import { normalizeAgentToolSettings } from './defaults.mjs';

const STABLE_ID_SCHEMA = Object.freeze({
  anyOf: [{ type: 'string' }, { type: 'number' }]
});

function sanitize(value) {
  return JSON.parse(JSON.stringify(value));
}

function clipText(value, limit = 500) {
  const text = String(value || '');
  const max = Math.max(0, Number(limit) || 0);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || /aborted|abort|cancel|取消/i.test(String(error?.message || error || ''));
}

function agentAbortError() {
  const error = new Error('Agent 请求已取消');
  error.name = 'AbortError';
  return error;
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw agentAbortError();
}

function flattenTree(node, list = []) {
  if (!node) return list;
  list.push(node);
  for (const child of node.children || []) flattenTree(child, list);
  return list;
}

function normalizeAgentMode(value) {
  if (value === 'full') return 'full';
  if (value === 'edit') return 'edit';
  return 'qa';
}

function agentModeText(mode) {
  if (mode === 'full') return '完全权限';
  if (mode === 'edit') return '协作';
  return '问答';
}

function agentPermissionsForMode(mode) {
  const normalized = normalizeAgentMode(mode);
  return {
    mode: normalized,
    label: agentModeText(normalized),
    localFiles: {
      root: 'library',
      pathStyle: 'relative',
      canRead: true,
      canWrite: normalized === 'full',
      canAccessOutsideLibrary: false
    },
    database: {
      canRead: true,
      canProposeChanges: normalized === 'edit' || normalized === 'full',
      canWriteShadow: normalized === 'edit' || normalized === 'full',
      canWriteDirect: false,
      rawSqlAllowed: false
    }
  };
}

function findNodeByIdOrAddress(doc, scope = {}) {
  if (!doc?.tree) return null;
  const nodes = flattenTree(doc.tree);
  const nodeId = normalizeStableId(scope.nodeId, null);
  if (nodeId) return nodes.find((node) => sameStableId(node.id, nodeId)) || null;
  const address = String(scope.address || '').trim();
  if (address) return nodes.find((node) => String(node.address) === address) || null;
  return doc.tree;
}

function agentDocInfoFromContentDoc(doc) {
  const meta = doc?.meta || {};
  const source = doc?.source || {};
  return {
    docId: doc?.docId || null,
    title: doc?.title || '',
    sourceType: source.type || '',
    sourcePath: source.path || '',
    imported: Boolean(doc?.docId),
    nodeCount: Number(meta.nodeCount) || 0,
    maxDepth: Number(meta.maxDepth ?? meta.subtreeMaxDepth) || 0,
    updatedAt: doc?.updatedAt || null
  };
}

function normalizeContextDepth(payload = {}) {
  const value = Number(payload.contextDepth ?? payload.context_depth ?? 2);
  return Number.isInteger(value) && value > 0 ? value : 2;
}

function formatAgentContextMessage(context) {
  const parts = [];
  if (context.file) {
    parts.push(`文档：#${context.file.docId} ${context.file.title}（${context.file.nodeCount}节点，深度${context.file.maxDepth}）`);
  }
  parts.push(`权限：${context.permissions.label}`);
  if (context.selectedNode) {
    parts.push(`选中节点：${context.selectedNode.address}`);
  }
  if (context.llmWorkspace) {
    const state = context.llmWorkspace;
    const candidates = (state.cleanupCandidates || [])
      .slice(0, 12)
      .map((item) => `${item.relativePath || item.name || ''} ${item.sizeBytes || 0}B`)
      .join('\n');
    parts.push([
      '',
      'LLM workspace:',
      `path=${state.relativePath || '.iftree-llm-workspace'}`,
      `sizeBytes=${state.sizeBytes || 0}`,
      `limitBytes=${state.limitBytes || 0}`,
      `overLimit=${state.overLimit === true}`,
      candidates ? `oldestCleanupCandidates:\n${candidates}` : 'oldestCleanupCandidates='
    ].join('\n'));
  }
  if (context.treeIndex) {
    parts.push(`\n文档结构：\n${context.treeIndex}`);
  }
  return parts.join('\n');
}

const AGENT_CHANGE_ACTIONS = new Set([
  'node_patch',
  'node_insert',
  'node_delete',
  'ref_delete',
  'source_bind_path'
]);

function normalizeNodePatch(patch = {}) {
  if (
    Object.prototype.hasOwnProperty.call(patch, 'human_tag') ||
    Object.prototype.hasOwnProperty.call(patch, 'humanTag')
  ) {
    throw new Error('node_patch no longer supports human_tag; set node_type instead');
  }
  const allowed = ['text', 'node_title', 'node_note', 'node_type', 'trust_level'];
  const next = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'title')) next.node_title = patch.title;
  if (Object.prototype.hasOwnProperty.call(patch, 'note')) next.node_note = patch.note;
  if (
    Object.prototype.hasOwnProperty.call(patch, 'type') &&
    !AGENT_CHANGE_ACTIONS.has(String(patch.type || ''))
  ) next.node_type = normalizeNodeType(patch.type);
  if (Object.prototype.hasOwnProperty.call(next, 'node_type')) next.node_type = normalizeNodeType(next.node_type);
  return next;
}

function agentOperationAction(operation = {}) {
  const action = String(operation.action || operation.type || '').trim();
  return AGENT_CHANGE_ACTIONS.has(action) ? action : '';
}

function patchFieldsSchema() {
  return {
    type: 'object',
    properties: {
      text: { type: 'string' },
      node_title: { type: 'string' },
      title: { type: 'string' },
      node_note: { type: 'string' },
      note: { type: 'string' },
      node_type: { type: 'string' },
      trust_level: { type: 'string' }
    }
  };
}

function proposeNodePatchToolSchema() {
  return {
    type: 'object',
    properties: {
      docId: STABLE_ID_SCHEMA,
      address: { type: 'string', description: '要修改的节点地址，例如 1-3-2。' },
      summary: { type: 'string' },
      patch: patchFieldsSchema()
    },
    required: ['address', 'patch']
  };
}

function proposeNodeInsertToolSchema() {
  return {
    type: 'object',
    properties: {
      docId: STABLE_ID_SCHEMA,
      parentAddress: { type: 'string', description: '新节点的父节点地址。' },
      afterAddress: { type: 'string', description: '可选：插入到哪个兄弟节点之后。' },
      summary: { type: 'string' },
      text: { type: 'string' },
      title: { type: 'string' },
      note: { type: 'string' },
      node_type: { type: 'string' }
    },
    required: ['parentAddress', 'text']
  };
}

function proposeNodeDeleteToolSchema() {
  return {
    type: 'object',
    properties: {
      docId: STABLE_ID_SCHEMA,
      address: { type: 'string', description: '要删除的非根节点地址。' },
      summary: { type: 'string' }
    },
    required: ['address']
  };
}

function proposeRefDeleteToolSchema() {
  return {
    type: 'object',
    properties: {
      docId: STABLE_ID_SCHEMA,
      sourceAddress: { type: 'string' },
      targetAddress: { type: 'string' },
      refKind: { type: 'string' },
      summary: { type: 'string' }
    },
    required: ['sourceAddress', 'targetAddress']
  };
}

function proposeSourceBindPathToolSchema() {
  return {
    type: 'object',
    properties: {
      docId: STABLE_ID_SCHEMA,
      sourcePath: { type: 'string', description: 'library 工作区内的相对路径。' },
      sourceType: { type: 'string' },
      summary: { type: 'string' }
    },
    required: ['sourcePath']
  };
}

function workspaceFileToolSchema() {
  return {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'read', 'write', 'delete', 'mkdir', 'move'] },
      path: { type: 'string', description: 'library 工作区内的相对路径，不要使用绝对路径。' },
      toPath: { type: 'string' },
      content: { type: 'string' },
      text: { type: 'string' },
      encoding: { type: 'string', enum: ['utf8', 'base64'] },
      limit: { type: 'number' }
    },
    required: ['action']
  };
}

function importLibraryDocumentToolSchema() {
  return {
    type: 'object',
    properties: {
      relativePath: { type: 'string', description: 'library 工作区内的相对文件路径，不要使用绝对路径。' },
      mode: {
        type: 'string',
        enum: ['simple', 'complete', 'direct', 'smart', 'vector'],
        description: '切分方式，默认 simple。simple=格式识别目录结构并切到段落；complete=simple 后切到句子；smart=simple/complete 后由 LLM 整理目录；vector=按字数切文本块（区别于按句切）；direct=全文不切直接塞到节点 1。建不建向量与切分方式无关，由 embed 决定。'
      },
      embed: {
        type: 'boolean',
        description: '导入后是否同步建立向量（吃性能）。默认 false=后补；true=当场 embed。与 mode 切分方式正交。'
      }
    },
    required: ['relativePath']
  };
}

function deleteLibraryDocumentToolSchema() {
  return {
    type: 'object',
    properties: {
      docId: { ...STABLE_ID_SCHEMA, description: '要删除的已导入数据库文档 id；只删数据库数据，不删 library 真实文件。' }
    },
    required: ['docId']
  };
}

function ensureDocVectorsToolSchema() {
  return {
    type: 'object',
    properties: {
      docId: { ...STABLE_ID_SCHEMA, description: '已导入文档 id。只补当前缺失或正文已变更节点的语义向量；节点重挂或地址变化不触发重算。' }
    },
    required: ['docId']
  };
}

function webSearchToolSchema() {
  return {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['search', 'open'] },
      query: { type: 'string' },
      q: { type: 'string' },
      url: { type: 'string' },
      limit: { type: 'number' },
      charLimit: { type: 'number' }
    }
  };
}

function bashToolSchema() {
  return {
    type: 'object',
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string' },
      timeoutMs: { type: 'number' }
    },
    required: ['command']
  };
}

function blockedIpv4(hostname) {
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function blockedIpv6(hostname) {
  const text = hostname.toLowerCase();
  if (text === '::1' || text === '::') return true;
  if (text.startsWith('fe80:') || text.startsWith('fc') || text.startsWith('fd')) return true;
  if (text.startsWith('::ffff:')) {
    const mapped = text.slice('::ffff:'.length);
    return isIP(mapped) === 4 ? blockedIpv4(mapped) : true;
  }
  return false;
}

function assertAgentOpenUrlAllowed(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('web_search open 需要合法 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('web_search open 只允许 http 或 https URL');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname) throw new Error('web_search open 需要 URL 主机名');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('web_search open 禁止访问 localhost');
  }
  if (!hostname.includes('.') && isIP(hostname) === 0) {
    throw new Error('web_search open 禁止访问内网短主机名');
  }
  const ipVersion = isIP(hostname);
  if (ipVersion === 4 && blockedIpv4(hostname)) throw new Error('web_search open 禁止访问内网或保留 IPv4 地址');
  if (ipVersion === 6 && blockedIpv6(hostname)) throw new Error('web_search open 禁止访问内网或保留 IPv6 地址');
  return url.toString();
}

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function stripHtml(value = '') {
  return decodeHtmlEntities(String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function normalizeDuckDuckGoUrl(raw = '') {
  const text = decodeHtmlEntities(raw);
  try {
    const parsed = new URL(text, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    return uddg || parsed.href;
  } catch {
    return text;
  }
}

function parseDuckDuckGoResults(html, limit) {
  const results = [];
  const blocks = String(html || '').split(/<div class="result results_links[^>]*>/i).slice(1);
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippet = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    const url = normalizeDuckDuckGoUrl(link[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: stripHtml(link[2]),
      url,
      snippet: stripHtml(snippet?.[1] || '')
    });
    if (results.length >= limit) break;
  }
  return results;
}

function parseToolArgs(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function jsonPreview(value, limit = 900) {
  try {
    return clipText(JSON.stringify(sanitize(value), null, 2), limit);
  } catch {
    return clipText(String(value || ''), limit);
  }
}

function toolDisplayPreview(name, result = {}, limit = 5000) {
  if (name === 'bash') {
    const stdout = result.stdout == null ? '' : String(result.stdout);
    const stderr = result.stderr == null ? '' : String(result.stderr);
    return clipText([stdout, stderr].filter(Boolean).join(stdout && stderr ? '\n' : '').trimEnd(), limit);
  }
  if (result?.format === 'ascii_tree' && typeof result.text === 'string') {
    return clipText(result.text.trimEnd(), limit);
  }
  return null;
}

function appendAgentToolCallDelta(toolCalls, delta = {}) {
  const index = Number.isFinite(Number(delta.index)) ? Number(delta.index) : 0;
  const current = toolCalls[index] || { id: '', type: 'function', function: { name: '', arguments: '' } };
  if (delta.id) current.id = delta.id;
  if (delta.type) current.type = delta.type;
  if (!current.function) current.function = { name: '', arguments: '' };
  if (delta.function?.name) current.function.name = `${current.function.name || ''}${delta.function.name}`;
  if (delta.function?.arguments) current.function.arguments = `${current.function.arguments || ''}${delta.function.arguments}`;
  toolCalls[index] = current;
}

function appendReasoningContent(message, value) {
  if (!value) return;
  message.reasoning_content = `${message.reasoning_content || ''}${value}`;
}

function agentAssistantMessageForHistory(message, toolCalls) {
  return {
    role: 'assistant',
    content: message.content || '',
    reasoning_content: message.reasoning_content || undefined,
    tool_calls: toolCalls
  };
}

function anthropicTextBlock(text) {
  return { type: 'text', text: String(text || '') };
}

function parseToolInput(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    return value ? JSON.parse(String(value)) : {};
  } catch {
    return {};
  }
}

function mergeAnthropicMessage(messages, message) {
  if (!message?.role || !Array.isArray(message.content) || message.content.length === 0) return;
  const last = messages[messages.length - 1];
  if (last?.role === message.role) {
    last.content.push(...message.content);
    return;
  }
  messages.push(message);
}

function anthropicMessages(openaiMessages = []) {
  const system = [];
  const messages = [];
  for (const item of openaiMessages) {
    const role = item?.role;
    const content = String(item?.content || '');
    if (role === 'system') {
      if (content) system.push(content);
      continue;
    }
    if (role === 'assistant') {
      const blocks = [];
      if (content) blocks.push(anthropicTextBlock(content));
      for (const call of Array.isArray(item.tool_calls) ? item.tool_calls : []) {
        const name = call?.function?.name || '';
        if (!name) continue;
        blocks.push({
          type: 'tool_use',
          id: call.id || `tool-${blocks.length}`,
          name,
          input: parseToolInput(call.function?.arguments)
        });
      }
      mergeAnthropicMessage(messages, { role: 'assistant', content: blocks });
      continue;
    }
    if (role === 'tool') {
      mergeAnthropicMessage(messages, {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: item.tool_call_id || '',
          content
        }]
      });
      continue;
    }
    mergeAnthropicMessage(messages, { role: 'user', content: [anthropicTextBlock(content)] });
  }
  return { system: system.join('\n\n'), messages };
}

function anthropicTools(openaiTools = []) {
  return openaiTools
    .map((tool) => {
      const fn = tool?.function || {};
      if (!fn.name) return null;
      return {
        name: fn.name,
        description: fn.description || '',
        input_schema: fn.parameters || { type: 'object', properties: {} }
      };
    })
    .filter(Boolean);
}

function agentMessageFromAnthropic(json = {}, api = {}) {
  const contentBlocks = Array.isArray(json.content) ? json.content : [];
  const text = contentBlocks
    .filter((block) => block?.type === 'text')
    .map((block) => block.text || '')
    .join('');
  const reasoning = contentBlocks
    .filter((block) => block?.type === 'thinking')
    .map((block) => block.thinking || block.text || '')
    .join('');
  const toolCalls = contentBlocks
    .filter((block) => block?.type === 'tool_use' && block.name)
    .map((block) => ({
      id: block.id || '',
      type: 'function',
      function: {
        name: block.name,
        arguments: JSON.stringify(block.input || {})
      }
    }));
  return {
    role: 'assistant',
    content: text,
    reasoning_content: reasoning || undefined,
    tool_calls: toolCalls,
    usage: normalizeAgentUsage(json.usage, api)
  };
}

function positiveTokenLimit(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return Math.round(number);
  }
  return 0;
}

function configuredContextLimit(api = {}, rawUsage = {}) {
  return positiveTokenLimit(
    api.contextLimit,
    api.contextWindowTokens,
    api.contextWindow,
    api.maxContextTokens,
    api.modelCard?.contextLimit,
    api.modelCard?.contextWindowTokens,
    api.metadata?.contextLimit,
    rawUsage?.contextLimit,
    rawUsage?.context_limit,
    rawUsage?.context_window,
    rawUsage?.model_context_limit
  );
}

function usageNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return 0;
}

function optionalUsageNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function normalizeAgentUsage(rawUsage, api = {}) {
  const cachedTokens = usageNumber(
    rawUsage?.prompt_cache_hit_tokens,
    rawUsage?.input_token_details?.cache_read,
    rawUsage?.prompt_tokens_details?.cached_tokens
  );
  const cacheMissTokens = optionalUsageNumber(rawUsage?.prompt_cache_miss_tokens);
  const directPromptTokens = optionalUsageNumber(
    rawUsage?.prompt_tokens,
    rawUsage?.input_tokens,
    rawUsage?.usage?.prompt_tokens
  );
  const promptTokens = directPromptTokens ?? (
    cacheMissTokens !== null || cachedTokens > 0 ? cachedTokens + usageNumber(cacheMissTokens) : 0
  );
  const resolvedCacheMissTokens = cacheMissTokens ?? Math.max(0, promptTokens - cachedTokens);
  const completionTokens = usageNumber(rawUsage?.completion_tokens, rawUsage?.output_tokens);
  const reasoningTokens = usageNumber(
    rawUsage?.completion_tokens_details?.reasoning_tokens,
    rawUsage?.output_token_details?.reasoning_tokens
  );
  const totalTokens = usageNumber(rawUsage?.total_tokens, promptTokens + completionTokens);
  const contextLimit = configuredContextLimit(api, rawUsage);
  return {
    model: api.model || '',
    providerName: api.providerName || '',
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheMissTokens: resolvedCacheMissTokens,
    reasoningTokens,
    contextLimit,
    ratio: contextLimit > 0 ? Math.min(1, promptTokens / contextLimit) : 0,
    raw: rawUsage
  };
}

function pushHistoryValue(list, value, limit = 12, maxChars = 320) {
  if (!Array.isArray(list) || list.length >= limit) return;
  const text = clipText(String(value || '').replace(/\s+/g, ' ').trim(), maxChars);
  if (!text || list.includes(text)) return;
  list.push(text);
}

// 跨轮历史压缩走「结构压缩」而非语义摘要：内置 agent 的核心目标是定位
//（把 doc/address/path 找出来），不是记住正文——正文持久化在数据库里，
// 有指针随时可以用工具重新读取。所以旧轮次只保留结构性事实（谁、调了什么
// 工具、触达了哪些位置、一句话结论），不做关键词分类，不伪造确定性。
const HISTORY_PATH_PATTERN = /(?:[A-Za-z]:[\\/][^\s`"'，。；：)）]+|(?:src|electron|docs|tests|scripts)[\\/][\w./\\-]+|projectneed\.md|package\.json|vite\.config\.[\w.]+)/g;
const HISTORY_TARGET_PATTERN = /\b(?:doc#?\d[0-9a-z-]*|doc id [0-9a-z][0-9a-z-]*|docId[:= ]+[0-9a-z][0-9a-z-]*|node id [0-9a-z][0-9a-z-]*|nodeId[:= ]+[0-9a-z][0-9a-z-]*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+(?:-\d+)+)\b/gi;
const HISTORY_BUDGET_CHARS = 18000;
const HISTORY_BUDGET_CHARS_TIGHT = 10000;
const HISTORY_TARGET_LIMIT = 24;
const HISTORY_LEDGER_LINE_LIMIT = 40;

function pushTurnTargetsFromText(list, content) {
  const text = String(content || '');
  if (!text) return;
  for (const match of text.matchAll(HISTORY_TARGET_PATTERN)) pushHistoryValue(list, match[0], HISTORY_TARGET_LIMIT, 120);
  for (const match of text.matchAll(HISTORY_PATH_PATTERN)) pushHistoryValue(list, match[0], HISTORY_TARGET_LIMIT, 200);
}

// argsPreview 是 jsonPreview 的产物，可能被截断导致 parse 失败——失败就退回正则。
function pushTurnTargetsFromPreview(list, preview) {
  const text = String(preview || '');
  if (!text) return;
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') {
    pushTurnTargetsFromText(list, text);
    return;
  }
  const docId = normalizeStableId(parsed.docId ?? parsed.doc_id, null);
  const nodeId = normalizeStableId(parsed.nodeId ?? parsed.node_id, null);
  const address = String(parsed.address || '').trim();
  if (docId || nodeId || address) {
    const head = docId ? `doc ${docId}` : '';
    const at = address ? `@${address}` : (nodeId ? `node ${nodeId}` : '');
    pushHistoryValue(list, [head, at].filter(Boolean).join(' '), HISTORY_TARGET_LIMIT, 120);
  }
  const path = String(parsed.path || parsed.relativePath || '').trim();
  if (path) pushHistoryValue(list, path, HISTORY_TARGET_LIMIT, 200);
  const query = String(parsed.query || parsed.q || '').trim()
    || (Array.isArray(parsed.terms) ? parsed.terms.filter(Boolean).join(' ') : '');
  if (query) pushHistoryValue(list, `q:"${clipText(query, 40)}"`, HISTORY_TARGET_LIMIT, 60);
}

function historyTurnTargets(item = {}) {
  const targets = [];
  for (const event of item.toolEvents || []) {
    pushTurnTargetsFromPreview(targets, event?.argsPreview);
  }
  pushTurnTargetsFromText(targets, item.content);
  return targets;
}

function historyTurnToolsLine(toolEvents = []) {
  const counts = new Map();
  for (const event of toolEvents) {
    const name = String(event?.name || '').trim();
    if (!name || name === 'default_context') continue;
    const entry = counts.get(name) || { total: 0, errors: 0 };
    entry.total += 1;
    if (event?.status === 'error') entry.errors += 1;
    counts.set(name, entry);
  }
  return Array.from(counts.entries())
    .map(([name, { total, errors }]) => `${name}×${total}${errors > 0 ? `(err${errors})` : ''}`)
    .join(', ');
}

function historyLedgerLine(item, turn, targets = []) {
  const head = clipText(String(item.content || '').replace(/\s+/g, ' ').trim(), 2000);
  if (item.role === 'user') return `T${turn} Master：${head}`;
  const parts = [`T${turn} assistant(${item.mode})：${head}`];
  const tools = historyTurnToolsLine(item.toolEvents);
  if (tools) parts.push(`tools: ${tools}`);
  if (targets.length > 0) parts.push(`targets: ${targets.slice(0, 8).join('，')}`);
  return parts.join(' | ');
}

function buildHistoryLedger(items = []) {
  const lines = [];
  const touched = [];
  let turn = 0;
  for (const item of items) {
    if (item.role === 'user') turn += 1;
    const targets = historyTurnTargets(item);
    for (const target of targets) pushHistoryValue(touched, target, HISTORY_TARGET_LIMIT, 200);
    lines.push(historyLedgerLine(item, turn, targets));
  }
  // 极端长会话下逐行轨迹自身也会膨胀：只保留最近若干行，更早的触达位置
  // 已并入聚合（targets 是全量扫的），逐行细节按激进压缩原则放弃。
  const visibleLines = lines.length > HISTORY_LEDGER_LINE_LIMIT
    ? [`（更早 ${lines.length - HISTORY_LEDGER_LINE_LIMIT} 条消息的逐行轨迹已省略，其触达位置已并入下方聚合。）`, ...lines.slice(-HISTORY_LEDGER_LINE_LIMIT)]
    : lines;
  return [
    `以下是旧轮次的结构化轨迹（共 ${items.length} 条消息，正文已省略）。数据库是唯一权威：需要旧轮次涉及的内容时，按 docId/address/path 用工具重新读取，不要凭记忆引用旧正文。更早轮次若有范围或禁止类指令，此处未保留——以最近消息和本轮指令为准，不确定时先问 Master。`,
    ...visibleLines,
    touched.length > 0 ? `已触达位置：${touched.join('；')}` : ''
  ].filter(Boolean).join('\n');
}

function compactAgentHistory(history = [], contextUsage = {}) {
  if (!Array.isArray(history) || history.length === 0) return [];
  const ratio = Number(contextUsage?.ratio) || 0;
  const clean = history
    .map((item) => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      mode: agentModeText(normalizeAgentMode(item?.mode)),
      content: String(item?.content || item?.answer || '').trim(),
      toolEvents: Array.isArray(item?.toolEvents) ? item.toolEvents : []
    }))
    .filter((item) => item.content);
  if (clean.length === 0) return [];
  // 触发看本次 history 自身的体量；上一轮的 ratio 只用来收紧（首轮 ratio 恒 0，
  // 不能拿它当放行依据）。
  const tight = ratio > 0.75;
  const budget = tight ? HISTORY_BUDGET_CHARS_TIGHT : HISTORY_BUDGET_CHARS;
  const totalChars = clean.reduce((sum, item) => sum + item.content.length, 0);
  if (totalChars <= budget) {
    return clean.map((item) => ({
      role: item.role,
      content: item.content
    }));
  }
  const keepCount = tight ? 4 : 6;
  const recent = clean.slice(-keepCount);
  const older = clean.slice(0, Math.max(0, clean.length - keepCount));
  const messages = [];
  if (older.length > 0) {
    messages.push({ role: 'system', content: buildHistoryLedger(older) });
  }
  // 压缩之外纯拼接：recent 区原文不截断、不随档位改写——同一条历史消息在
  // 跨轮请求里保持逐字节稳定，避免无谓打碎 prompt 缓存前缀。
  for (const item of recent) {
    messages.push({
      role: item.role,
      content: item.content
    });
  }
  return messages;
}

function storedSessionHistory(session = null) {
  if (!session) return [];
  const result = session.result || {};
  if (Array.isArray(result.messages)) return result.messages;
  const messages = [];
  if (session.prompt) {
    messages.push({
      role: 'user',
      mode: session.mode,
      content: session.prompt
    });
  }
  if (result.answer || result.error) {
    messages.push({
      role: 'assistant',
      mode: session.mode,
      content: result.answer || result.error
    });
  }
  return messages;
}

function mergeAgentHistorySources(...sources) {
  const merged = [];
  const seen = new Set();
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const item of source) {
      const role = item?.role === 'assistant' ? 'assistant' : 'user';
      const mode = normalizeAgentMode(item?.mode);
      const content = String(item?.content || item?.answer || '').trim();
      if (!content) continue;
      const key = `${role}\n${mode}\n${content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...item, role, mode, content });
    }
  }
  return merged;
}

const TOOL_RESULT_FULL_JSON_LIMIT = 60000;

function toolPointerFromNode(node = {}, fallbackDocId = null) {
  const docId = normalizeStableId(node.docId ?? node.doc_id ?? fallbackDocId, null);
  const nodeId = normalizeStableId(node.nodeId ?? node.id, null);
  const address = String(node.address || '').trim();
  if (!docId && !nodeId && !address) return null;
  return {
    kind: 'node',
    docId: docId || undefined,
    nodeId: nodeId || undefined,
    address: address || undefined
  };
}

function pushPointer(list, pointer = null) {
  if (!pointer || typeof pointer !== 'object') return;
  const clean = Object.fromEntries(Object.entries(pointer).filter(([, value]) => value !== undefined && value !== ''));
  if (Object.keys(clean).length === 0) return;
  const key = JSON.stringify(clean);
  if (list.some((item) => JSON.stringify(item) === key)) return;
  list.push(clean);
}

function collectToolPointers(name, args = {}, result = {}) {
  const pointers = [];
  const action = String(args.action || result.kind || '').trim();
  const docId = normalizeStableId(args.docId ?? args.doc_id ?? result.docId ?? result.doc_id, null);
  const nodeId = normalizeStableId(args.nodeId ?? args.node_id, null);
  const address = String(args.address || result.rootAddress || '').trim();
  const query = String(args.query || args.q || result.query || '').trim();
  const terms = Array.isArray(args.terms) ? args.terms : Array.isArray(result.terms) ? result.terms : null;
  const command = String(args.command || result.command || '').trim();
  const path = String(args.path || args.relativePath || result.path || result.relativePath || '').trim();
  const url = String(args.url || result.url || '').trim();
  const functionName = String(args.functionName || args.function || args.symbol || result.functionName || result.function || '').trim();
  const depthRange = result.depthRange || (
    args.minDepth || args.min_depth || args.maxDepth || args.max_depth
      ? {
          from: args.minDepth ?? args.min_depth,
          to: args.maxDepth ?? args.max_depth
        }
      : undefined
  );
  pushPointer(pointers, {
    kind: 'query',
    tool: name,
    action: action || undefined,
    docId: docId || undefined,
    nodeId: nodeId || undefined,
    address: address || undefined,
    query: query || undefined,
    terms: terms && terms.length ? terms : undefined,
    offset: args.offset ?? args.startOffset ?? args.start_offset,
    limit: args.limit,
    depthRange
  });
  if (command) pushPointer(pointers, { kind: 'command', command });
  if (path) pushPointer(pointers, { kind: 'file', path });
  if (result.sourceDocument?.original_path) pushPointer(pointers, { kind: 'file', path: result.sourceDocument.original_path });
  if (result.sourceDocument?.path) pushPointer(pointers, { kind: 'file', path: result.sourceDocument.path });
  if (url) pushPointer(pointers, { kind: 'url', url });
  if (functionName) pushPointer(pointers, { kind: 'function', name: functionName });
  if (docId) {
    pushPointer(pointers, {
      kind: 'node',
      docId,
      nodeId: nodeId || undefined,
      address: address || undefined
    });
  }
  pushPointer(pointers, toolPointerFromNode(result.node, docId));
  pushPointer(pointers, toolPointerFromNode(result.tree, docId));
  pushPointer(pointers, toolPointerFromNode(result.root, docId));
  return pointers;
}

function toolResultReturnedCount(result = {}) {
  if (result.returned !== undefined) return result.returned;
  if (result.rowCount !== undefined) return result.rowCount;
  for (const key of ['rows', 'nodes', 'docs']) {
    if (Array.isArray(result[key])) return result[key].length;
  }
  return undefined;
}

function toolResultStatus(result = {}) {
  if (result?.rejected) return 'rejected';
  if (result?.ok === false || result?.error) return 'error';
  const exitCode = Number(result?.exitCode);
  if (Number.isFinite(exitCode) && exitCode !== 0) return 'error';
  return 'ok';
}

function toolErrorSummary(result = {}) {
  const raw = [
    result?.reason,
    result?.error?.message,
    result?.error,
    result?.stderr
  ].filter(Boolean).map((value) => String(value)).join('\n');
  return raw ? clipText(raw.split(/\r?\n/).filter(Boolean).slice(0, 6).join('\n'), 1200) : '';
}

function summarizeToolResultForHistory(name, args = {}, result = {}, resultJson = '') {
  if (resultJson.length <= TOOL_RESULT_FULL_JSON_LIMIT) return resultJson;
  const pointers = collectToolPointers(name, args, result);
  const status = toolResultStatus(result);
  const summary = {
    kind: 'tool_result_summary',
    tool: name,
    status,
    action: String(args.action || result.kind || result.mode || '').trim() || undefined,
    command: args.command || result.command || undefined,
    originalCharLength: resultJson.length,
    omittedFullOutput: true,
    counts: {
      returned: toolResultReturnedCount(result),
      total: result.total,
      truncated: result.truncated
    },
    pointers,
    error: toolErrorSummary(result) || undefined,
    conclusion: status === 'ok'
      ? '工具已返回长结果，完整内容未写入模型历史。'
      : '工具调用未成功，保留错误摘要供模型修正参数。',
    next: pointers.length > 0
      ? '需要完整内容时，按 pointers 中的 action、docId、address、nodeId、path、url 或 command 重新读取。'
      : '需要完整内容时，用更窄的查询条件重新调用同一工具。'
  };
  return JSON.stringify(sanitize(summary));
}

const REQUIRED_DEPS = [
  'getAgentStore', 'refreshDoc', 'readAgentSettings',
  'agentApiFromPayload', 'systemPromptSection', 'libraryPath',
  'libraryRelativePathForAgent'
];

// schema 自述（15-12-5）：接入第一读物，数百 token 的约定说明，不是内容清单。
// 正文维护在 system_prompt.md 的 memory.schema 段；这里是文件缺失时的回退。
const MEMORY_SCHEMA_FALLBACK = [
  '本库按时态分三层，结构同构（同一套树地址与检索动词）、语义异质：完整记忆（session 事件卷）答"确曾发生"——一个 session 一卷，只追加、封卷不可变、永不删除；长期核心记忆答"现在如此"——经提炼与人工审批产生的当前事实层，每条事实回指事件出处；知识文档答"未来可用"——导入的资料文档。',
  '你有跨会话记忆：开工先看最近发生过什么（`db memory list` 列卷及状态，按 docId 用 tree/read 下钻卷正文），再看工作区文件。知道库里有什么是检索的产物、不是检索的前提——别等清单，直接检索。',
  '信任语义：节点分受控/不受控两级。受控=经人工审批的结论；不受控=机器产物未经人审——事件卷一律不受控，这是层级的时态属性，不是质量评分。命中未解决的 ERROR 节点必须停下向用户报告，不得绕过续跑。',
  '时间纪律：召回结果附带时间元数据，采信前先看时间；同主题证据冲突时新者胜，不得以"内容看起来更合理"推翻时间新旧——合理感是模型先验，时间是客观信号；找不到更新的证据时，旧证据就是最佳可用证据，知旧而用。',
  '更详尽的记忆库使用（召回动线、写入边界与提炼、操作要点）见 docs/memory.md。'
].join('\n');

// 内置自动落卷的 session→节点树转换（15-10-2）：消息粒度局部展开——一条消息一个节点，
// 工具事件作为助手消息的子节点；事件卷一律不受控（15-10-3）。
export function volumeNodesFromTurnMessages(messages = []) {
  const nodes = [];
  for (const message of messages) {
    if (!message) continue;
    const note = message.createdAt ? `@ ${message.createdAt}` : '';
    if (message.role === 'user') {
      nodes.push({
        node_title: `用户 · ${message.mode || ''}`.trim(),
        node_note: note,
        text: String(message.content || ''),
        trust_level: '不受控'
      });
      continue;
    }
    const children = (Array.isArray(message.toolEvents) ? message.toolEvents : []).map((event) => ({
      node_title: `工具 ${event?.name || 'tool'} · ${event?.status || ''}`.trim(),
      text: [
        event?.argsPreview ? `args: ${event.argsPreview}` : '',
        event?.error ? `error: ${event.error}` : '',
        event?.resultPreview ? `result: ${event.resultPreview}` : ''
      ].filter(Boolean).join('\n'),
      trust_level: '不受控'
    }));
    nodes.push({
      node_title: `助手 · ${message.status || '完成'}`,
      node_note: note,
      text: String(message.content || ''),
      trust_level: '不受控',
      children
    });
  }
  return nodes;
}

export function createAgentRuntime(deps = {}) {
  for (const key of REQUIRED_DEPS) {
    if (typeof deps[key] !== 'function') {
      throw new Error(`createAgentRuntime: missing required dep "${key}"`);
    }
  }
  if (!deps.database) {
    throw new Error('createAgentRuntime: missing required dep "database"');
  }

  const sendAgentStream = (requestId, event) => {
    if (!requestId) return;
    deps.sendAgentStream?.(requestId, event);
  };

  const database = () => {
    const value = typeof deps.database === 'function' ? deps.database() : deps.database;
    if (!value || typeof value.run !== 'function') {
      throw new Error('createAgentRuntime: database service is not available');
    }
    return value;
  };
  const getAgentStore = () => deps.getAgentStore();
  const readAgentSettings = () => deps.readAgentSettings();
  const getToolSettings = () => normalizeAgentToolSettings(readAgentSettings().toolSettings || {});
  const activeAgentRequests = new Map();

  function docForAgent(docId) {
    const normalizedDocId = normalizeStableId(docId, null);
    if (!normalizedDocId) throw new Error('Document id is required');
    const doc = deps.refreshDoc(normalizedDocId);
    if (!doc) throw new Error(`Document not found: ${docId}`);
    return doc;
  }

  async function buildAgentContext(payload = {}) {
    const docId = normalizeStableId(payload.docId, null);
    const mode = normalizeAgentMode(payload.mode);
    let file = null;
    let selectedNode = null;
    let treeIndex = '';
    if (docId) {
      const docsResult = await database().run({
        operation: 'read',
        payload: { action: 'content.listDocs', include: 'source,timestamps' }
      }, 'read');
      const doc = (docsResult?.docs || []).find((item) => sameStableId(item.docId, docId)) || null;
      file = doc ? agentDocInfoFromContentDoc(doc) : null;
      const indexResult = await database().run({
        operation: 'read',
        payload: {
          action: 'content.getIndex',
          docId,
          depth: normalizeContextDepth(payload),
          format: 'ascii_tree',
          detail: 'summary'
        }
      }, 'read');
      treeIndex = String(indexResult?.text || '');
      const selectedNodeId = normalizeStableId(payload.selectedNodeId, null);
      if (selectedNodeId) {
        selectedNode = await database().run({
          operation: 'read',
          payload: { action: 'node.get', docId, nodeId: selectedNodeId }
        }, 'read');
      }
    }
    return {
      file,
      permissions: agentPermissionsForMode(mode),
      selectedNode: selectedNode ? {
        docId: selectedNode.doc_id,
        nodeId: selectedNode.id,
        address: selectedNode.address
      } : null,
      treeIndex,
      llmWorkspace: deps.llmWorkspaceStatus?.() || null
    };
  }

  async function proposeAgentChanges(args = {}, sessionId, context = {}) {
    const operations = Array.isArray(args.operations) ? args.operations : [];
    if (operations.length === 0) throw new Error('agent change proposal requires one operation');
    // A2A 提议进 owner=llm:<会话> 影子分支（A5-5 写入者身份+会话隔离），不再写独立 agent_diffs 存储；
    // 走与 edit 动词同一条 database.write 路径，外部 agent 用统一 changes/merge/discard 审批（projectneed 18-1）。
    const owner = `llm:${sessionId}`;
    const stage = (payload, docId) => database().write(payload, { editBranchOwner: owner, editBranchBaseDocId: docId });
    const created = [];
    for (const operation of operations) {
      const action = agentOperationAction(operation);
      if (!action) throw new Error(`Unsupported agent change action: ${operation.action || operation.type || 'empty'}`);
      if (action === 'source_bind_path') {
        // source 路径绑定是文件元数据、不是文档节点编辑，不走 A5-5 待审分支（15-4 待审=节点编辑）；由 full 档直接绑定。
        return { rejected: true, reason: 'source 路径绑定不走待审分支；请用 full 档直接绑定。' };
      }
      const docId = normalizeStableId(operation.docId || context.file?.docId, null);
      if (!docId) throw new Error('Agent change proposal requires a doc id');
      const doc = docForAgent(docId);
      if (action === 'node_patch') {
        const node = findNodeByIdOrAddress(doc, operation);
        if (!node) throw new Error('Agent node_patch target not found');
        const patch = normalizeNodePatch(operation.patch || operation);
        if (Object.keys(patch).length === 0) throw new Error('node_patch requires patch fields');
        const result = await stage({ action: 'node.update', nodeId: node.id, patch }, docId);
        created.push({ ...result, summary: operation.summary || `修改节点 ${node.address}` });
      } else if (action === 'node_insert') {
        const parentAddress = String(operation.parentAddress || operation.parent || context.selectedNode?.address || '1').trim();
        const parentId = doc.idByAddress?.[parentAddress];
        if (!parentId) throw new Error(`node_insert parent not found: ${parentAddress}`);
        const afterAddress = String(operation.afterAddress || '').trim();
        const requestedAfterNodeId = normalizeStableId(operation.afterNodeId, null);
        const afterNodeId = requestedAfterNodeId
          ? requestedAfterNodeId
          : (afterAddress ? doc.idByAddress?.[afterAddress] || null : null);
        const result = await stage({
          action: 'node.insert',
          docId,
          parentId,
          afterNodeId,
          text: String(operation.text || ''),
          nodeTitle: String(operation.node_title || operation.title || ''),
          nodeNote: String(operation.node_note || operation.note || ''),
          nodeType: normalizeNodeType(operation.node_type || operation.type || 'TEXT')
        }, docId);
        created.push({ ...result, summary: operation.summary || `在 ${parentAddress} 下新增节点` });
      } else if (action === 'node_delete') {
        const node = findNodeByIdOrAddress(doc, operation);
        if (!node || node.parent_id === null) throw new Error('Agent node_delete target not found or root cannot be deleted');
        const result = await stage({ action: 'node.delete', docId, nodeId: node.id }, docId);
        created.push({ ...result, summary: operation.summary || `删除节点 ${node.address}` });
      } else if (action === 'ref_delete') {
        const refId = normalizeStableId(operation.refId, null);
        let ref = refId ? doc.refs.find((item) => sameStableId(item.id, refId)) : null;
        if (!ref) {
          const sourceAddress = String(operation.sourceAddress || operation.source || '').trim();
          const targetAddress = String(operation.targetAddress || operation.target || '').trim();
          const refKind = String(operation.refKind || operation.kind || '').trim();
          ref = doc.refs.find((item) => (
            (!sourceAddress || item.source_address === sourceAddress)
            && (!targetAddress || item.target_address === targetAddress)
            && (!refKind || item.ref_kind === refKind)
          )) || null;
        }
        if (!ref) throw new Error('Agent ref_delete target not found');
        const result = await stage({ action: 'ref.delete', docId, refId: ref.id }, docId);
        created.push({ ...result, summary: operation.summary || `删除引用 ${ref.source_address} -> ${ref.target_address}` });
      }
    }
    return created;
  }

  function agentWorkspaceFile(args = {}, permissions = agentPermissionsForMode('qa')) {
    const action = String(args.action || 'read').trim();
    const relativePath = deps.normalizeAgentLibraryPath(args.path || args.relativePath || '');
    const canRead = Boolean(permissions.localFiles?.canRead);
    const canWrite = Boolean(permissions.localFiles?.canWrite);
    const assertRead = () => {
      if (!canRead) throw new Error('当前模式没有读取本地工作区文件的权限');
    };
    const assertWrite = () => {
      if (!canWrite) throw new Error('当前模式没有写入本地工作区文件的权限');
    };
    if (action === 'list') {
      assertRead();
      return deps.listLibraryChildren(relativePath).map((entry) => ({
        type: entry.type,
        path: entry.relativePath,
        size: entry.size,
        extension: entry.extension
      }));
    }
    if (action === 'read') {
      assertRead();
      const full = deps.libraryPath(relativePath);
      const stat = statSync(full);
      if (stat.isDirectory()) throw new Error('不能按文件读取文件夹');
      const encoding = String(args.encoding || 'utf8').toLowerCase();
      const limit = Math.max(1, Math.min(2_000_000, Number(args.limit) || 120_000));
      if (encoding === 'base64') {
        const raw = readFileSync(full);
        const content = raw.toString('base64');
        return {
          path: relativePath,
          encoding: 'base64',
          size: stat.size,
          extension: extname(relativePath).toLowerCase(),
          content: content.slice(0, limit),
          truncated: content.length > limit
        };
      }
      const text = readFileSync(full, 'utf8');
      return {
        path: relativePath,
        encoding: 'utf8',
        size: stat.size,
        extension: extname(relativePath).toLowerCase(),
        content: clipText(text, limit),
        truncated: text.length > limit
      };
    }
    if (action === 'write') {
      assertWrite();
      if (!relativePath) throw new Error('写入文件必须提供相对路径');
      const full = deps.libraryPath(relativePath);
      mkdirSync(dirname(full), { recursive: true });
      const encoding = String(args.encoding || 'utf8').toLowerCase();
      if (encoding === 'base64') writeFileSync(full, Buffer.from(String(args.content || ''), 'base64'));
      else writeFileSync(full, String(args.content ?? args.text ?? ''), 'utf8');
      deps.notifyLibraryChanged?.();
      return { ok: true, action, path: relativePath };
    }
    if (action === 'delete') {
      assertWrite();
      if (!relativePath) throw new Error('删除文件必须提供相对路径');
      rmSync(deps.libraryPath(relativePath), { recursive: true, force: true });
      deps.notifyLibraryChanged?.();
      return { ok: true, action, path: relativePath };
    }
    if (action === 'mkdir') {
      assertWrite();
      if (!relativePath) throw new Error('新建文件夹必须提供相对路径');
      mkdirSync(deps.libraryPath(relativePath), { recursive: true });
      deps.notifyLibraryChanged?.();
      return { ok: true, action, path: relativePath };
    }
    if (action === 'move') {
      assertWrite();
      const toPath = deps.normalizeAgentLibraryPath(args.toPath || args.targetPath || '');
      if (!relativePath || !toPath) throw new Error('移动文件必须提供 path 和 toPath');
      const from = deps.libraryPath(relativePath);
      const to = deps.libraryPath(toPath);
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      deps.updateImportedSourcePaths?.(from, to, statSync(to).isDirectory());
      deps.notifyLibraryChanged?.();
      return { ok: true, action, path: relativePath, toPath };
    }
    throw new Error(`不支持的工作区文件操作：${action}`);
  }

  async function fetchTextUrl(url, { timeoutMs = 12000, signal = null } = {}) {
    const response = await fetchLlmResponse(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 IF-Tree-Agent-WebSearch/1.0',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5'
      }
    }, {
      fetchers: deps.fetchers?.(),
      timeoutMs,
      signal,
      errorPrefix: '网页读取失败'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }

  async function agentWebSearch(args = {}, { signal = null } = {}) {
    assertNotAborted(signal);
    const toolSettings = getToolSettings();
    const mode = String(args.mode || (args.url ? 'open' : 'search')).trim();
    const limit = Math.max(1, Math.min(toolSettings.webSearchResultLimit, Number(args.limit) || toolSettings.webSearchResultLimit));
    if (mode === 'open') {
      const url = assertAgentOpenUrlAllowed(args.url || '');
      const html = await fetchTextUrl(url, { signal });
      return {
        mode,
        url,
        title: stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''),
        content: clipText(stripHtml(html), Math.max(1000, Math.min(toolSettings.webOpenCharLimit, Number(args.charLimit) || toolSettings.webOpenCharLimit)))
      };
    }
    const query = String(args.query || args.q || '').trim();
    if (!query) throw new Error('web_search search 需要 query');
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const html = await fetchTextUrl(url, { signal });
    return {
      mode: 'search',
      query,
      results: parseDuckDuckGoResults(html, limit)
    };
  }

  function splitCommandLine(command = '') {
    const text = String(command || '');
    const args = [];
    let current = '';
    let quote = '';
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (char === quote) quote = '';
        else current += char;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (/\s/.test(char)) {
        if (current) {
          args.push(current);
          current = '';
        }
        continue;
      }
      current += char;
    }
    if (current) args.push(current);
    return args;
  }

  function pathInside(target, root) {
    const targetKey = resolve(String(target || '')).toLowerCase();
    const rootKey = resolve(String(root || '')).toLowerCase();
    return targetKey === rootKey || targetKey.startsWith(`${rootKey}${sep}`);
  }

  function resolveAgentShellCwd(value = '') {
    const workspaceRoot = deps.llmWorkspacePath?.() || '';
    const libraryRoot = deps.libraryPath('');
    const raw = String(value || '').trim();
    if (!raw || raw === '.' || raw === 'workspace' || raw === '.iftree-llm-workspace') return workspaceRoot;
    if (raw === 'library') return libraryRoot;
    const target = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')
      ? resolve(raw)
      : resolve(workspaceRoot, raw);
    if (pathInside(target, workspaceRoot) || pathInside(target, libraryRoot)) return target;
    throw new Error('bash cwd must stay inside library or .iftree-llm-workspace');
  }

  async function runShellCommand(command, options = {}) {
    const cwd = resolveAgentShellCwd(options.cwd);
    const timeoutMs = Math.max(1000, Math.min(30 * 60 * 1000, Number(options.timeoutMs) || 120_000));
    const env = {
      ...process.env,
      IFTREE_CURRENT_DOC_ID: String(options.context?.file?.docId || ''),
      PATH: deps.llmWorkspaceBinPath?.()
        ? `${deps.llmWorkspaceBinPath()}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`
        : process.env.PATH
    };
    const shell = process.platform === 'win32'
      ? { command: 'powershell.exe', args: ['-NoProfile', '-Command', command] }
      : { command: 'bash', args: ['-lc', command] };
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(shell.command, shell.args, { cwd, env, windowsHide: true });
      let settled = false;
      let timer = null;
      let stdout = '';
      let stderr = '';
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener?.('abort', stopOnAbort);
        fn(value);
      };
      timer = setTimeout(() => {
        child.kill();
        settle(rejectPromise, new Error(`bash command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const stopOnAbort = () => {
        child.kill();
        settle(rejectPromise, agentAbortError());
      };
      options.signal?.addEventListener?.('abort', stopOnAbort, { once: true });
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > 200_000) stdout = `${stdout.slice(0, 200_000)}\n[stdout truncated]`;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 80_000) stderr = `${stderr.slice(0, 80_000)}\n[stderr truncated]`;
      });
      child.on('error', (error) => settle(rejectPromise, error));
      child.on('close', (code) => settle(resolvePromise, { cwd, exitCode: code, stdout, stderr, ok: code === 0 }));
    });
  }

  async function agentBash(args = {}, permissions, context = {}, signal = null) {
    const command = String(args.command || '').trim();
    if (!command) throw new Error('bash requires command');
    const argv = splitCommandLine(command);
    if (argv[0] === 'db') {
      const result = await runDbShellArgv(database(), argv, {
        currentDocId: context.file?.docId,
        importLibraryDocument: deps.importLibraryDocument,
        deleteImportedDocument: deps.deleteImportedDocument,
        ensureDocVectors: deps.ensureDocVectors,
        askAgent: runAgent,
        agentTool: ({ name, args: toolArgs }) => runAgentTool(name, toolArgs, {
          mode: 'full',
          sessionId: null,
          context,
          signal
        })
      });
      return { ok: true, command, stdout: result.text || '', stderr: '', exitCode: 0 };
    }
    if (permissions.mode !== 'full') {
      return { rejected: true, reason: '当前模式只允许通过 bash 执行 db 只读命令；真实 shell 命令需要完全权限。' };
    }
    return runShellCommand(command, {
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
      context,
      signal
    });
  }

  function agentTools(mode) {
    const tools = /** @type {Array<Record<string, any>>} */ ([
      {
        type: 'function',
        function: {
          name: 'admin_override',
          description: '进阶只读查询（高级/底层入口，绕过 db 直接调原始 action）。常规检索与读取请优先用 bash 的 db 命令（db find --semantic / db read / db index 等，已替你组装参数、注入当前文档、格式化输出）；仅当 db 命令满足不了时，才用本工具按 action 直调底层只读 API。可用 action 与参数用法见 `db help`。',
          parameters: databaseReadToolSchema()
        }
      }
    ]);
    tools.push(
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a command. db commands are available in every mode; non-db shell commands require full mode and cwd inside library or .iftree-llm-workspace.',
          parameters: bashToolSchema()
        }
      },
      {
        type: 'function',
        function: {
          name: 'workspace_file',
          description: 'Operate on files inside the library workspace. Current mode permissions decide whether write/delete/move are accepted.',
          parameters: workspaceFileToolSchema()
        }
      },
      {
        type: 'function',
        function: {
          name: 'database_write',
          description: 'Whitelisted database write API. Current mode permissions decide whether direct writes are accepted.',
          parameters: databaseWriteToolSchema()
        }
      }
    );
    if (mode === 'edit' || mode === 'full') {
      tools.push(
        {
          type: 'function',
          function: {
            name: 'import_library_document',
            description: '导入 library 内尚未导入的真实文件。relativePath 必须是 library 相对路径；工具调用进入无头导入入口，并直接走产品既有普通导入流程。mode 默认 simple：simple=格式识别目录结构并切到段落；complete=simple 后切到句子；smart=simple/complete 后由 LLM 整理目录；vector=simple 后建立向量；direct=全文不切直接塞到节点 1。',
            parameters: importLibraryDocumentToolSchema()
          }
        },
        {
          type: 'function',
          function: {
            name: 'delete_library_document',
            description: '删除已导入文档的数据库 doc 及关联数据，不删除 library 中的真实文件。删除后 library_index 不应再看到该 doc id。',
            parameters: deleteLibraryDocumentToolSchema()
          }
        },
        {
          type: 'function',
          function: {
            name: 'ensure_doc_vectors',
            description: '为已导入文档补建语义向量：清理该 doc 旧结构残留向量，只补当前缺失或正文已变更的节点。节点重挂或地址变化本身不触发重算。',
            parameters: ensureDocVectorsToolSchema()
          }
        },
        {
          type: 'function',
          function: {
            name: 'workspace_file',
            description: '按 library 工作区相对路径操作本地文件。当前模式没有写权限时，只允许 list/read。',
            parameters: workspaceFileToolSchema()
          }
        },
        {
          type: 'function',
          function: {
            name: 'web_search',
            description: '联网搜索或读取网页内容。先用 search 拿结果，需要正文时再用 open 打开具体 URL。',
            parameters: webSearchToolSchema()
          }
        }
      );
    }
    if (mode === 'edit') {
      tools.push(
        {
          type: 'function',
          function: {
            name: 'propose_node_patch',
            description: '协作模式专用：为一个已有节点生成待审修改。用户确认后才应用。',
            parameters: proposeNodePatchToolSchema()
          }
        },
        {
          type: 'function',
          function: {
            name: 'propose_node_insert',
            description: '协作模式专用：在指定父节点下生成一个待审新增节点。用户确认后才应用。',
            parameters: proposeNodeInsertToolSchema()
          }
        },
        {
          type: 'function',
          function: {
            name: 'propose_node_delete',
            description: '协作模式专用：为一个非根节点生成待审删除。用户确认后才应用。',
            parameters: proposeNodeDeleteToolSchema()
          }
        },
        {
          type: 'function',
          function: {
            name: 'propose_ref_delete',
            description: '协作模式专用：生成一条待审引用删除。用户确认后才应用。',
            parameters: proposeRefDeleteToolSchema()
          }
        },
        {
          type: 'function',
          function: {
            name: 'propose_source_bind_path',
            description: '协作模式专用：生成当前文档绑定 library 相对路径的待审变更。用户确认后才应用。',
            parameters: proposeSourceBindPathToolSchema()
          }
        }
      );
    }
    if (mode === 'full') {
      tools.push({
        type: 'function',
        function: {
          name: 'database_write',
          description: '完全权限专用：白名单数据库写 API；不接受裸 SQL。',
          parameters: databaseWriteToolSchema()
        }
      });
    }
    const names = new Set();
    return tools.filter((tool) => {
      const name = tool?.function?.name || '';
      if (!name || names.has(name)) return false;
      names.add(name);
      return true;
    });
  }

  async function runAgentTool(name, args, { mode, sessionId, context, signal }) {
    assertNotAborted(signal);
    const permissions = agentPermissionsForMode(mode);
    if (name === 'search_manifest' || name === 'fetch_content') {
      return { rejected: true, reason: '内容查询请用 bash 的 db 命令（db find/read/index…）；进阶可用 admin_override 工具。' };
    }
    if (name === 'admin_override') return database().run({ operation: 'read', payload: args }, 'read');
    if (name === 'bash') return agentBash(args, permissions, context, signal);
    if (name === 'workspace_file') return agentWorkspaceFile(args, permissions);
    if (name === 'web_search') return agentWebSearch(args, { signal });
    if (name === 'propose_changes') {
      return { rejected: true, reason: '待审变更工具已拆分；请改用具体的 propose_node_*、propose_ref_* 或 propose_source_bind_path。' };
    }
    if (name === 'propose_node_patch') {
      if (mode !== 'edit') return { rejected: true, reason: '当前模式不能生成待审变更。' };
      return proposeAgentChanges({ operations: [{ ...args, action: 'node_patch' }] }, sessionId, context);
    }
    if (name === 'propose_node_insert') {
      if (mode !== 'edit') return { rejected: true, reason: '当前模式不能生成待审变更。' };
      return proposeAgentChanges({ operations: [{ ...args, action: 'node_insert' }] }, sessionId, context);
    }
    if (name === 'propose_node_delete') {
      if (mode !== 'edit') return { rejected: true, reason: '当前模式不能生成待审变更。' };
      return proposeAgentChanges({ operations: [{ ...args, action: 'node_delete' }] }, sessionId, context);
    }
    if (name === 'propose_ref_delete') {
      if (mode !== 'edit') return { rejected: true, reason: '当前模式不能生成待审变更。' };
      return proposeAgentChanges({ operations: [{ ...args, action: 'ref_delete' }] }, sessionId, context);
    }
    if (name === 'propose_source_bind_path') {
      if (mode !== 'edit') return { rejected: true, reason: '当前模式不能生成待审变更。' };
      return proposeAgentChanges({ operations: [{ ...args, action: 'source_bind_path' }] }, sessionId, context);
    }
    if (name === 'import_library_document') {
      if (mode !== 'edit' && mode !== 'full') return { rejected: true, reason: '当前模式不能导入 library 文档。' };
      if (typeof deps.importLibraryDocument !== 'function') return { rejected: true, reason: '当前后端未注册导入入口。' };
      return deps.importLibraryDocument(args);
    }
    if (name === 'delete_library_document') {
      if (mode !== 'edit' && mode !== 'full') return { rejected: true, reason: '当前模式不能删除已导入文档。' };
      if (typeof deps.deleteImportedDocument !== 'function') return { rejected: true, reason: '当前后端未注册删除入口。' };
      return deps.deleteImportedDocument(args);
    }
    if (name === 'ensure_doc_vectors') {
      if (mode !== 'edit' && mode !== 'full') return { rejected: true, reason: '当前模式不能写入派生向量索引。' };
      if (typeof deps.ensureDocVectors !== 'function') return { rejected: true, reason: '当前后端未注册向量补建入口。' };
      return deps.ensureDocVectors(args);
    }
    if (name === 'database_write') {
      if (mode === 'qa') return { rejected: true, reason: '当前模式没有数据库写入权限。' };
      const baseDocId = normalizeStableId(args.docId ?? args.doc_id ?? context.file?.docId, null);
      if (!baseDocId) {
        return { rejected: true, reason: 'LLM 数据库写入需要当前 doc id。' };
      }
      return database().write(args, {
        editBranchOwner: 'llm',
        editBranchBaseDocId: baseDocId
      });
    }
    return { rejected: true, reason: `未知工具：${name}` };
  }

  async function callAgentChat(api, messages, tools, options = {}) {
    const requestId = String(options.requestId || '');
    const stream = Boolean(requestId);
    const reasoningEffort = normalizeReasoningEffort(options.reasoningEffort, api);
    assertNotAborted(options.signal);
    // LLM 调试（debug 功能，开关见 headless-agent-host：IFTREE_DEBUG_LOGGING / config.debugLogging）：
    // 记下每次发给模型的完整请求与模型返回，便于排查上下文拼接与实际输出。
    const debugModel = api.model || 'deepseek-v4-pro';
    deps.debugLog?.('llm.request', {
      model: debugModel,
      stream,
      reasoningEffort: reasoningEffort || null,
      tools: Array.isArray(tools) ? tools.map((tool) => tool?.function?.name).filter(Boolean) : [],
      messages
    });
    const logLlmResponse = (msg) => deps.debugLog?.('llm.response', {
      model: debugModel,
      content: String(msg?.content || ''),
      toolCalls: Array.isArray(msg?.tool_calls)
        ? msg.tool_calls.map((call) => ({ name: call?.function?.name || '', arguments: call?.function?.arguments || '' }))
        : [],
      usage: msg?.usage || null
    });
    if (llmProtocol(api) === 'anthropic-compatible') {
      const maxTokens = configuredMaxOutputTokens(api);
      if (!maxTokens) {
        throw new Error('Anthropic-compatible API 需要在 API 配置中填写最大输出 token。');
      }
      const converted = anthropicMessages(messages);
      const anthropicBody = {
        model: api.model || 'deepseek-v4-pro',
        max_tokens: maxTokens,
        temperature: 0.2,
        system: converted.system,
        messages: converted.messages
      };
      const anthropicToolList = anthropicTools(tools);
      if (anthropicToolList.length > 0) anthropicBody.tools = anthropicToolList;
      if (reasoningEffort) {
        anthropicBody.output_config = {
          ...(api.outputConfig && typeof api.outputConfig === 'object' ? api.outputConfig : {}),
          effort: reasoningEffort
        };
      }
      const response = await fetchLlmResponse(anthropicMessagesUrl(api.baseUrl, api.fullUrl), {
        method: 'POST',
        headers: {
          'x-api-key': api.apiKey,
          'anthropic-version': api.anthropicVersion || '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(anthropicBody)
      }, {
        fetchers: deps.fetchers?.(),
        signal: options.signal,
        errorPrefix: 'Agent API 请求失败',
        timeoutMs: Math.max(1000, Number(process.env.IFTREE_AGENT_TIMEOUT_MS) || 45000)
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Agent API 请求失败：${response.status} ${response.statusText}${detail ? ` ${detail.slice(0, 300)}` : ''}`);
      }
      const json = await response.json();
      const anthropicMessage = agentMessageFromAnthropic(json, api);
      logLlmResponse(anthropicMessage);
      return anthropicMessage;
    }
    const body = {
      model: api.model || 'deepseek-v4-pro',
      temperature: 0.2,
      messages,
      tools,
      tool_choice: 'auto'
    };
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    if (stream) {
      body.stream = true;
      if (options.includeUsage !== false) body.stream_options = { include_usage: true };
    }
    const response = await fetchLlmResponse(chatCompletionUrl(api.baseUrl, api.fullUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${api.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }, {
      fetchers: deps.fetchers?.(),
      signal: options.signal,
      errorPrefix: 'Agent API 请求失败',
      // 本地慢模型（如 ollama 小模型）单轮可能远超默认 45s；用 IFTREE_AGENT_TIMEOUT_MS 调大，默认仍 45s。
      timeoutMs: Math.max(1000, Number(process.env.IFTREE_AGENT_TIMEOUT_MS) || 45000)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if (stream && options.includeUsage !== false && /stream_options|include_usage/i.test(detail)) {
        return callAgentChat(api, messages, tools, { ...options, includeUsage: false });
      }
      throw new Error(`Agent API 请求失败：${response.status} ${response.statusText}${detail ? ` ${detail.slice(0, 300)}` : ''}`);
    }
    if (stream) {
      const message = { role: 'assistant', content: '', tool_calls: [] };
      await readJsonSseStream(response, (chunk) => {
        assertNotAborted(options.signal);
        if (chunk?.usage) {
          message.usage = normalizeAgentUsage(chunk.usage, api);
          sendAgentStream(requestId, { type: 'usage', usage: message.usage });
        }
        const choice = chunk?.choices?.[0];
        const delta = choice?.delta || {};
        appendReasoningContent(message, delta.reasoning_content);
        if (typeof delta.content === 'string' && delta.content) {
          message.content += delta.content;
          sendAgentStream(requestId, { type: 'delta', text: delta.content });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const toolDelta of delta.tool_calls) appendAgentToolCallDelta(message.tool_calls, toolDelta);
        }
      }, { signal: options.signal });
      message.tool_calls = message.tool_calls.filter((call) => call?.id || call?.function?.name);
      logLlmResponse(message);
      return message;
    }
    const json = await response.json();
    const message = json?.choices?.[0]?.message || {};
    message.usage = normalizeAgentUsage(json?.usage, api);
    logLlmResponse(message);
    return message;
  }

  function agentSystemPrompt(mode, personalPrompt = '') {
    const fixedPrompt = String(personalPrompt || '').trim();
    const baseLines = [
      '# P0 必须遵守',
      '1. 语言：始终用简体中文回答。',
      '2. 权限：只按上下文 permissions 行动；没有写权限就不写文件、不改数据库、不生成直接写入。',
      '3. 真实性：不要假装读过未读取的内容；信息不足就继续读取或说明缺什么。',
      '4. 用户可读：最终回答不要暴露工具名、函数名、action 名、字段名、变量名；用户明确要求代码细节时除外。',
      '',
      '# P1 取数顺序',
      '1. 找文档：优先用 library.index 按 library 文件夹层级定位 docId；它只列已导入文件，默认不显示摘要内容；索引里的字数是子树合计，不是节点自有正文。',
      '2. 默认作用域是当前文档：上下文已给出当前文档 docId，检索与读取都先锚定它、每次检索都显式带上该 docId；除非用户明确要求跨文档或全库，否则不得用 all-docs／跨库检索，也不得擅自把作用域偏移到别的文档。',
      '3. 当前文档查结构：先看默认 treeIndex；节点短就读取单节点，子树大就按范围读取；当前文档找关键词用本文档关键词检索并带上当前 docId。',
      '4. 仅当用户明确要求跨文档、或已确认当前文档确实查不到时，才显式走跨文档正文搜索；跨文档检索默认不含隐藏系统目录（如 .memory），要纳入须显式声明。',
      '5. 需要给人或模型看树结构时请求 ASCII tree；程序继续处理时保留 JSON。',
      '',
      '# P2 IF-tree 规则',
      '1. IF-tree 使用稳定地址：1 是根节点，1-3 是 1 的第 3 个子节点，1-3-2 是 1-3 的第 2 个子节点。',
      '2. 地址前缀表示父子关系，兄弟节点共享同一父地址。',
      '',
      '# P3 回答风格',
      '1. 默认 3-6 句，除非用户要求展开、逐节总结或生成长文。',
      '2. 回答文章内容时先给核心概述，不默认复述全文。',
      '3. 调用工具前先用一句短话声明意图，例如"我先读取节点 1-3 的正文。"',
      '4. 不要把渲染坐标、调试日志、数据库内部行号、父节点 id 或排序字段写给用户。'
    ];
    if (mode === 'edit' || mode === 'full') {
      baseLines.push(
        '本地文件只允许使用 library 工作区内的相对路径；不要向用户暴露内部绝对路径映射。permissions.localFiles.canWrite 为 false 时只能读，不能写、删、移动。',
        '需要联网时，先搜索关键词，再按结果打开具体网页；不要把搜索结果当作已经阅读过的正文。'
      );
    }
    if (mode === 'full') {
      baseLines.push('需要改数据库且 permissions.database.canWriteShadow 为 true 时，使用 database_write；数据库变更写入 LLM 影子分支。');
    }
    const basePrompt = deps.systemPromptSection('agent.base', baseLines.join('\n'));
    // schema 自述（15-12-5）+ 常驻指令（15-12-2）：只点"你有记忆、先看看最近发生什么"，
    // 不注入正文或命中指针。记忆子系统关闭时整段不挂载（15-10-5：禁用时召回常驻指令不挂载）。
    const memorySchemaPrompt = deps.isMemoryEnabled?.() === true
      ? deps.systemPromptSection('memory.schema', MEMORY_SCHEMA_FALLBACK)
      : '';
    const modePrompt = deps.systemPromptSection(
      `agent.mode.${mode}`,
      mode === 'edit'
        ? '当前是协作模式：需要改当前树结构、节点内容、引用关系或绑定路径时，生成待审变更；结束回答时只用普通话简短说明改了哪里，不要提内部工具名或 action 名。'
        : mode === 'full'
          ? '当前是完全权限：可以在 permissions 允许范围内直接读写 library 工作区文件；数据库封装操作写入 LLM 影子分支，结束回答时简短说明实际做了什么。'
          : '当前是问答模式。禁止生成协作修改或待审变更，禁止写入；只回答问题。'
    );
    return [
      basePrompt,
      memorySchemaPrompt,
      fixedPrompt ? `用户固定额外说明：\n${fixedPrompt}` : '',
      modePrompt,
      '如果信息不足，说明需要读取哪些来源，不要编造。'
    ].filter(Boolean).join('\n');
  }


  async function runAgent(payload = {}) {
    const mode = normalizeAgentMode(payload.mode);
    const prompt = String(payload.prompt || '').trim();
    const requestId = String(payload.requestId || '').trim();
    const reasoningEffort = String(payload.reasoningEffort || '').trim();
    if (!prompt) throw new Error('Agent 输入为空');
    const abortController = new AbortController();
    const signal = abortController.signal;
    if (requestId) activeAgentRequests.set(requestId, abortController);
    let context;
    try {
      context = await buildAgentContext(payload);
    } catch (error) {
      if (requestId && activeAgentRequests.get(requestId) === abortController) {
        activeAgentRequests.delete(requestId);
      }
      throw error;
    }
    const agentStore = getAgentStore();
    const incomingSessionId = Number(payload.sessionId);
    const existingSession = Number.isInteger(incomingSessionId) && incomingSessionId > 0
      ? agentStore.getSession(incomingSessionId)
      : null;
    const session = agentStore.startSessionTurn({
      sessionId: payload.sessionId,
      mode,
      prompt,
      docId: context.file?.docId || null,
      selectedNodeId: context.selectedNode?.nodeId || null,
      context
    });
    const agentSettings = readAgentSettings();
    const api = deps.agentApiFromPayload(payload);
    const tools = agentTools(mode);
    const history = mergeAgentHistorySources(
      storedSessionHistory(existingSession),
      payload.history
    );
    const messages = /** @type {Array<Record<string, any>>} */ ([
      { role: 'system', content: agentSystemPrompt(mode, agentSettings.personalPrompt) },
      ...compactAgentHistory(history, payload.contextUsage),
      { role: 'system', content: formatAgentContextMessage(context) },
      { role: 'user', content: prompt }
    ]);
    const toolEvents = [];
    const emitToolEvent = (tool) => {
      const id = String(tool?.id || `${tool?.name || 'tool'}-${toolEvents.length}`);
      const next = { ...tool, id };
      const index = toolEvents.findIndex((event) => event.id === id);
      if (index >= 0) toolEvents[index] = { ...toolEvents[index], ...next };
      else toolEvents.push(next);
      sendAgentStream(requestId, { type: 'tool', tool: next });
    };
    emitToolEvent({
      id: 'default-context',
      name: 'default_context',
      status: 'done',
      resultPreview: jsonPreview({
        file: context.file?.title || '',
        nodeCount: context.file?.nodeCount || 0,
        indexNodes: context.treeIndex?.length || 0,
        selectedAddress: context.selectedNode?.address || null
      }, 3000)
    });

    try {
      let answer = '';
      let usage = null;
      const changedDocIds = new Set();
      for (let step = 0; ; step += 1) {
        assertNotAborted(signal);
        sendAgentStream(requestId, { type: 'status', text: step === 0 ? '正在连接模型...' : '正在整理回答...' });
        const message = await callAgentChat(api, messages, tools, { requestId, reasoningEffort, signal });
        if (message.usage) {
          usage = message.usage;
          sendAgentStream(requestId, { type: 'usage', usage });
        }
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (toolCalls.length === 0) {
          answer = String(message.content || '').trim();
          break;
        }
        messages.push(agentAssistantMessageForHistory(message, toolCalls));
        sendAgentStream(requestId, { type: 'status', text: '正在读取上下文...' });
        for (const call of toolCalls) {
          assertNotAborted(signal);
          const name = call?.function?.name || '';
          const args = parseToolArgs(call?.function?.arguments);
          const toolEventId = call?.id || `tool-${step}-${messages.length}`;
          emitToolEvent({ id: toolEventId, name, status: 'running', argsPreview: jsonPreview(args, 1200) });
          let result;
          try {
            result = await runAgentTool(name, args, { mode, sessionId: session.id, context, signal });
          } catch (error) {
            if (isAbortError(error)) throw error;
            result = {
              ok: false,
              recoverable: true,
              tool: name,
              error: {
                name: error?.name || 'Error',
                message: error?.message || String(error)
              },
              instruction: '本次工具调用失败。请修正参数、换用更合适的查询，或向用户说明缺少的信息。'
            };
            emitToolEvent({ id: toolEventId, name, status: 'error', error: error.message || String(error) });
          }
          const resultJson = JSON.stringify(sanitize(result));
          const displayPreview = toolDisplayPreview(name, result, 5000);
          const resultEvent = {
            id: toolEventId,
            name,
            resultPreview: jsonPreview(result, 5000),
            ...(displayPreview === null ? {} : { displayPreview, resultJson })
          };
          if (result?.ok === false && result?.recoverable) {
            emitToolEvent({ ...resultEvent, status: 'error', error: result.error?.message || '工具调用失败' });
          } else {
            emitToolEvent({ ...resultEvent, status: 'done' });
          }
          if (Array.isArray(result?.changedDocIds)) {
            for (const docId of result.changedDocIds) {
              const normalizedDocId = normalizeStableId(docId, null);
              if (normalizedDocId) changedDocIds.add(normalizedDocId);
            }
          }
          messages.push({
            role: 'tool',
            tool_call_id: call.id || toolEventId,
            content: summarizeToolResultForHistory(name, args, result, resultJson)
          });
        }
      }

      if (!answer) answer = mode === 'edit' ? '已生成待审变更。' : '没有生成可用回答，请追问或换个问法。';
      const diffs = await listAgentDiffs();
      const turnMessages = [
        {
          role: 'user',
          mode,
          content: prompt,
          createdAt: new Date().toISOString()
        },
        {
          role: 'assistant',
          mode,
          content: answer,
          status: '完成',
          diffCount: diffs.length,
          usage,
          toolEvents,
          createdAt: new Date().toISOString()
        }
      ];
      agentStore.finishSessionTurn(session.id, {
        answer,
        pendingDiffCount: diffs.length,
        diffIds: diffs.map((diff) => diff.id),
        usage,
        toolEvents,
        changedDocIds: Array.from(changedDocIds)
      }, turnMessages);
      sendAgentStream(requestId, { type: 'done', answer, diffCount: diffs.length, usage });
      return { sessionId: session.id, answer, diffs, usage, toolEvents, changedDocIds: Array.from(changedDocIds) };
    } catch (error) {
      if (isAbortError(error)) {
        const answer = '已取消。';
        const diffs = await listAgentDiffs();
        const turnMessages = [
          {
            role: 'user',
            mode,
            content: prompt,
            createdAt: new Date().toISOString()
          },
          {
            role: 'assistant',
            mode,
            content: answer,
            status: '已取消',
            canceled: true,
            toolEvents,
            createdAt: new Date().toISOString()
          }
        ];
        agentStore.finishSessionTurn(session.id, {
          canceled: true,
          answer,
          pendingDiffCount: diffs.length,
          diffIds: diffs.map((diff) => diff.id),
          toolEvents
        }, turnMessages);
        sendAgentStream(requestId, { type: 'done', answer, diffCount: diffs.length, canceled: true });
        return { sessionId: session.id, answer, diffs, toolEvents, canceled: true, changedDocIds: [] };
      }
      const turnMessages = [
        {
          role: 'user',
          mode,
          content: prompt,
          createdAt: new Date().toISOString()
        },
        {
          role: 'assistant',
          mode,
          content: error.message || String(error),
          status: '失败',
          error: true,
          toolEvents,
          createdAt: new Date().toISOString()
        }
      ];
      agentStore.finishSessionTurn(session.id, {
        error: error.message || String(error),
        toolEvents
      }, turnMessages);
      throw error;
    } finally {
      if (requestId && activeAgentRequests.get(requestId) === abortController) {
        activeAgentRequests.delete(requestId);
      }
    }
  }

  async function listAgentDiffs() {
    // A2A 待审 = 所有 owner=llm:<会话> 活跃编辑分支（整批，一分支 = 一组提议）；退役独立 agent_diffs（projectneed 18-1）。
    const pending = await database().run({ operation: 'query', payload: { action: 'editBranch.listPending' } }, 'query');
    return (pending?.branches || []).filter((branch) => String(branch.owner || '').startsWith('llm:'));
  }

  function agentBranchActiveEntryCount(branch) {
    try {
      const diff = JSON.parse(branch?.diff || '{}');
      const entries = Array.isArray(diff.entries) ? diff.entries : [];
      return entries.filter((entry) => entry && entry.status !== 'undone').length;
    } catch {
      return 0;
    }
  }

  async function listAgentSessions(payload = {}) {
    const sessions = getAgentStore().listSessions({ limit: payload.limit });
    // 待审计数补齐（agent_diffs 已退役）：A2A 待审 = owner=llm:<会话> 活跃编辑分支，跨库归属。
    // 逐分支按 owner 解析出会话 id（内置 agent 分支 owner 形如 llm:<整数会话id>），累加活跃 entry 数。
    const branches = await listAgentDiffs();
    if (branches.length === 0) return sessions;
    const counts = new Map();
    for (const branch of branches) {
      const match = String(branch.owner || '').match(/^llm:(\d+)$/);
      if (!match) continue;
      const sid = Number(match[1]);
      counts.set(sid, (counts.get(sid) || 0) + agentBranchActiveEntryCount(branch));
    }
    return sessions.map((session) => ({
      ...session,
      pending_diff_count: counts.get(Number(session.id)) || 0
    }));
  }

  function getAgentSession(payload = {}) {
    const sessionId = Number(payload.sessionId ?? payload.id);
    if (!Number.isInteger(sessionId) || sessionId <= 0) return null;
    return getAgentStore().getSession(sessionId);
  }

  async function deleteAgentSession(payload = {}) {
    const sessionId = Number(payload.sessionId ?? payload.id);
    if (!Number.isInteger(sessionId) || sessionId <= 0) return { ok: false, sessions: await listAgentSessions() };
    getAgentStore().deleteSession(sessionId);
    return { ok: true, sessions: await listAgentSessions() };
  }

  function cancelAgentRequest(payload = {}) {
    const requestId = String(payload?.requestId ?? payload ?? '').trim();
    if (!requestId) return { ok: false, canceled: false, reason: 'missing requestId' };
    const controller = activeAgentRequests.get(requestId);
    if (!controller) return { ok: false, canceled: false, requestId };
    controller.abort();
    return { ok: true, canceled: true, requestId };
  }

  async function runTool(payload = {}) {
    const name = String(payload.name || payload.tool || '').trim();
    if (!name) throw new Error('agent tool name is required');
    const args = payload.args && typeof payload.args === 'object' ? payload.args : {};
    const mode = normalizeAgentMode(payload.mode || 'full');
    const context = await buildAgentContext({ ...payload, mode });
    return runAgentTool(name, args, {
      mode,
      sessionId: payload.sessionId,
      context,
      signal: null
    });
  }

  async function applyAgentDiff(diffId) {
    // 整批批准：把该 owner=llm:<会话> 分支 merge 进主干（A5-10）。落点 owner/trust 由审批者档位定
    // （human 档可标受控、见 18-3；T4 human 档接入前先按机器产物不受控合入）。
    const branchId = Number(diffId);
    if (!Number.isInteger(branchId) || branchId <= 0) return { ok: false, diffs: await listAgentDiffs() };
    const result = await database().write(
      { action: 'editBranch.applyMerge', branchId, includeDoc: false },
      {}
    );
    const ok = !result?.blocked && !result?.conflicts;
    return { ok, result, diffs: await listAgentDiffs() };
  }

  async function rejectAgentDiff(diffId) {
    // 整批拒绝：丢弃该 owner=llm:<会话> 分支（A5-7），主干不动。
    const branchId = Number(diffId);
    if (!Number.isInteger(branchId) || branchId <= 0) return { ok: false, diffs: await listAgentDiffs() };
    await database().write({ action: 'editBranch.discard', branchId, includeDoc: false }, {});
    return { ok: true, diffs: await listAgentDiffs() };
  }

  return {
    runAgent,
    runTool,
    listAgentDiffs,
    listAgentSessions,
    getAgentSession,
    deleteAgentSession,
    cancelAgentRequest,
    applyAgentDiff,
    rejectAgentDiff
  };
}
