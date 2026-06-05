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
import { NODE_TYPES, NODE_TYPE_LABELS } from '../src/core/node-model.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docIdSchema = z.union([z.string().min(1), z.number().int().positive()]);
const ownerSchema = z.string().min(1);
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
  }, async ({ folder, includeSummary, uuid } = {}) => {
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
  }, async ({ terms, query, semantic, tags, docId, allDocs, scopeAddress, limit, uuid } = {}) => {
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
  }, async ({ docId, fromHistoryId, toHistoryId, historyId, branchId, shadowDocId, baseDocId, owner } = {}) => {
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
      params: z.any().optional().describe('可选 SQL 参数；数组对应 ? 参数，对象对应 @name 参数。'),
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
  const branchTarget = ({ branchId, shadowDocId, baseDocId, owner } = {}) => ({
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
      payload: z.record(z.any()).optional().describe(`传给 database.write 的动作参数。${nodeTypeContractText}`),
      owner: ownerSchema.optional().describe('Default llm; accepts caller-defined owner id.'),
      baseDocId: docIdSchema.optional().describe('可选 editBranchBaseDocId；动作参数不能推出 docId 时必须给。')
    }
  }, async ({ action, payload = {}, owner = 'llm', baseDocId }) => {
    const writePayload = { ...payload, action, editBranchOwner: owner };
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
  }, async ({ action, docId, branchId, shadowDocId, baseDocId, owner, yes } = {}) => {
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
    description: 'edit/full 档可见：保存当前 edit branch。当前后端语义是把生效 diff 写入主文档历史并删除该分支。',
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
    description: 'edit/full 档可见：合入一个 edit branch。默认只预览目标，yes=true 时执行；当前后端仅支持无三方冲突模型的 editBranch.save。',
    inputSchema: {
      branchId: z.number().int().positive().optional(),
      shadowDocId: docIdSchema.optional(),
      baseDocId: docIdSchema.optional(),
      owner: ownerSchema.optional(),
      summary: z.string().optional(),
      yes: z.boolean().optional()
    }
  }, async ({ yes, ...rest } = {}) => {
    const target = branchTarget(rest);
    if (!hasBranchTarget(target)) return textResult('merge 需要 branchId/baseDocId/shadowDocId，或先 switch 到一个分支。');
    if (!yes) return branchPreview('merge', target);
    return saveBranch(rest);
  });

  server.registerTool('switch', {
    description: 'edit/full 档可见：切换当前 MCP 分支选择。后续 changes/commit/discard/undo/redo/merge/rebase/cherry-pick 未显式传目标时使用该选择。',
    inputSchema: { branchId: z.number().int().positive().optional(), baseDocId: docIdSchema.optional(), owner: ownerSchema.optional() }
  }, async ({ branchId, baseDocId, owner } = {}) => {
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

  server.registerTool('changes', {
    description: 'edit/full 档可见：列出当前 edit branch 暂存变更；detail=true 时返回某个分支的 diffView。',
    inputSchema: {
      detail: z.boolean().optional(),
      branchId: z.number().int().positive().optional(),
      shadowDocId: docIdSchema.optional(),
      baseDocId: docIdSchema.optional(),
      owner: ownerSchema.optional()
    }
  }, async ({ detail, branchId, shadowDocId, baseDocId, owner } = {}) => {
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
  }, async ({ yes, ...rest } = {}) => {
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
    }, async ({ ref, historyId, savedAt, at, tag, docId } = {}) => {
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
    }, async ({ branchId, baseDocId, owner } = {}) => {
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
    }, async ({ historyId, sourceHistoryId, sourceBranchId, targetBranchId, targetBaseDocId, owner, entryId, entryIndex } = {}) => {
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
  const client = createHeadlessAgentClient({
    cwd: PROJECT_ROOT,
    scriptPath: join(PROJECT_ROOT, 'scripts', 'agent-host.mjs'),
    onStderr: (text) => process.stderr.write(text)
  });

  const server = new McpServer({ name: 'iftree-library', version: '0.1.0' });
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
