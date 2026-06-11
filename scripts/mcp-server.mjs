#!/usr/bin/env node
// MCP entry (projectneed `18`): official MCP SDK thin shell over the headless
// backend. Exposes the retrieval channel (db.shell / database.read) and the
// A2A channel (agent.run -> built-in agent). The shell itself touches no native
// module; it delegates to the headless host. Run under electron-as-node so the
// spawned host gets the Electron ABI for better-sqlite3, e.g.:
//   ELECTRON_RUN_AS_NODE=1 electron scripts/mcp-server.mjs
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createHeadlessAgentClient } from '../src/backend/llm/headless-agent-client.mjs';
import { createSharedBackendClient } from '../src/backend/llm/backend-pipe-client.mjs';
import { NODE_TYPES, NODE_TYPE_LABELS } from '../src/core/node-model.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docIdSchema = z.union([z.string().min(1), z.number().int().positive()]);
const ownerSchema = z.string().min(1);

/** @typedef {string | number} DocId */
/** @typedef {{ branchId?: number, shadowDocId?: DocId, baseDocId?: DocId, owner?: string }} BranchTargetArgs */
const nodeTypeContractText = `节点类型统一写 node_type/nodeType，不再使用 human_tag。内部码：${NODE_TYPES.join(', ')}；中文标签：${Object.values(NODE_TYPE_LABELS).join(' / ')}。`;

// Permission tier picked at launch by the deployment (projectneed `18-3`).
const TIER = (process.env.IFTREE_MCP_TIER || 'read').toLowerCase();
const AGENT_MODE = TIER === 'full' ? 'full' : (TIER === 'edit' ? 'edit' : 'qa');

function textResult(text) {
  return { content: [{ type: 'text', text: String(text ?? '') }] };
}

function jsonTextResult(value) {
  return textResult(JSON.stringify(value, null, 2));
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

async function dbShell(client, argv, currentDocId) {
  const res = await client.request('db.shell', { argv, currentDocId });
  return res?.text != null ? String(res.text) : '';
}

function registerRetrievalTools(server, client) {
  server.registerTool('library_index', {
    description: '按 library 文件夹包含层级列出已导入文档的 ASCII tree；默认文件节点显示文件名、字数和语义状态，不显示 UUID；uuid=true 时附 #docId。未导入文件不列出；(xxx字) 是该文档节点 1 的整棵子树正文合计，不是节点 1 自有正文。默认不显示摘要，includeSummary=true 时才附加摘要内容。',
    inputSchema: {
      folder: z.string().optional().describe('可选 library 相对文件夹路径；省略时从 library 根列出。'),
      includeSummary: z.boolean().optional().describe('默认 false；true 时附加摘要内容。字数仍表示整棵子树正文合计，不是节点自有正文。'),
      uuid: z.boolean().optional().describe('true 时显示 #docId；默认 false，只显示文件名作为文档标签。')
    }
  }, async ({ folder, includeSummary, uuid } = /** @type {{ folder?: string, includeSummary?: boolean, uuid?: boolean }} */ ({})) => {
    const payload = { action: 'library.index' };
    if (folder) payload.path = folder;
    if (includeSummary) payload.includeSummary = true;
    if (uuid) payload.uuid = true;
    const res = await client.request('database.read', { payload });
    return textResult(res?.text || '(库里暂无已导入文档)');
  });

  server.registerTool('tree', {
    description: '查看文档结构（缩进 ASCII 树：地址 类型 标题 (子树字数)）。可选 address 只看某子树，depth 限层。地址形如 1、1-3、1-3-2，是相对地址。注意字数是整棵子树合计，不是该节点自有正文。',
    inputSchema: {
      docId: docIdSchema.describe('已导入文档的 doc id。'),
      address: z.string().optional().describe('可选节点地址；省略时从节点 1 展开。输出中的字数是该地址节点的子树合计。'),
      depth: z.number().int().positive().optional().describe('可选展开层数；输出中的 (xxx) 仍是各节点整棵子树合计，不是节点自有正文。'),
      uuid: z.boolean().optional().describe('true 时保留稳定 id；默认 false。')
    }
  }, async ({ docId, address, depth, uuid }) => {
    const argv = ['tree', String(docId)];
    if (address) argv.push(address);
    if (depth) argv.push('--depth', String(depth));
    if (uuid) argv.push('--uuid');
    return textResult((await dbShell(client, argv)) || '(空)');
  });

  server.registerTool('read', {
    description: '读取文档某地址的正文。默认读整棵子树纯正文（推荐：容器节点自身正文常为空，读子树才有内容）。node=true 只读该节点本身并输出节点头（doc/address/type/trust）；meta=true 附元信息。source=true 返回原文窗口；blame=true 返回原文出处溯源，不做编辑责任归属。命中过碎时可读父地址或相邻地址（±1）补上下文。',
    inputSchema: {
      docId: docIdSchema,
      address: z.string(),
      node: z.boolean().optional(),
      meta: z.boolean().optional(),
      source: z.boolean().optional().describe('true 时返回原文窗口文本。'),
      axioms: z.boolean().optional().describe('true 时返回文档事实前提列表。'),
      links: z.boolean().optional().describe('true 时返回该节点的引用进出。'),
      neighbors: z.boolean().optional(),
      at: z.union([docIdSchema, z.string()]).optional().describe('可选历史 ref：history id、save_history.saved_at 或 summary tag；只读历史快照，不写回当前库。'),
      blame: z.boolean().optional().describe('true 时返回原文出处溯源：source type/path、source_position、原文窗口 offsets、该节点直接 source spans。'),
      limit: z.number().int().positive().optional(),
      uuid: z.boolean().optional().describe('true 时 read --node/read --meta 头部显示 doc:UUID；默认 false，显示文档标签。')
    }
  }, async ({ docId, address, node, meta, source, axioms, links, neighbors, at, blame, limit, uuid }) => {
    const argv = ['read', String(docId), address];
    if (node) argv.push('--node');
    if (meta) argv.push('--meta');
    if (source) argv.push('--source');
    if (axioms) argv.push('--axioms');
    if (links) argv.push('--links');
    if (neighbors) argv.push('--neighbors');
    if (at !== undefined) argv.push('--at', String(at));
    if (blame) argv.push('--blame');
    if (limit) argv.push('--limit', String(limit));
    if (uuid) argv.push('--uuid');
    return textResult(await dbShell(client, argv));
  });

  server.registerTool('find', {
    description: '统一检索动词。默认用 terms 做多词 AND 字面检索；semantic=true 时用 query 做语义检索并在命中行追加 score；tags=true 时返回实体同义/相关列表。命中行输出 文档标签/address/type/title；uuid=true 时文档标签换成 doc:UUID。命中只用于挑候选，回答前用 read 取回正文证据。',
    inputSchema: {
      terms: z.array(z.string()).min(1).optional().describe('字面检索词；semantic=false 且 tags=false 时必填，多词按 AND 精确匹配。'),
      query: z.string().optional().describe('semantic=true 时的自然语言查询。'),
      semantic: z.boolean().optional().describe('true 时走语义检索；需目标文档已建立向量索引。'),
      tags: z.boolean().optional().describe('true 时不返回节点，返回输入词的实体同义/相关列表。'),
      docId: docIdSchema.optional().describe('限定单篇文档；与 allDocs 二选一。'),
      allDocs: z.boolean().optional().describe('true 时跨所有已导入文档检索；与 docId 二选一。'),
      scopeAddress: z.string().optional().describe('可选局部节点地址；需要同时给 docId。'),
      limit: z.number().int().positive().optional().describe('可选返回数量上限。'),
      uuid: z.boolean().optional().describe('true 时命中行显示 doc:UUID；默认 false，显示文档标签。')
    }
  }, async ({ terms, query, semantic, tags, docId, allDocs, scopeAddress, limit, uuid } = /** @type {{ terms?: string[], query?: string, semantic?: boolean, tags?: boolean, docId?: DocId, allDocs?: boolean, scopeAddress?: string, limit?: number, uuid?: boolean }} */ ({})) => {
    if (docId && allDocs) return textResult('docId 和 allDocs 只能二选一。');
    if (!docId && !allDocs) return textResult('请给 docId 限定单篇，或设 allDocs=true 跨文档检索。');
    if (scopeAddress && !docId) return textResult('scopeAddress 需要同时给 docId。');
    if (semantic && tags) return textResult('semantic 和 tags 不能同时为 true。');

    const argv = ['find'];
    if (semantic) argv.push('--semantic');
    if (tags) argv.push('--tags');
    if (allDocs) argv.push('--all-docs');
    if (scopeAddress) argv.push('--scope', String(docId), scopeAddress);
    if (limit) argv.push('--limit', String(limit));
    if (uuid) argv.push('--uuid');
    if (semantic) {
      const text = String(query || '').trim();
      if (!text) return textResult('semantic=true 时请给 query。');
      argv.push(text);
    } else {
      const safeTerms = Array.isArray(terms) ? terms.map((term) => String(term).trim()).filter(Boolean) : [];
      if (safeTerms.length === 0) return textResult('semantic=false 时请给 terms。');
      argv.push(...safeTerms);
    }
    try {
      return textResult((await dbShell(client, argv, allDocs || scopeAddress ? undefined : docId)) || '(无命中)');
    } catch (error) {
      return textResult(`find 当前不能执行：${error?.message || error}\n降级：用 find 的 terms 字面检索 + tree 结构定位。`);
    }
  });

  server.registerTool('log', {
    description: '列出某个已导入文档的保存/commit 历史，每行包含 history id、commit id、时间和摘要。',
    inputSchema: {
      docId: docIdSchema.describe('已导入文档的 doc id。'),
      limit: z.number().int().positive().optional()
    }
  }, async ({ docId, limit }) => {
    const argv = ['log', String(docId)];
    if (limit) argv.push('--limit', String(limit));
    return textResult((await dbShell(client, argv)) || '(无历史)');
  });

  server.registerTool('diff', {
    description: '比较两条保存历史，或查看一个 edit branch 的投影 diff。历史 diff 需要 docId + toHistoryId，可选 fromHistoryId；branch diff 给 branchId/baseDocId/shadowDocId。',
    inputSchema: {
      docId: docIdSchema.optional(),
      fromHistoryId: docIdSchema.optional(),
      toHistoryId: docIdSchema.optional(),
      historyId: docIdSchema.optional(),
      branchId: z.number().int().positive().optional(),
      shadowDocId: docIdSchema.optional(),
      baseDocId: docIdSchema.optional(),
      owner: ownerSchema.optional()
    }
  }, async ({ docId, fromHistoryId, toHistoryId, historyId, branchId, shadowDocId, baseDocId, owner } = /** @type {BranchTargetArgs & { docId?: DocId, fromHistoryId?: DocId, toHistoryId?: DocId, historyId?: DocId }} */ ({})) => {
    if (branchId !== undefined || shadowDocId !== undefined || baseDocId !== undefined) {
      const payload = { action: 'editBranch.diffView' };
      if (branchId !== undefined) payload.branchId = branchId;
      if (shadowDocId !== undefined) payload.shadowDocId = shadowDocId;
      if (baseDocId !== undefined) payload.baseDocId = baseDocId;
      if (owner) payload.owner = owner;
      const res = await client.request('database.read', { payload });
      return jsonTextResult(res);
    }
    const targetHistoryId = toHistoryId ?? historyId;
    if (!docId || !targetHistoryId) return textResult('diff 需要 docId + toHistoryId/historyId，或 branchId/baseDocId/shadowDocId。');
    const payload = { action: 'history.diff', docId, toHistoryId: targetHistoryId };
    if (fromHistoryId) payload.fromHistoryId = fromHistoryId;
    const res = await client.request('database.read', { payload });
    return jsonTextResult(res);
  });

  server.registerTool('sql', {
    description: '只读 SQL 调试查询。只允许 SELECT/WITH 且后端会用 SQLite readonly 检查；用于核对数据库事实，不用于写入或修改数据。',
    inputSchema: {
      sql: z.string().describe('SELECT 或 WITH 开头的只读 SQL。'),
      params: z.union([z.array(z.any()), z.record(z.string(), z.any())]).optional().describe('可选 SQL 参数；数组对应 ? 参数，对象对应 @name 参数。'),
      limit: z.number().int().positive().optional().describe('可选返回行数上限；后端会限制最大值。')
    }
  }, async ({ sql, params, limit }) => {
    const payload = { action: 'debug.sql', sql };
    if (params !== undefined) payload.params = params;
    if (limit !== undefined) payload.limit = limit;
    const res = await client.request('database.read', { payload });
    return jsonTextResult(res);
  });

  server.registerTool('article', {
    description: '读取导入文档的原文窗口。可按 docId 从开头读，或给 nodeId 读取该节点附近原文；返回窗口偏移、原文文本，并可附 source spans。',
    inputSchema: {
      docId: docIdSchema.describe('已导入文档的 doc id。'),
      nodeId: docIdSchema.optional().describe('可选节点 id；提供时从该节点对应的原文位置附近读取。'),
      startOffset: z.number().int().nonnegative().optional().describe('可选原文起始偏移；不提供时从 nodeId 或文档开头定位。'),
      limit: z.number().int().positive().optional().describe('可选窗口字符数；后端会限制最大值。'),
      before: z.number().int().nonnegative().optional().describe('按 nodeId 定位时，向前包含的字符数。'),
      spansLimit: z.number().int().positive().optional().describe('可选 source span 返回数量上限。'),
      includeSpans: z.boolean().optional().describe('true 时返回 sourceSpans；默认只返回窗口和文本。')
    }
  }, async ({ docId, nodeId, startOffset, limit, before, spansLimit, includeSpans }) => {
    const payload = { action: 'content.getArticle', docId };
    if (nodeId !== undefined) payload.nodeId = nodeId;
    if (startOffset !== undefined) payload.startOffset = startOffset;
    if (limit !== undefined) payload.limit = limit;
    if (before !== undefined) payload.before = before;
    if (spansLimit !== undefined) payload.spansLimit = spansLimit;
    if (includeSpans) payload.include = ['spans'];
    const res = await client.request('database.read', { payload });
    return jsonTextResult(res);
  });

  server.registerTool('memory_volumes', {
    description: '列出完整记忆的 session 卷及状态（projectneed 15-10）。状态由时间戳推导：active（活跃）→ sealed（末次活动+24h 视为收尾，冷却中）→ distillable（再+24h 可提炼）→ distilled（已提炼）。返回每卷的 agent 身份、session id、起止时间、末次活动时间等时间元数据；采信任何卷内容前先看时间（15-12-6）。卷正文用 tree/read 按 docId 下钻（查过往）。',
    inputSchema: {
      state: z.enum(['active', 'sealed', 'distillable', 'distilled']).optional().describe('可选状态过滤。'),
      agent: z.string().optional().describe('可选 agent 身份过滤。'),
      sessionId: z.string().optional().describe('可选 session id 过滤。'),
      limit: z.number().int().positive().optional()
    }
  }, async ({ state, agent, sessionId, limit } = /** @type {{ state?: string, agent?: string, sessionId?: string, limit?: number }} */ ({})) => {
    const payload = { action: 'memory.listVolumes' };
    if (state !== undefined) payload.state = state;
    if (agent !== undefined) payload.agent = agent;
    if (sessionId !== undefined) payload.sessionId = sessionId;
    if (limit !== undefined) payload.limit = limit;
    const res = await client.request('database.read', { payload });
    return jsonTextResult(res);
  });
}

function registerAgentTools(server, client) {
  server.registerTool('ask_agent', {
    description: '直接问本产品的内置文档智能体（A2A）。它会按检索纪律自己查文档、读正文、附证据节点再回答。docId 指定当前文档；sessionId 用于多轮续接（把上轮返回的 sessionId 传回来）。',
    inputSchema: { prompt: z.string(), docId: docIdSchema.optional(), sessionId: z.number().int().positive().optional() }
  }, async ({ prompt, docId, sessionId }) => {
    const payload = { mode: AGENT_MODE, prompt };
    if (docId) payload.docId = docId;
    if (sessionId) payload.sessionId = sessionId;
    const result = await client.request('agent.run', { payload });
    const answer = result?.answer || result?.error || '(无回答)';
    const sid = result?.sessionId != null ? `\n\n[sessionId: ${result.sessionId}]` : '';
    return textResult(`${answer}${sid}`);
  });
}

function registerLifecycleTools(server, client) {
  server.registerTool('restart_backend', {
    description: '关闭当前 MCP 持有的 headless Agent 子进程，释放 better_sqlite3.node；下一次 MCP 工具调用会重新拉起新实例。若 MCP server 自身已更新，需要调用方重连 MCP。'
  }, async () => {
    const pid = client.pid;
    try {
      await client.shutdown();
    } finally {
      client.close();
    }
    const target = pid ? `pid=${pid}` : '当前未启动';
    return textResult(`已关闭 MCP 持有的 headless Agent（${target}）。下一次 MCP 工具调用会重新启动；若更新了 MCP server 自身，请重连 MCP。`);
  });
}

// Progressive tier (projectneed `18-3`): read = read tools only; edit adds
// import/delete plus review of proposed changes; full adds accepting + saving.
function registerWriteTools(server, client, tier) {
  const selectedBranch = { branchId: null, baseDocId: null, owner: null };
  const setSelectedBranch = ({ branchId = null, baseDocId = null, owner = null } = {}) => {
    selectedBranch.branchId = branchId ?? null;
    selectedBranch.baseDocId = baseDocId ?? null;
    selectedBranch.owner = owner ?? null;
    return { ...selectedBranch };
  };
  const branchTarget = ({ branchId, shadowDocId, baseDocId, owner } = /** @type {BranchTargetArgs} */ ({})) => ({
    branchId: branchId ?? selectedBranch.branchId ?? undefined,
    shadowDocId,
    baseDocId: baseDocId ?? selectedBranch.baseDocId ?? undefined,
    owner: owner ?? selectedBranch.owner ?? undefined
  });
  const hasBranchTarget = (target = {}) => (
    target.branchId !== undefined || target.shadowDocId !== undefined || target.baseDocId !== undefined
  );
  const branchTargetLabel = (target = {}) => {
    const parts = [];
    if (target.branchId !== undefined) parts.push(`branchId=${target.branchId}`);
    if (target.shadowDocId !== undefined) parts.push(`shadowDocId=${target.shadowDocId}`);
    if (target.baseDocId !== undefined) parts.push(`baseDocId=${target.baseDocId}`);
    if (target.owner) parts.push(`owner=${target.owner}`);
    return parts.join(' ');
  };
  const branchPreview = (verb, target = {}) => textResult(`would ${verb} ${branchTargetLabel(target)}; set yes=true to apply`);

  const importLibraryDocument = async ({ relativePath, mode }) => {
    const res = await client.request('import.libraryDocument', { payload: { relativePath, mode } });
    if (!res?.ok) return textResult(`导入失败：${JSON.stringify(res)}`);
    return textResult(`已导入 ${res.relativePath || relativePath}\n#${res.docId} ${res.title || ''}\n节点数：${res.nodeCount || 0}`);
  };

  const ensureVectors = async ({ docId }) => {
    const res = await client.request('vector.ensureDoc', { payload: { docId } });
    return textResult(JSON.stringify(res, null, 2));
  };

  const saveBranch = async (input = {}) => {
    const { branchId, shadowDocId, baseDocId, owner } = branchTarget(input);
    const { summary, tag } = input;
    if (branchId === undefined && shadowDocId === undefined && baseDocId === undefined) {
      return textResult('commit/merge 需要 branchId/baseDocId/shadowDocId。');
    }
    const payload = { action: 'editBranch.save', includeDoc: false };
    if (branchId !== undefined) payload.branchId = branchId;
    if (shadowDocId !== undefined) payload.shadowDocId = shadowDocId;
    if (baseDocId !== undefined) payload.baseDocId = baseDocId;
    if (owner) payload.owner = owner;
    if (summary || tag) payload.summary = summary || tag;
    const res = await client.request('database.write', { payload });
    return textResult(JSON.stringify(res, null, 2));
  };

  const discardChange = async (input = {}) => {
    const { diffId } = input;
    const { branchId, shadowDocId, baseDocId, owner } = branchTarget(input);
    if (diffId !== undefined && diffId !== null && diffId !== '') {
      const res = await client.request('agent.rejectDiff', { payload: { diffId } });
      return textResult(res?.ok ? `已丢弃 diff ${diffId}` : `丢弃失败：${JSON.stringify(res)}`);
    }
    if (branchId === undefined && shadowDocId === undefined && baseDocId === undefined) {
      return textResult('discard 需要 diffId，或 branchId/baseDocId/shadowDocId。');
    }
    const payload = { action: 'editBranch.discard', includeDoc: false };
    if (branchId !== undefined) payload.branchId = branchId;
    if (shadowDocId !== undefined) payload.shadowDocId = shadowDocId;
    if (baseDocId !== undefined) payload.baseDocId = baseDocId;
    if (owner) payload.owner = owner;
    const res = await client.request('database.write', { payload });
    return textResult(JSON.stringify(res, null, 2));
  };

  const stepEditBranchEntry = async (action, input = {}) => {
    const { branchId, shadowDocId, baseDocId, owner } = branchTarget(input);
    if (branchId === undefined && shadowDocId === undefined && baseDocId === undefined) {
      return textResult(`${action} 需要 branchId/baseDocId/shadowDocId，或先 switch 到一个分支。`);
    }
    const payload = { action: `editBranch.${action}`, includeDoc: false };
    if (branchId !== undefined) payload.branchId = branchId;
    if (shadowDocId !== undefined) payload.shadowDocId = shadowDocId;
    if (baseDocId !== undefined) payload.baseDocId = baseDocId;
    if (owner) payload.owner = owner;
    const res = await client.request('database.write', { payload });
    return textResult(JSON.stringify(res, null, 2));
  };

  server.registerTool('edit', {
    description: `edit/full 档可见：把一条数据库编辑动作写入 edit branch；默认 owner=llm，不直接改主库。action 使用现有 node/axiom/ref/entity 写动作。${nodeTypeContractText}`,
    inputSchema: {
      action: z.enum([
        'node.update',
        'node.insert',
        'node.delete',
        'node.move',
        'node.promote',
        'node.split',
        'node.mergeInto',
        'node.reparent',
        'node.moveAfter',
        'axiom.add',
        'axiom.update',
        'axiom.delete',
        'axiom.move',
        'ref.addNodeToNode',
        'ref.addAxiomToNode',
        'ref.delete',
        'entity.create',
        'entity.update',
        'entity.delete',
        'entity.link',
        'entity.unlink',
        'entity.bindNode',
        'entity.ignoreNode',
        'entity.clearNodeBinding'
      ]),
      payload: z.record(z.string(), z.any()).optional().describe(`传给 database.write 的动作参数。${nodeTypeContractText}`),
      owner: ownerSchema.optional().describe('Default llm; accepts caller-defined owner id.'),
      baseDocId: docIdSchema.optional().describe('可选 editBranchBaseDocId；动作参数不能推出 docId 时必须给。')
    }
  }, async ({ action, payload = {}, owner = 'llm', baseDocId }) => {
    const writePayload = /** @type {Record<string, any>} */ ({ ...payload, action, editBranchOwner: owner });
    if (baseDocId !== undefined) writePayload.editBranchBaseDocId = baseDocId;
    const res = await client.request('database.write', { payload: writePayload });
    return textResult(JSON.stringify(res, null, 2));
  });

  server.registerTool('branch', {
    description: 'edit/full 档可见：管理当前已接入的 edit branch。支持 list/begin/diff/drop；merge/rebase 的完整三方模型仍走专门动词。',
    inputSchema: {
      action: z.enum(['list', 'begin', 'diff', 'drop']),
      docId: docIdSchema.optional(),
      branchId: z.number().int().positive().optional(),
      shadowDocId: docIdSchema.optional(),
      baseDocId: docIdSchema.optional(),
      owner: ownerSchema.optional(),
      yes: z.boolean().optional().describe('drop 默认只预览目标；true 时执行。')
    }
  }, async ({ action, docId, branchId, shadowDocId, baseDocId, owner, yes } = /** @type {BranchTargetArgs & { action?: string, docId?: DocId, yes?: boolean }} */ ({})) => {
    if (action === 'list') {
      const res = await client.request('database.read', {
        payload: { action: 'editBranch.listPending', ...(owner ? { owner } : {}) }
      });
      const branches = (res?.branches || []).filter((branch) => (
        docId ? String(branch.base_doc_id) === String(docId) : true
      ));
      return textResult(branches.map(formatBranchLine).join('\n') || '(无暂存分支)');
    }
    if (action === 'begin') {
      if (!docId) return textResult('branch begin 需要 docId。');
      const payload = { action: 'editBranch.begin', docId, includeDoc: false };
      if (owner) payload.owner = owner;
      const res = await client.request('database.write', { payload });
      return textResult(JSON.stringify(res, null, 2));
    }
    if (action === 'diff') {
      const payload = { action: 'editBranch.diffView' };
      const target = branchTarget({ branchId, shadowDocId, baseDocId, owner });
      if (target.branchId !== undefined) payload.branchId = target.branchId;
      if (target.shadowDocId !== undefined) payload.shadowDocId = target.shadowDocId;
      if (target.baseDocId !== undefined) payload.baseDocId = target.baseDocId;
      if (target.owner) payload.owner = target.owner;
      const res = await client.request('database.read', { payload });
      return jsonTextResult(res);
    }
    if (action === 'drop') {
      const target = branchTarget({ branchId, shadowDocId, baseDocId, owner });
      if (!hasBranchTarget(target)) return textResult('branch drop 需要 branchId/baseDocId/shadowDocId，或先 switch 到一个分支。');
      if (!yes) return branchPreview('drop', target);
      return discardChange(target);
    }
    return textResult(`未知 branch action: ${action}`);
  });

  server.registerTool('commit', {
    description: 'edit/full 档可见：保存当前 edit branch（生效 diff 写入主文档历史并删除该分支）。非快进（主干在分支期间已前移）时不再盲存：逐条前置验证账目，结构性失配返回 blocked（主干已被修改，无法保存，只能放弃该分支），字段级冲突返回 conflicts 等人裁（人裁走 merge 动词由人在 UI 处理，agent 不自动解冲突）。',
    inputSchema: {
      branchId: z.number().int().positive().optional(),
      shadowDocId: docIdSchema.optional(),
      baseDocId: docIdSchema.optional(),
      owner: ownerSchema.optional(),
      summary: z.string().optional(),
      tag: z.string().optional().describe('当前后端没有独立 tag 表；传入时作为 summary 使用。')
    }
  }, saveBranch);

  server.registerTool('merge', {
    description: 'edit/full 档可见：按 A5-10 把 edit branch 合入主干。默认只预览三方分类（fastForward、hasConflicts、逐节点 resolution 与扁平 conflicts，按稳定 node id 调和、不按地址）。yes=true 时执行 applyMerge——快进直接写回；非快进对账目逐条前置验证（乐观并发，O(改动数) 点查）：结构性失配（主干删了被改/被挂载的节点、并发移动、拆分/并入的内容漂移）返回 blocked=true + message「主干已被修改，无法保存，请放弃本次编辑」；字段级冲突返回 conflicts 等人裁；干净/收敛才写回。冲突与受阻时主干与分支均不动。',
    inputSchema: {
      branchId: z.number().int().positive().optional(),
      shadowDocId: docIdSchema.optional(),
      baseDocId: docIdSchema.optional(),
      owner: ownerSchema.optional(),
      summary: z.string().optional(),
      yes: z.boolean().optional()
    }
  }, async ({ yes, summary, ...rest } = /** @type {BranchTargetArgs & { summary?: string, yes?: boolean }} */ ({})) => {
    const target = branchTarget(rest);
    if (!hasBranchTarget(target)) return textResult('merge 需要 branchId/baseDocId/shadowDocId，或先 switch 到一个分支。');
    const payload = yes
      ? { action: 'editBranch.applyMerge', includeDoc: false }
      : { action: 'editBranch.threeWayMerge' };
    if (target.branchId !== undefined) payload.branchId = target.branchId;
    if (target.shadowDocId !== undefined) payload.shadowDocId = target.shadowDocId;
    if (target.baseDocId !== undefined) payload.baseDocId = target.baseDocId;
    if (target.owner) payload.owner = target.owner;
    if (yes && summary) payload.summary = summary;
    const res = await client.request(yes ? 'database.write' : 'database.read', { payload });
    return jsonTextResult(res);
  });

  server.registerTool('switch', {
    description: 'edit/full 档可见：切换当前 MCP 分支选择。后续 changes/commit/discard/undo/redo/merge/rebase/cherry-pick 未显式传目标时使用该选择。',
    inputSchema: { branchId: z.number().int().positive().optional(), baseDocId: docIdSchema.optional(), owner: ownerSchema.optional() }
  }, async ({ branchId, baseDocId, owner } = /** @type {{ branchId?: number, baseDocId?: DocId, owner?: string }} */ ({})) => {
    if (branchId === undefined && baseDocId === undefined) {
      return textResult(selectedBranch.branchId || selectedBranch.baseDocId
        ? JSON.stringify(selectedBranch, null, 2)
        : '(未选择分支)');
    }
    if (branchId !== undefined || baseDocId !== undefined) {
      const payload = { action: 'editBranch.diffView' };
      if (branchId !== undefined) payload.branchId = branchId;
      if (baseDocId !== undefined) payload.baseDocId = baseDocId;
      if (owner) payload.owner = owner;
      await client.request('database.read', { payload });
    }
    return textResult(JSON.stringify(setSelectedBranch({ branchId, baseDocId, owner }), null, 2));
  });

  server.registerTool('import', {
    description: 'edit/full 档可见：导入 library 内真实文件。mode 默认 simple，可为 simple/complete/direct/smart/vector。',
    inputSchema: {
      relativePath: z.string().describe('library 内相对路径，不要使用绝对路径。'),
      mode: z.enum(['simple', 'complete', 'direct', 'smart', 'vector']).optional()
    }
  }, importLibraryDocument);

  server.registerTool('vectors', {
    description: 'edit/full 档可见：为已导入文档补建语义向量。只接收 docId。',
    inputSchema: { docId: docIdSchema }
  }, ensureVectors);

  server.registerTool('push', {
    description: 'edit/full 档可见：流式写入（projectneed 4-16）。把一批消息节点直接追加进「增量编辑」文档，不走 edit branch。首次省略 docId、给 title 即新建增量编辑文档并挂在根下；之后给 docId + parentId(uuid 挂载点) 追加，省略 parentId 挂根下。每个节点必须显式给 trust_level（受控/不受控）；node_type 缺省 TEXT；更细结构放 children 数组递归（缩进即深度）。去重是调用方责任，系统只按 idempotencyKey 做请求级防抖。挂载点 uuid 可在增量编辑模式下用只读动词（tree/read）查到。',
    inputSchema: {
      docId: docIdSchema.optional().describe('目标增量编辑文档；省略且给 title 则新建。'),
      title: z.string().optional().describe('新建文档标题（仅首次、docId 省略时使用）。'),
      parentId: docIdSchema.optional().describe('挂载点节点 uuid；省略时挂在文档根节点下。'),
      nodes: z.array(z.any()).describe('节点数组；每个 { trust_level, node_type?, text?, node_title?, node_note?, address?, children? }。海量追加时给 address（调用方按读到的结构算好，系统校验纯追加并直写、不重排）；省略 address 则系统自动续号（小流友好）。children 递归表达子树。'),
      idempotencyKey: z.string().optional().describe('请求级防抖键；短时间内携带同键的重复推送只生效一次。'),
      vectors: z.boolean().optional().describe('是否对这批刚写入的节点即时生成向量（推一点算一点）。算力富裕、写入量小可开；海量导入建议不开以保写入吞吐，导完再离线补。声明开启但向量配置不可用会直接报错。')
    }
  }, async ({ docId, title, parentId, nodes, idempotencyKey, vectors } = /** @type {{ docId?: DocId, title?: string, parentId?: DocId, nodes?: any[], idempotencyKey?: string, vectors?: boolean }} */ ({})) => {
    const payload = { action: 'stream.push', nodes: nodes || [] };
    if (docId !== undefined) payload.docId = docId;
    if (title !== undefined) payload.title = title;
    if (parentId !== undefined) payload.parentId = parentId;
    if (idempotencyKey !== undefined) payload.idempotencyKey = idempotencyKey;
    if (vectors !== undefined) payload.vectors = vectors;
    const res = await client.request('database.write', { payload });
    return jsonTextResult(res);
  });

  server.registerTool('memory_deliver', {
    description: 'edit/full 档可见：事件卷投递（projectneed 18-8-4）——外部 agent 会话收尾把结构化自述日志投递成一个 session 卷（投递语义就是新建一个文档，15-10-1）。这是外部 agent 唯一合法的记忆侧写入形态（18-8-3）：投的是"发生过什么"的原料，不是记忆结论；不得直写当前事实层。节点一律 trust_level=不受控（15-10-3，受控会被拒绝）。自述日志骨架：用户原话逐字引用段（日志中唯一逐字的部分）、每任务结果标记（成功/失败）、失败与教训、可复用结论、宿主原始记录锚。卷落库后按 24h 节律自动封卷/进入可提炼（15-11-5）。',
    inputSchema: {
      agent: z.string().describe('agent 身份标识，如 claude-code、codex。'),
      sessionId: z.string().describe('宿主侧 session id。'),
      hostAnchor: z.string().optional().describe('宿主原始记录锚（路径+session id）；仅供人工深查，允许悬空。'),
      title: z.string().optional().describe('卷标题；省略时按 agent+日期+session 生成。'),
      startedAt: z.string().optional().describe('会话起始时间 ISO 8601。'),
      endedAt: z.string().optional().describe('会话结束时间 ISO 8601。'),
      nodes: z.array(z.any()).describe('自述日志节点树；每个 { text, trust_level:"不受控", node_title?, node_note?, children? }。'),
      idempotencyKey: z.string().optional().describe('投递级防抖键；重试不会长出第二个卷。')
    }
  }, async ({ agent, sessionId, hostAnchor, title, startedAt, endedAt, nodes, idempotencyKey } = /** @type {{ agent?: string, sessionId?: string, hostAnchor?: string, title?: string, startedAt?: string, endedAt?: string, nodes?: any[], idempotencyKey?: string }} */ ({})) => {
    const payload = { action: 'memory.deliverVolume', agent, sessionId, nodes: nodes || [] };
    if (hostAnchor !== undefined) payload.hostAnchor = hostAnchor;
    if (title !== undefined) payload.title = title;
    if (startedAt !== undefined) payload.startedAt = startedAt;
    if (endedAt !== undefined) payload.endedAt = endedAt;
    if (idempotencyKey !== undefined) payload.idempotencyKey = idempotencyKey;
    const res = await client.request('database.write', { payload });
    return jsonTextResult(res);
  });

  server.registerTool('memory_admin', {
    description: 'edit/full 档可见：记忆卷维护。seal_due=物理封卷所有到期卷（末次活动+24h，15-10-1）；mark_distilled=标记某卷已提炼（15-11-5；冷却期内默认拒绝，force 仅限用户明确指示"记一下"时使用，活跃卷上 force 是截至当下的快照标记、不封卷）。',
    inputSchema: {
      action: z.enum(['seal_due', 'mark_distilled']),
      docId: docIdSchema.optional().describe('mark_distilled 需要的卷 docId。'),
      force: z.boolean().optional().describe('mark_distilled：跳过冷却期（用户明确指示时）。')
    }
  }, async ({ action, docId, force } = /** @type {{ action?: string, docId?: DocId, force?: boolean }} */ ({})) => {
    const payload = action === 'seal_due'
      ? { action: 'memory.sealDue' }
      : { action: 'memory.markDistilled', docId, force: force === true };
    const res = await client.request('database.write', { payload });
    return jsonTextResult(res);
  });

  server.registerTool('set_mode', {
    description: 'edit/full 档可见：切换文档编辑模式（projectneed 4-16-8）。readonly 只读 / incremental 增量编辑（流式写入）/ full 完整编辑（2way/3way 分支与合并）。增量编辑与完整编辑互斥：流式写入期间不能分支编辑；要修订流式文档先切回 full，改完可再切回 incremental。',
    inputSchema: {
      docId: docIdSchema,
      mode: z.enum(['readonly', 'incremental', 'full'])
    }
  }, async ({ docId, mode } = /** @type {{ docId?: DocId, mode?: string }} */ ({})) => {
    const res = await client.request('database.write', { payload: { action: 'doc.setEditMode', docId, mode, includeDoc: false } });
    return jsonTextResult(res);
  });

  server.registerTool('bulk', {
    description: 'edit/full 档可见：海量流式导入加速会话（projectneed 4-16）。begin 设异步写（synchronous=OFF，journal 保持 WAL 不降级）；end 恢复安全设置并 checkpoint 截断 -wal。索引不再 drop/重建（SQL/FTS 全程增量维护，唯一延迟的重活是离线补 bge-m3 向量）。导大批语料时 begin → 多次 push → end；崩溃丢最近批由地址校验 + 幂等重推兜底。共享后端上 begin 需独占：有其他客户端在线会被拒，会话期间其他客户端的写请求被拒（读不受影响），开启方断线自动恢复安全设置。仅在专门导入阶段用，日常库勿开。',
    inputSchema: {
      action: z.enum(['begin', 'end'])
    }
  }, async ({ action } = /** @type {{ action?: 'begin' | 'end' }} */ ({})) => {
    const res = await client.request('database.write', { payload: { action: action === 'begin' ? 'stream.bulkBegin' : 'stream.bulkEnd' } });
    return jsonTextResult(res);
  });

  server.registerTool('changes', {
    description: 'edit/full 档可见：列出当前 edit branch 暂存变更；detail=true 时返回某个分支的 diffView。',
    inputSchema: {
      detail: z.boolean().optional(),
      branchId: z.number().int().positive().optional(),
      shadowDocId: docIdSchema.optional(),
      baseDocId: docIdSchema.optional(),
      owner: ownerSchema.optional()
    }
  }, async ({ detail, branchId, shadowDocId, baseDocId, owner } = /** @type {BranchTargetArgs & { detail?: boolean }} */ ({})) => {
    if (detail) {
      const payload = { action: 'editBranch.diffView' };
      const target = branchTarget({ branchId, shadowDocId, baseDocId, owner });
      if (target.branchId !== undefined) payload.branchId = target.branchId;
      if (shadowDocId !== undefined) payload.shadowDocId = shadowDocId;
      if (target.baseDocId !== undefined) payload.baseDocId = target.baseDocId;
      if (target.owner) payload.owner = target.owner;
      const res = await client.request('database.read', { payload });
      return jsonTextResult(res);
    }
    const res = await client.request('database.read', {
      payload: { action: 'editBranch.listPending', ...(owner ? { owner } : {}) }
    });
    const lines = (res?.branches || []).map(formatBranchLine);
    return textResult(lines.join('\n') || '(无暂存分支)');
  });

  server.registerTool('discard', {
    description: 'edit/full 档可见：丢弃一条 agent 待审 diff（给 diffId），或丢弃一个 edit branch（给 branchId/baseDocId/shadowDocId）。branch 丢弃默认只预览，yes=true 时执行。',
    inputSchema: {
      diffId: z.union([z.number().int().positive(), z.string()]).optional(),
      branchId: z.number().int().positive().optional(),
      shadowDocId: docIdSchema.optional(),
      baseDocId: docIdSchema.optional(),
      owner: ownerSchema.optional(),
      yes: z.boolean().optional()
    }
  }, async ({ yes, ...rest } = /** @type {BranchTargetArgs & { diffId?: number | string, yes?: boolean }} */ ({})) => {
    if (rest.diffId !== undefined && rest.diffId !== null && rest.diffId !== '') return discardChange(rest);
    const target = branchTarget(rest);
    if (!hasBranchTarget(target)) return textResult('discard 需要 diffId，或 branchId/baseDocId/shadowDocId，或先 switch 到一个分支。');
    if (!yes) return branchPreview('discard', target);
    return discardChange(target);
  });

  server.registerTool('undo', {
    description: 'edit/full 档可见：撤销当前 edit branch 内最后一条生效临时 diff entry，只改变 entry 的 active/undone 状态，不写入主文档历史。',
    inputSchema: {
      branchId: z.number().int().positive().optional(),
      shadowDocId: docIdSchema.optional(),
      baseDocId: docIdSchema.optional(),
      owner: ownerSchema.optional()
    }
  }, (input = {}) => stepEditBranchEntry('undo', input));

  server.registerTool('redo', {
    description: 'edit/full 档可见：恢复当前 edit branch 内最近一条已撤销临时 diff entry，只改变 entry 的 active/undone 状态，不写入主文档历史。',
    inputSchema: {
      branchId: z.number().int().positive().optional(),
      shadowDocId: docIdSchema.optional(),
      baseDocId: docIdSchema.optional(),
      owner: ownerSchema.optional()
    }
  }, (input = {}) => stepEditBranchEntry('redo', input));

  server.registerTool('list_diffs', {
    description: '列出内置 agent 提议的待审改动（id、动作、摘要、目标地址）。edit/full 档可见。'
  }, async () => {
    const res = await client.request('agent.diffs', {});
    const diffs = Array.isArray(res) ? res : (res?.diffs || []);
    const lines = diffs.map((d) => `${d.id}\t${d.action || ''}\t${d.summary || ''}\t${d.meta?.address || d.meta?.parentAddress || ''}`);
    return textResult(lines.join('\n') || '(无待审改动)');
  });

  server.registerTool('reject_diff', {
    description: '丢弃一条待审改动。diffId 来自 list_diffs。edit/full 档可见。',
    inputSchema: { diffId: z.union([z.number().int().positive(), z.string()]) }
  }, discardChange);

  if (tier === 'full') {
    server.registerTool('restore', {
      description: 'full 档可见：按 save_history history id、saved_at 精确时间戳或 summary tag 精确回滚文档历史。tag 对应当前兼容期 commit --tag 写入的 summary。',
      inputSchema: {
        ref: z.union([docIdSchema, z.string()]).optional().describe('history id、saved_at 或 summary tag；若是数字按 history id 解析。'),
        historyId: docIdSchema.optional().describe('save_history id。'),
        savedAt: z.string().optional().describe('精确匹配 save_history.saved_at。'),
        at: z.string().optional().describe('savedAt 的别名。'),
        tag: z.string().optional().describe('精确匹配 save_history.summary。'),
        docId: docIdSchema.optional().describe('ref/tag/savedAt 命中多条时用于限定文档。')
      }
    }, async ({ ref, historyId, savedAt, at, tag, docId } = /** @type {{ ref?: DocId, historyId?: DocId, savedAt?: string, at?: string, tag?: string, docId?: DocId }} */ ({})) => {
      const argv = ['restore'];
      if (historyId !== undefined) argv.push('--history', String(historyId));
      else if (savedAt || at) argv.push('--at', String(savedAt || at));
      else if (tag) argv.push('--tag', String(tag));
      else if (ref !== undefined) argv.push(String(ref));
      else return textResult('restore 需要 ref/historyId/savedAt/at/tag。');
      if (docId !== undefined) argv.push(String(docId));
      return textResult(await dbShell(client, argv));
    });

    server.registerTool('forget', {
      description: 'full 档可见：删除已导入文档的 doc 数据，不删除 library 真实文件。',
      inputSchema: { docId: docIdSchema }
    }, async ({ docId }) => {
      const res = await client.request('import.deleteDocument', { payload: { docId } });
      if (!res?.ok) return textResult(`删除失败：${JSON.stringify(res)}`);
      return textResult(`${res.changed ? '已删除' : '未找到'} doc ${docId}${res.title ? `「${res.title}」` : ''}`);
    });

    server.registerTool('export', {
      description: 'full 档可见：导出一个已导入 doc 为 Markdown 文本。当前实现返回文本，不写文件。',
      inputSchema: { docId: docIdSchema }
    }, async ({ docId }) => {
      const res = await client.request('database.read', {
        payload: { action: 'doc.exportMarkdown', docId }
      });
      return textResult(res?.text || '');
    });

    server.registerTool('rebase', {
      description: 'full 档可见：把当前 edit branch 的 lazy base 刷新到当前主干 HEAD，并返回分支状态。当前不是完整冲突裁决器。',
      inputSchema: {
        branchId: z.number().int().positive().optional(),
        baseDocId: docIdSchema.optional(),
        owner: ownerSchema.optional()
      }
    }, async ({ branchId, baseDocId, owner } = /** @type {{ branchId?: number, baseDocId?: DocId, owner?: string }} */ ({})) => {
      const target = branchTarget({ branchId, baseDocId, owner });
      if (target.branchId === undefined && target.baseDocId === undefined) {
        return textResult('rebase 需要 branchId/baseDocId，或先 switch 到一个分支。');
      }
      const payload = { action: 'editBranch.rebase', includeDoc: false };
      if (target.branchId !== undefined) payload.branchId = target.branchId;
      if (target.baseDocId !== undefined) payload.baseDocId = target.baseDocId;
      if (target.owner) payload.owner = target.owner;
      const res = await client.request('database.write', { payload });
      return textResult(JSON.stringify(res, null, 2));
    });

    server.registerTool('cherry-pick', {
      description: 'full 档可见：从同一文档的保存历史或 edit branch 中摘取 edit entries，写入目标 edit branch。未指定目标时使用 switch 当前分支，或按 targetBaseDocId/owner 自动开分支。',
      inputSchema: {
        historyId: docIdSchema.optional(),
        sourceHistoryId: docIdSchema.optional(),
        sourceBranchId: z.number().int().positive().optional(),
        targetBranchId: z.number().int().positive().optional(),
        targetBaseDocId: docIdSchema.optional(),
        owner: ownerSchema.optional(),
        entryId: z.string().optional(),
        entryIndex: z.number().int().nonnegative().optional()
      }
    }, async ({ historyId, sourceHistoryId, sourceBranchId, targetBranchId, targetBaseDocId, owner, entryId, entryIndex } = /** @type {{ historyId?: DocId, sourceHistoryId?: DocId, sourceBranchId?: number, targetBranchId?: number, targetBaseDocId?: DocId, owner?: string, entryId?: string, entryIndex?: number }} */ ({})) => {
      const target = branchTarget({ branchId: targetBranchId, baseDocId: targetBaseDocId, owner });
      const payload = { action: 'editBranch.cherryPick', includeDoc: false };
      if (sourceHistoryId !== undefined || historyId !== undefined) payload.sourceHistoryId = sourceHistoryId ?? historyId;
      if (sourceBranchId !== undefined) payload.sourceBranchId = sourceBranchId;
      if (target.branchId !== undefined) payload.targetBranchId = target.branchId;
      if (target.baseDocId !== undefined) payload.targetBaseDocId = target.baseDocId;
      if (target.owner) payload.targetOwner = target.owner;
      if (entryId !== undefined) payload.entryId = entryId;
      if (entryIndex !== undefined) payload.entryIndex = entryIndex;
      const res = await client.request('database.write', { payload });
      return textResult(JSON.stringify(res, null, 2));
    });

    server.registerTool('apply_diff', {
      description: '接受一条待审改动并保存到分支（完全权限）。diffId 来自 list_diffs。仅 full 档可见。',
      inputSchema: { diffId: z.union([z.number().int().positive(), z.string()]) }
    }, async ({ diffId }) => {
      const res = await client.request('agent.applyDiff', { payload: { diffId } });
      return textResult(res?.ok ? `已接受 diff ${diffId}${res.docId ? `（doc ${res.docId}）` : ''}` : `接受失败：${JSON.stringify(res)}`);
    });
  }
}

async function main() {
  // 后端共用（projectneed 18-6-1）：写档（edit/full）实例经连接描述文件发现并复用共享后端，
  // 连不上自行拉起（detached），单机离线回退私有 stdio；只读实例照旧各起私有后端（并发读安全）。
  const hostScriptPath = join(PROJECT_ROOT, 'scripts', 'agent-host.mjs');
  const client = (TIER === 'edit' || TIER === 'full')
    ? createSharedBackendClient({
      projectRoot: PROJECT_ROOT,
      hostScriptPath,
      onStderr: (text) => process.stderr.write(text),
      onStatus: (text) => process.stderr.write(text)
    })
    : createHeadlessAgentClient({
      cwd: PROJECT_ROOT,
      scriptPath: hostScriptPath,
      onStderr: (text) => process.stderr.write(text)
    });

  // schema 自述（projectneed 15-12-5 / 18-8-1）：外部 agent 接入第一读物。
  // 数百 token 的约定说明，不是内容清单——不预载"库里有什么"。
  const SERVER_INSTRUCTIONS = [
    'IF-Tree 条件树知识库 + agent 记忆库。本说明是接入约定，不是内容清单——知道库里有什么是检索的产物，不是检索的前提，请直接检索。',
    '',
    '三层时态（结构同构、语义异质）：完整记忆（session 事件卷）答"确曾发生"——一个 session 一卷，只追加、封卷不可变、永不删除；长期核心记忆答"现在如此"——经提炼与人工审批产生的当前事实层，回指事件出处；知识文档答"未来可用"——导入的资料。树地址统一：1 是根，1-3-2 是 1-3 的第 2 个子节点，前缀即父子。',
    '',
    '检索动词：library_index（库目录）、tree（结构）、read（正文）、find（多词 AND 关键词 / semantic 语义）、article（原文窗口）、memory_volumes（列记忆卷及状态）、log/diff（历史）、sql（只读核对）、ask_agent（问内置智能体）。查询纪律：命中预览只用于选候选，下结论前必须 read 回正文证据；搜索为空先拆词重试、再下钻结构，不要直接断言没有。开工先看最近发生过什么（memory_volumes），再做手头任务。',
    '',
    '信任语义：节点分受控（经人工审批）/不受控（机器产物未经人审）；事件卷一律不受控——这是层级的时态属性，不是质量评分。命中未解决的 ERROR 节点必须停下向用户报告，不得绕过续跑。',
    '',
    '时间纪律：召回结果附带时间元数据，采信前先看时间；同主题证据冲突新者胜，不得以"内容看起来更合理"推翻时间新旧；找不到更新的证据时，旧证据就是最佳可用证据，知旧而用。',
    '',
    '记忆写入边界（18-8-3）：外部 agent 唯一合法的记忆侧写入是事件卷投递（memory_deliver，edit/full 档）——会话收尾把结构化自述日志投递成卷，用户说"记一下"时当场投快照卷；契约与骨架见 .iftree-llm-workspace/skills/memory-deliver/SKILL.md。不得把自己的结论直写成记忆。'
  ].join('\n');

  const server = new McpServer({ name: 'iftree-library', version: '0.2.0' }, { instructions: SERVER_INSTRUCTIONS });
  registerRetrievalTools(server, client);
  registerAgentTools(server, client);
  registerLifecycleTools(server, client);
  if (TIER === 'edit' || TIER === 'full') registerWriteTools(server, client, TIER);

  const shutdown = async () => {
    try { await client.shutdown(); } catch { /* already closing */ }
    client.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || error}\n`);
  process.exit(1);
});
