#!/usr/bin/env node
// MCP entry (projectneed `18`): official MCP SDK thin shell over the headless
// backend. Exposes the retrieval channel (db.shell / database.read) and the
// A2A channel (agent.run -> built-in agent). The shell itself touches no native
// module; it delegates to the headless host, which inherits this process's
// runtime via spawnSharedBackend (process.execPath). Launch with node for a
// pure node-ABI host — the headless deploy path (projectneed `18` 解耦):
//   node scripts/mcp-server.mjs                            (npm run mcp:node)
// electron-as-node still works for desktop co-debugging (host gets Electron ABI):
//   ELECTRON_RUN_AS_NODE=1 electron scripts/mcp-server.mjs (npm run mcp)
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createBackendClient } from '../src/backend/llm/backend-client.mjs';
import { NODE_TYPES, NODE_TYPE_LABELS } from '../src/core/node-model.mjs';
import { formatDiffText } from '../src/backend/diff-text.mjs';
import { formatBranchLine, parseBranchEntryCounts } from '../src/backend/branch-status.mjs';
import { formatThreeWayMergeText } from '../src/backend/merge-text.mjs';
import { parseDiffRef } from '../src/backend/diff-refs.mjs';
import { formatWriteResult, formatPushResult, formatDeliverResult, formatVolumeList, formatSqlResult } from '../src/backend/write-result-text.mjs';
import { clipText, CHAR_LIMITS } from '../src/backend/text-budget.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// doc/node/commit(历史)/ref 标识统一为 UUID v7 字符串；整数 id 已退役（save_history 退役后不再有整数历史 id）。
const docIdSchema = z.string().min(1);
const ownerSchema = z.string().min(1);

/** @typedef {string | number} DocId */
/** @typedef {{ branchId?: number, shadowDocId?: DocId, baseDocId?: DocId, owner?: string }} BranchTargetArgs */
const nodeTypeContractText = `节点类型统一写 node_type/nodeType，不再使用 human_tag。内部码：${NODE_TYPES.join(', ')}；中文标签：${Object.values(NODE_TYPE_LABELS).join(' / ')}。`;

// Permission tier picked at launch by the deployment (projectneed `18-3`).
// 四档：read 只读 / edit 隔离编辑（owner=llm 待审）/ full 完全（仍 llm 身份，多几把运维动词、
// 不直写主库、不审批、不标受控）/ human 人类档（owner=human，主库内容的唯一权威：直写、
// 审批 merge llm 待审、标受控）。yolo 是 human 的俗称别名。
const RAW_TIER = (process.env.IFTREE_MCP_TIER || 'read').toLowerCase();
const TIER = RAW_TIER === 'yolo' ? 'human' : RAW_TIER;
const IS_WRITE_TIER = TIER === 'edit' || TIER === 'full' || TIER === 'human';
// 写入者身份由启动档位决定（projectneed 18-3）：human 档 role=human、其余 role=llm；运行中不升档——
// 非 human 档不接受调用方自报 human 身份（honor 级，无安全边界，只是让档位名副其实）。
// owner 编码 role:user（身份前缀，后端新建草稿时补 #ts 唯一化）：role 由档位定，user 读 IFTREE_OWNER
// 配置注入（不同 agent 各配各的，如 claude-code / codex），缺省 default。人类不走 MCP、经 db shell 传身份。
const OWNER_ROLE = TIER === 'human' ? 'human' : 'llm';
const OWNER_USER = (process.env.IFTREE_OWNER || 'default').trim() || 'default';
const DEFAULT_WRITE_OWNER = `${OWNER_ROLE}:${OWNER_USER}`;

// switch 选中的当前草稿（进程内全局，见 15-5-2-1）：read 档的 diff 与 write 档动词共享同一选择，
// 切一次草稿后 diff/commit/merge/discard/undo/redo 未显式传目标时都用它。registerWriteTools 只调一次，
// 提到模块作用域不改变行为，只是让 read 档的 diff 也够得着这份选择。
const selectedBranch = { branchId: null, baseDocId: null, owner: null };

// owner 作为「写入身份」时的归一（edit 的 editBranchOwner、draft new 的新草稿 owner）；
// 作为「分支选择器」用的 owner（list/diff/drop/merge/switch 指向已存在分支）不走这里。
function resolveWriteOwner(owner) {
  const raw = owner == null ? '' : String(owner).trim();
  // 按 role 段判断（owner 可能是 role:user 身份前缀，或旧式裸 human）：非 human 档不接受 human 身份注入。
  if (TIER !== 'human' && raw && raw.split(':', 1)[0].toLowerCase() === 'human') {
    return { error: '当前档位不能以 human 身份写入；human 身份只在 human 档（IFTREE_MCP_TIER=human）下可用。' };
  }
  return { owner: raw || DEFAULT_WRITE_OWNER };
}

function textResult(text) {
  return { content: [{ type: 'text', text: String(text ?? '') }] };
}

function jsonTextResult(value) {
  return textResult(JSON.stringify(value, null, 2));
}

// diff 视图 JSON 收口：rows 的 left/right 节点双挂 snake+camel 又带一堆指纹/字数，对 LLM 看 diff 是噪声；
// 只留对账(id/address)与内容(type/text/title/note/trust)字段，branch 的 diff/base_snapshot 全文转义串也丢
// （前端走 IPC 另路、不受此处影响）。无 rows 的 res（refs/history entries 形态）原样返回。
function slimDiffNode(n) {
  if (!n || typeof n !== 'object') return n;
  const out = /** @type {Record<string, any>} */ ({ id: n.id, address: n.address, node_type: n.node_type, text: n.text, node_title: n.node_title, node_note: n.node_note, trust_level: n.trust_level });
  if (n.status) out.status = n.status;
  if (n.pending_insert) out.pending_insert = true;
  return out;
}
function slimDiffView(res) {
  if (!res || typeof res !== 'object' || !Array.isArray(res.rows)) return res;
  const out = /** @type {Record<string, any>} */ ({ ...res });
  out.rows = res.rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const next = { ...row };
    if (next.left) next.left = slimDiffNode(next.left);
    if (next.right) next.right = slimDiffNode(next.right);
    return next;
  });
  if (out.branch && typeof out.branch === 'object') {
    const { diff: _diff, base_snapshot: _snap, ...rest } = out.branch;
    out.branch = rest;
  }
  return out;
}

// MCP 写动词返回收口：store 的写返回是给 IPC/前端的——node 双挂 snake+camel、editBranch 带
// base_snapshot/diff 全文转义串，对 LLM 是纯噪声且每次重复。这里只留结果要点：动作状态、节点
// 关键字段、分支的改增删移计数（由 branch.diff 现算），丢掉重复键与快照大字符串。
function slimWriteResult(res) {
  if (!res || typeof res !== 'object') return res;
  const out = /** @type {Record<string, any>} */ ({});
  for (const k of ['ok', 'action', 'changed', 'applied', 'fastForward', 'docId', 'baseDocId', 'shadowDocId', 'branchId', 'undoDepth', 'redoDepth']) {
    if (k in res) out[k] = res[k];
  }
  // 写动作被拒/受阻时透传诊断：commit/merge 非快进会返回 blocked/message（结构性受阻）或 conflicts（字段冲突），
  // agent 要靠它判因、靠 conflicts 清单生成 resolutions 折叠冲突——slim 只收口成功路径的重复噪声，
  // 失败账目本身就是结果要点，不能丢（nodes 全量快照体积大且 conflicts 已够裁决，仍不带）。
  if (res.applied === false) {
    for (const k of ['blocked', 'message', 'conflicts', 'blockedConflicts', 'resolutionErrors']) {
      if (k in res) out[k] = res[k];
    }
  }
  if (res.node && typeof res.node === 'object') {
    const n = res.node;
    out.node = { id: n.id, address: n.address, node_type: n.node_type, text: n.text, node_title: n.node_title, node_note: n.node_note, trust_level: n.trust_level };
    if (n.pending_insert) out.node.pending_insert = true;
  }
  if (res.insertedNodeId != null) out.insertedNodeId = res.insertedNodeId;
  const branch = res.editBranch || res.branch;
  if (branch && typeof branch === 'object' && branch.id != null) {
    const c = parseBranchEntryCounts(branch);
    out.branch = { id: branch.id, owner: branch.owner, status: branch.status, counts: { 改: c.update, 增: c.insert, 删: c.delete, 移: c.move, 其他: c.other, 撤销: c.undone } };
  }
  if (res.history && typeof res.history === 'object') {
    out.history = { commit_id: res.history.commit_id || res.history.id, summary: res.history.summary, saved_at: res.history.saved_at };
  }
  return out;
}

async function dbShell(client, argv, currentDocId) {
  const res = await client.dbShell(argv, { currentDocId });
  return res?.text != null ? String(res.text) : '';
}

function registerRetrievalTools(server, client) {
  server.registerTool('library_index', {
    description: '按 library 文件夹包含层级列出已导入文档的 ASCII tree；默认文件节点显示文件名、字数和语义状态，不显示 UUID；uuid=true 时附 #docId。未导入文件不列出；(xxx字) 是该文档节点 1 的整棵子树正文合计，不是节点 1 自有正文。默认不显示摘要，includeSummary=true 时才附加摘要内容。',
    inputSchema: {
      folder: z.string().optional().describe('可选 library 相对文件夹路径；省略时从 library 根列出。'),
      includeSummary: z.boolean().optional().describe('默认 false；true 时附加摘要内容。字数仍表示整棵子树正文合计，不是节点自有正文。'),
      includeHidden: z.boolean().optional().describe('默认 false：忽略 . 开头隐藏文件夹（如事件卷锚所在的 .memory）。true 时一并列出。'),
      uuid: z.boolean().optional().describe('true 时显示 #docId；默认 false，只显示文件名作为文档标签。')
    }
  }, async ({ folder, includeSummary, includeHidden, uuid } = /** @type {{ folder?: string, includeSummary?: boolean, includeHidden?: boolean, uuid?: boolean }} */ ({})) => {
    const payload = { action: 'library.index' };
    if (folder) payload.path = folder;
    if (includeSummary) payload.includeSummary = true;
    if (includeHidden) payload.includeHidden = true;
    if (uuid) payload.uuid = true;
    const res = await client.databaseRead(payload);
    return textResult(res?.text || '(库里暂无已导入文档)');
  });

  server.registerTool('tree', {
    description: '查看文档结构（缩进 ASCII 树：地址 类型 标题 (子树字数)）。可选 address 只看某子树，depth 限层。地址形如 1、1-3、1-3-2，是相对地址。注意字数是整棵子树合计，不是该节点自有正文。',
    inputSchema: {
      docId: docIdSchema.describe('已导入文档的 doc id。'),
      address: z.string().optional().describe('可选节点地址；省略时从节点 1 展开。输出中的字数是该地址节点的子树合计。'),
      nodeId: docIdSchema.optional().describe('可选节点稳定 UUID：兼容定位入口，给了即从该节点子树展开（优先于 address）。'),
      depth: z.number().int().positive().optional().describe('可选展开层数；输出中的 (xxx) 仍是各节点整棵子树合计，不是节点自有正文。'),
      at: z.union([docIdSchema, z.string()]).optional().describe('可选历史 ref（commit id/committed_at/summary tag）：看该版本的结构快照。给 address 时默认按节点身份穿透（当前 address→node_id，节点换过地址也认得）。'),
      atAddress: z.boolean().optional().describe('与 at 配合：true 时按历史地址定位（git <commit>:<path> 语义，查已删节点/某版本某位置）；默认按当前节点身份穿透。'),
      uuid: z.boolean().optional().describe('true 时保留稳定 id；默认 false。')
    }
  }, async ({ docId, address, depth, at, atAddress, uuid, nodeId }) => {
    const argv = ['tree', String(docId)];
    if (address) argv.push(address);
    if (nodeId) argv.push('--node-id', String(nodeId));
    if (depth) argv.push('--depth', String(depth));
    if (at !== undefined) argv.push('--at', String(at));
    if (atAddress) argv.push('--at-address');
    if (uuid) argv.push('--uuid');
    return textResult((await dbShell(client, argv)) || '(空)');
  });

  server.registerTool('read', {
    description: '读取文档某地址的正文，只回正文、不带节点头。scope 选范围：subtree(默认，整棵子树正文拼接)/node(只本节点)/siblings(同父前中后三条)。必须定位到具体节点：address 传到小节（如 1-1、1-3-2）或给 nodeId——本系统的文档是检索定位用的、不是从头通读，直读根地址 1（=整篇）是反常用法，正常连读开头都该传 1-1。子树正文有 1 万字门禁（超了分层早停、只返回前几层并提示），要完整读大段得显式加大 limit 二次突破。全篇结构用 tree、定长原文窗口用 article、元信息/出处/引用用 inspect；历史版本传 at。命中过碎时读父地址或相邻地址补上下文。',
    inputSchema: {
      docId: docIdSchema,
      address: z.string().optional().describe('节点地址(如 1-3-2)：主定位方式；与 nodeId 二选一，二者皆给时以 nodeId 为准。'),
      nodeId: docIdSchema.optional().describe('节点稳定 UUID：兼容定位入口，可传 inspect / log·diff / 引用括号 拿到的 node_id 直接读，免去先换算地址；address 仍是主路径（find 命中只给地址、不输出 node_id，要 node_id 用 inspect 单节点取）。'),
      scope: z.enum(['node', 'subtree', 'siblings']).optional().describe('读取范围：subtree 整棵子树正文拼接(默认)/node 只本节点/siblings 同父前中后三条。'),
      at: z.union([docIdSchema, z.string()]).optional().describe('可选历史 ref：commit id（UUID）、committed_at 或 summary tag；只读历史快照。默认按节点身份穿透（当前 address→node_id，节点换过地址也认得；不在该版本则报错，而非静默命中同址别的节点）。'),
      atAddress: z.boolean().optional().describe('与 at 配合：true 时按历史地址定位（git <commit>:<path> 语义，查已删节点/某版本某位置）；默认按当前节点身份穿透。'),
      limit: z.number().int().positive().optional().describe('子树正文字数门禁；默认 1 万字（分层早停、超了只返回前几层）。要完整读大子树就显式加大它——这是突破门禁的二次确认。'),
      uuid: z.boolean().optional().describe('true 时头部显示 doc:UUID；默认显示文档标签。')
    }
  }, async ({ docId, address, scope, at, atAddress, limit, uuid, nodeId }) => {
    if (!address && !nodeId) {
      return textResult('read 要先定位到具体节点：传 address（正常到小节，如 1-1、1-3-2）或 nodeId。本系统的文档是检索定位用的、不是从头通读——直读根地址 1 等于拉整篇，是反常用法（连读开头都该传 1-1）；先用 tree 看结构，挑要读的小节再 read。');
    }
    const argv = ['read', String(docId)];
    if (address) argv.push(String(address));
    if (scope) argv.push('--range', String(scope));
    if (nodeId) argv.push('--node-id', String(nodeId));
    if (at !== undefined) argv.push('--at', String(at));
    if (atAddress) argv.push('--at-address');
    if (limit) argv.push('--limit', String(limit));
    if (uuid) argv.push('--uuid');
    return textResult(await dbShell(client, argv));
  });

  server.registerTool('inspect', {
    description: '节点/文档档案：身份段(doc/地址/类型/信任/标题) + 选取的附加段。sections 逗号分隔选 meta(updated/created/sort/hash)、source(原文出处+spans，原 blame)、links(引用进出)、axioms(文档事实前提，地址为根时)、note(备注)；默认 meta,note。读正文用 read、原文窗口用 article。',
    inputSchema: {
      docId: docIdSchema,
      address: z.string().optional().describe('节点地址(如 1-3-2)：主定位方式；与 nodeId 二选一，二者皆给时以 nodeId 为准。'),
      nodeId: docIdSchema.optional().describe('节点稳定 UUID：兼容定位入口，可直接传 inspect / log·diff / 引用 拿到的 node_id；address 仍是主路径（find 不输出 node_id）。'),
      sections: z.string().optional().describe('逗号分隔选段：meta,source,links,axioms,note；默认 meta,note。'),
      limit: z.number().int().positive().optional(),
      uuid: z.boolean().optional().describe('true 时身份行显示 doc:UUID；默认显示文档标签。')
    }
  }, async ({ docId, address, sections, limit, uuid, nodeId }) => {
    if (!address && !nodeId) return textResult('inspect 需要 address 或 nodeId 之一。');
    const argv = ['inspect', String(docId)];
    if (address) argv.push(String(address));
    if (sections) argv.push('--sections', String(sections));
    if (nodeId) argv.push('--node-id', String(nodeId));
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
      tags: z.boolean().optional().describe('true 时不返回节点，返回输入词的实体同义/相关列表；实体按文档存储，仍需配合 docId/allDocs/folder 圈定范围。'),
      docId: docIdSchema.optional().describe('限定单篇文档；与 allDocs 二选一。'),
      allDocs: z.boolean().optional().describe('true 时跨所有已导入文档检索；与 docId 二选一。'),
      scopeAddress: z.string().optional().describe('可选局部节点地址；需要同时给 docId。'),
      limit: z.number().int().positive().optional().describe('可选返回数量上限。'),
      matchMode: z.enum(['doc', 'node', 'or']).optional().describe('字面检索匹配模式：doc=文档级AND(默认,高命中,词可分散在同文档不同节点)、node=节点级AND(精确同节点共现)、or=任一词命中。'),
      workspace: z.string().optional().describe('按工作区过滤(逗号分隔多值)，如 D--WorkSpace-IFTreeEditor。'),
      agent: z.string().optional().describe('按记忆卷 agent 过滤(逗号分隔)，如 claude-code、iftree-builtin。'),
      kind: z.string().optional().describe('按文档类型过滤(逗号分隔)：event=事件卷、memory=核心记忆、knowledge=知识文档。'),
      trust: z.string().optional().describe('按信任层过滤(逗号分隔)：受控 / 不受控。'),
      since: z.string().optional().describe('只返回 updated_at ≥ 此时间(ISO 8601)的节点。'),
      until: z.string().optional().describe('只返回 updated_at ≤ 此时间(ISO 8601)的节点。'),
      at: z.union([docIdSchema, z.string()]).optional().describe('可选历史 ref（commit id/committed_at/summary tag）：在该版本快照上做字面检索（仅单篇、不支持 semantic/tags/跨文档）。'),
      folder: z.string().optional().describe('按 library 文件夹子树限定跨文档检索范围（= 检索该文件夹这篇大型虚拟文档），如 generated 或 testtext/无限规则test；folder 本身即跨文档，无需再给 allDocs。有哪些文件夹用 library_index（导航虚拟文档）查。'),
      excludeFolder: z.string().optional().describe('从跨文档检索中排除这些 library 文件夹子树（逗号分隔多个）；可单独用（= 整库减去这些子树）。文件夹路径同样用 library_index 查。'),
      labels: z.boolean().optional().describe('true 时命中按文档标层级(事件卷/核心记忆/知识)、按节点标信任(受控/不受控/null=导入未标注，按不受控对待)，便于分层分信任挑候选；默认 false 不输出这些以保持精简。'),
      uuid: z.boolean().optional().describe('true 时命中行显示 doc:UUID；默认 false，显示文档标签。'),
      includeHidden: z.boolean().optional().describe('默认 false：跨文档检索排除 . 开头隐藏路径文件夹（如事件卷锚所在的 .memory）；true 时把隐藏路径一并纳入。'),
      minScore: z.number().optional().describe('过滤阈值（高级搜索）：语义检索按相似度下限，默认 0.51（过滤 sim < 0.51 的弱相关）；字面检索按命中次数下限（hit < 阈值则过滤），默认不限。')
    }
  }, async ({ terms, query, semantic, tags, docId, allDocs, scopeAddress, limit, matchMode, workspace, agent, kind, trust, since, until, at, folder, excludeFolder, labels, uuid, includeHidden, minScore } = /** @type {{ terms?: string[], query?: string, semantic?: boolean, tags?: boolean, docId?: DocId, allDocs?: boolean, scopeAddress?: string, limit?: number, matchMode?: string, workspace?: string, agent?: string, kind?: string, trust?: string, since?: string, until?: string, at?: DocId | string, folder?: string, excludeFolder?: string, labels?: boolean, uuid?: boolean, includeHidden?: boolean, minScore?: number }} */ ({})) => {
    const folderScope = Boolean(folder) || Boolean(excludeFolder);
    if (docId && allDocs) return textResult('docId 和 allDocs 只能二选一。');
    if (docId && folderScope) return textResult('docId 与 folder/excludeFolder 不能同用（folder 已是跨文档范围）。');
    if (!docId && !allDocs && !folderScope) {
      return textResult(tags
        ? '请给 docId 限定单篇，或用 allDocs / folder 跨文档检索。tags（实体相关词）按文档存储，同样要先圈定范围。'
        : '请给 docId 限定单篇，或用 allDocs / folder 跨文档检索。');
    }
    if (scopeAddress && !docId) return textResult('scopeAddress 需要同时给 docId。');
    if (semantic && tags) return textResult('semantic 和 tags 不能同时为 true。');
    if (semantic && folderScope) return textResult('folder/excludeFolder 暂只支持字面检索，不支持 semantic（与 workspace/kind 一致，语义范围过滤待接入）。');

    const argv = ['find'];
    if (semantic) argv.push('--semantic');
    if (tags) argv.push('--tags');
    if (allDocs || folderScope) argv.push('--all-docs');
    if (folder) argv.push('--folder', String(folder));
    if (excludeFolder) argv.push('--exclude-folder', String(excludeFolder));
    if (scopeAddress) argv.push('--scope', String(docId), scopeAddress);
    if (limit) argv.push('--limit', String(limit));
    if (minScore !== undefined) argv.push('--min-score', String(minScore));
    if (at !== undefined) argv.push('--at', String(at));
    if (matchMode) argv.push('--match-mode', String(matchMode));
    if (workspace) argv.push('--workspace', String(workspace));
    if (agent) argv.push('--agent', String(agent));
    if (kind) argv.push('--kind', String(kind));
    if (trust) argv.push('--trust', String(trust));
    if (since) argv.push('--since', String(since));
    if (until) argv.push('--until', String(until));
    if (labels) argv.push('--labels');
    if (uuid) argv.push('--uuid');
    if (includeHidden) argv.push('--include-hidden');
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
      return textResult((await dbShell(client, argv, allDocs || folderScope || scopeAddress ? undefined : docId)) || '(无命中)');
    } catch (error) {
      return textResult(`find 当前不能执行：${error?.message || error}\n降级：用 find 的 terms 字面检索 + tree 结构定位。`);
    }
  });

  server.registerTool('log', {
    description: '列出文档或某节点/子树的提交历史。不给 address 即整篇文档的 commit 史；给 address（如 1-3-2）则按 git log <path> 语义，只列该地址的整棵子树（node=true 时只看本节点）被改动过的 commit，按稳定 id 追（节点换过地址也连得上）。每行含 commit id（可喂给 diff/read --at/restore）、时间、@author、摘要。',
    inputSchema: {
      docId: docIdSchema.describe('已导入文档的 doc id。'),
      address: z.string().optional().describe('可选节点地址（如 1-3-2）；给了即节点级 log，默认看整棵子树。'),
      nodeId: docIdSchema.optional().describe('可选节点稳定 UUID：兼容定位入口，给了即节点级 log（优先于 address）。'),
      node: z.boolean().optional().describe('true 时只看该地址节点自身、不含子树（需配合 address）。'),
      limit: z.number().int().positive().optional()
    }
  }, async ({ docId, address, node, limit, nodeId }) => {
    const argv = ['log', String(docId)];
    if (address) argv.push(String(address));
    if (nodeId) argv.push('--node-id', String(nodeId));
    if (node) argv.push('--node');
    if (limit) argv.push('--limit', String(limit));
    return textResult((await dbShell(client, argv)) || '(无历史)');
  });

  server.registerTool('diff', {
    description: '对比草稿与正文，或两版保存历史。不给 historyId 时对比「草稿↔正文」：给 branchId/baseDocId/shadowDocId 指定草稿，否则用 switch 选中的草稿（原 changes / changes --detail 已并入此态）。给 docId + toHistoryId（可选 fromHistoryId）则对比两版历史。两个正交参数：detail 切粒度（summary 节点+计数 / full 逐行 old→new，默认 full），json 切格式（true 出结构化 entries）。计数为正文↔草稿最终态的按节点净效果（等价来回的中间动作会被压平、一次 split 计为净增节点数），与 edit 返回的逐动作累加计数口径不同、数值可能不等。',
    inputSchema: {
      docId: docIdSchema.optional(),
      fromHistoryId: docIdSchema.optional(),
      toHistoryId: docIdSchema.optional(),
      historyId: docIdSchema.optional(),
      branchId: z.number().int().positive().optional(),
      shadowDocId: docIdSchema.optional(),
      baseDocId: docIdSchema.optional(),
      owner: ownerSchema.optional(),
      detail: z.enum(['summary', 'full']).optional().describe('文本粒度：summary（节点列表+改增删移计数、不出正文）/ full（逐行 old→new）；默认 full。'),
      json: z.boolean().optional().describe('true 时返回结构化 entries（含 fields old/new、createdAt 等）；与 detail 正交——json 管格式、detail 管文本粒度。'),
      from: z.string().optional().describe('refA↔refB 比对左端：head（正文，默认 from）/ <commitId>（历史）/ draft 或 draft:<branchId>（草稿）。给 from 或 to 即走通用 ref 比对。'),
      to: z.string().optional().describe('比对右端：取值同 from。只给 from 时对端默认 head 正文；from/to 都不传则整体走草稿↔正文。')
    }
  }, async ({ docId, fromHistoryId, toHistoryId, historyId, branchId, shadowDocId, baseDocId, owner, json, detail, from, to } = /** @type {BranchTargetArgs & { docId?: DocId, fromHistoryId?: DocId, toHistoryId?: DocId, historyId?: DocId, json?: boolean, detail?: 'summary' | 'full', from?: string, to?: string }} */ ({})) => {
    // refA↔refB（15-5-2）：给了 from/to 即走通用 diff.refs；只给一端时另一端默认 head 正文（都不给则走下面的草稿↔正文）。
    if (from !== undefined || to !== undefined) {
      const draftRef = () => ({ branchId: branchId ?? selectedBranch.branchId ?? undefined, baseDocId: baseDocId ?? selectedBranch.baseDocId ?? undefined, owner: owner ?? selectedBranch.owner ?? DEFAULT_WRITE_OWNER });
      const headRef = { head: true, docId };
      const fromGiven = from !== undefined;
      const toGiven = to !== undefined;
      const payload = {
        action: 'diff.refs',
        from: fromGiven ? parseDiffRef(from, { docId, draftRef }) : headRef,
        to: toGiven ? parseDiffRef(to, { docId, draftRef }) : (fromGiven ? headRef : draftRef())
      };
      if (docId !== undefined) payload.docId = docId;
      const res = await client.databaseRead(payload);
      return json ? jsonTextResult(slimDiffView(res)) : textResult(formatDiffText(res, { detail }));
    }
    // 历史两版优先：给了 docId + historyId 即比历史，不抢草稿态。
    const targetHistoryId = toHistoryId ?? historyId;
    if (docId && targetHistoryId) {
      const payload = { action: 'history.diff', docId, toHistoryId: targetHistoryId };
      if (fromHistoryId) payload.fromHistoryId = fromHistoryId;
      const res = await client.databaseRead(payload);
      return json ? jsonTextResult(slimDiffView(res)) : textResult(formatDiffText(res, { detail }));
    }
    // 草稿↔正文：显式目标或 switch 选中的草稿（草稿按 branchId 唯一定位，owner 仅 baseDocId 场景消歧、缺省兜档位默认）。
    const tgtBranchId = branchId ?? selectedBranch.branchId ?? undefined;
    const tgtBaseDocId = baseDocId ?? selectedBranch.baseDocId ?? undefined;
    if (tgtBranchId === undefined && shadowDocId === undefined && tgtBaseDocId === undefined) {
      return textResult('diff 需要 docId + toHistoryId/historyId（两版历史），或 branchId/baseDocId/shadowDocId（草稿↔正文），或先 switch 到一个草稿。');
    }
    const payload = { action: 'editBranch.diffView', changedOnly: true };
    if (tgtBranchId !== undefined) payload.branchId = tgtBranchId;
    if (shadowDocId !== undefined) payload.shadowDocId = shadowDocId;
    if (tgtBaseDocId !== undefined) payload.baseDocId = tgtBaseDocId;
    payload.owner = owner ?? selectedBranch.owner ?? DEFAULT_WRITE_OWNER;
    const res = await client.databaseRead(payload);
    return json ? jsonTextResult(slimDiffView(res)) : textResult(formatDiffText(res, { detail }));
  });

  server.registerTool('sql', {
    description: '只读 SQL 调试查询。只允许 SELECT/WITH，后端用 SQLite readonly 校验；用于核对数据库事实，不写入。'
      + ' 核心表(主键/常用列)：'
      + 'docs(id 主键=文档UUID, title, meta JSON含semantic状态, folder_id, edit_mode, updated_at)；'
      + 'nodes(id 主键=节点UUID, doc_id 外键, parent_id, address, node_type, text 正文, node_title, node_note, trust_level=受控|不受控, content_hash, subtree_hash, updated_at)；'
      + 'source_documents(doc_id 主键且=外键, source_type, original_path, raw_markdown；注意无 id 列)；'
      + 'doc_folders(id 主键 INTEGER, parent_id, name)；'
      + 'axioms(id 主键, doc_id, label, content, status)；'
      + 'refs(id 主键, source_type/source_id, target_type/target_id, ref_kind)；'
      + 'commits(id 主键=commitUUID, doc_id, parent_commit_id, committed_at, summary, snapshot JSON)；doc_heads(doc_id 主键, head_commit_id 指向当前)；'
      + 'edit_branches(id 主键 INTEGER, base_doc_id, shadow_doc_id, owner, status)；'
      + 'entities(id 主键, doc_id, literal, normalized_literal) / entity_links / entity_node_bindings。'
      + ' 速记：文档=docs.id、节点正文=nodes.text；docs/nodes/commits 主键叫 id，source_documents 主键叫 doc_id。',
    inputSchema: {
      sql: z.string().describe('SELECT 或 WITH 开头的只读 SQL。'),
      params: z.union([z.array(z.any()), z.record(z.string(), z.any())]).optional().describe('可选 SQL 参数；数组对应 ? 参数，对象对应 @name 参数。'),
      limit: z.number().int().positive().optional().describe('可选返回行数上限；后端会限制最大值。'),
      json: z.boolean().optional().describe('true 时返回原始 JSON（行数组）；默认按行渲染紧凑文本。')
    }
  }, async ({ sql, params, limit, json }) => {
    const payload = { action: 'debug.sql', sql };
    if (params !== undefined) payload.params = params;
    if (limit !== undefined) payload.limit = limit;
    const res = await client.databaseRead(payload);
    return json ? jsonTextResult(res) : textResult(formatSqlResult(res));
  });

  server.registerTool('article', {
    description: '读取导入文档的原文窗口。以锚点（startOffset 或 nodeId，都不给则文档开头）为基准取总长 limit 的窗口（默认 5000、上限 50000）。往前/往后自动分配：往前=min(⌊limit/5⌋,1000)、其余归往后（limit≤5000 时前后 1:4，更大时往前封顶 1000）；撞原文开头把往前余量并入往后、撞结尾则往前不补。触及原文首/尾时文本带 [原文开始]/[原文结束] 标记以区分自然到底与截断。可附 source spans。',
    inputSchema: {
      docId: docIdSchema.describe('已导入文档的 doc id。'),
      nodeId: docIdSchema.optional().describe('可选锚点节点 id；从该节点对应的原文位置取窗口。'),
      startOffset: z.number().int().nonnegative().optional().describe('可选原文锚点偏移；以它为中心取总长 limit 的窗口。不提供时用 nodeId 或文档开头。'),
      limit: z.number().int().positive().optional().describe('可选总窗口字符数；默认 5000，上限 50000（超过即报错，不静默截断）。'),
      before: z.number().int().nonnegative().optional().describe('可选往前字符数；不传按 min(⌊limit/5⌋,1000) 自动分配、传了覆盖；上限 50000（超过即报错）。'),
      spansLimit: z.number().int().positive().optional().describe('可选 source span 返回数量上限；默认 30。截断时文本模式标「窗口共 N」、json 模式给 spansTotal。'),
      includeSpans: z.boolean().optional().describe('true 时附 source spans（文本模式为紧凑行，json 模式为结构化数组）；默认只返回窗口和文本。'),
      json: z.boolean().optional().describe('true 时返回原始结构化 JSON（window 对象 + 完整 sourceSpans）；默认返回文本（窗口头一行 + 原文 + 可选紧凑 spans 行）。')
    }
  }, async ({ docId, nodeId, startOffset, limit, before, spansLimit, includeSpans, json }) => {
    const argv = ['article', String(docId)];
    if (nodeId !== undefined) argv.push('--node-id', String(nodeId));
    if (startOffset !== undefined) argv.push('--start', String(startOffset));
    if (before !== undefined) argv.push('--before', String(before));
    if (limit !== undefined) argv.push('--limit', String(limit));
    if (spansLimit !== undefined) argv.push('--spans-limit', String(spansLimit));
    if (includeSpans) argv.push('--spans');
    if (json) argv.push('--json');
    return textResult(await dbShell(client, argv));
  });

  server.registerTool('memory_volumes', {
    description: '列出完整记忆的 session 卷及状态（projectneed 15-10）。状态由时间戳推导：active（活跃）→ sealed（末次活动+24h 视为收尾，冷却中）→ distillable（再+24h 可提炼）→ distilled（已提炼）。返回每卷的 agent 身份、session id、起止时间、末次活动时间等时间元数据；采信任何卷内容前先看时间（15-12-6）。卷正文用 tree/read 按 docId 下钻（查过往）。',
    inputSchema: {
      state: z.enum(['active', 'sealed', 'distillable', 'distilled']).optional().describe('可选状态过滤。'),
      agent: z.string().optional().describe('可选 agent 身份过滤。'),
      sessionId: z.string().optional().describe('可选 session id 过滤。'),
      limit: z.number().int().positive().optional().describe('可选返回数量上限；默认最新 5 卷（按建卷时间倒序，最新在前）。要看更早的卷请显式调大 limit。'),
      json: z.boolean().optional().describe('true 时返回原始 JSON（卷数组）；默认每卷一行渲染。')
    }
  }, async ({ state, agent, sessionId, limit, json } = /** @type {{ state?: string, agent?: string, sessionId?: string, limit?: number, json?: boolean }} */ ({})) => {
    const payload = { action: 'memory.listVolumes' };
    if (state !== undefined) payload.state = state;
    if (agent !== undefined) payload.agent = agent;
    if (sessionId !== undefined) payload.sessionId = sessionId;
    if (limit !== undefined) payload.limit = limit;
    const res = await client.databaseRead(payload);
    return json ? jsonTextResult(res) : textResult(formatVolumeList(res));
  });
}

export function registerAgentTools(server, client, tier = TIER) {
  // A2A 委托内置 agent 的入口按档位化（projectneed 18-1）：ask_agent 恒 qa（read 档·只读问答），
  // edit_agent（edit 档）/admin_agent（full 档）委托更高能力；委托权限不超过调用方自身档位，
  // 按档位注册不同动词、不在单一动词内按档位切 mode。
  const isWriteTier = tier === 'edit' || tier === 'full' || tier === 'human';
  const isFullTier = tier === 'full' || tier === 'human';
  const registerAgentDelegate = (name, mode, description) => {
    server.registerTool(name, {
      description,
      inputSchema: { prompt: z.string(), docId: docIdSchema.optional(), sessionId: z.number().int().positive().optional() }
    }, async ({ prompt, docId, sessionId }, extra) => {
      const payload = { mode, prompt };
      if (docId) payload.docId = docId;
      if (sessionId) payload.sessionId = sessionId;
      // 委托内置 agent 是长任务（检索+多轮推理），单次回包前默认无声 → 调用方 MCP 客户端会 -32001 超时。
      // 跑期间周期发 progress 通知保活（仅在调用方请求带 progressToken + resetTimeoutOnProgress 时生效）。
      const progressToken = extra?._meta?.progressToken;
      let keepAlive = null;
      if (progressToken != null && typeof extra?.sendNotification === 'function') {
        let ticks = 0;
        keepAlive = setInterval(() => {
          extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken, progress: (ticks += 1), message: `${name} 运行中…` }
          }).catch(() => { /* 通知失败不影响主流程 */ });
        }, 20000);
        if (typeof keepAlive?.unref === 'function') keepAlive.unref();
      }
      try {
        const result = await client.runAgent(payload);
        const answer = result?.answer || result?.error || '(无回答)';
        const sid = result?.sessionId != null ? `\n\n[sessionId: ${result.sessionId}]` : '';
        return textResult(`${answer}${sid}`);
      } finally {
        if (keepAlive) clearInterval(keepAlive);
      }
    });
  };
  registerAgentDelegate('ask_agent', 'qa',
    '直接问本产品的内置文档智能体（A2A，read 档·只读问答，恒 qa 不随档提权）。它会按检索纪律自己查文档、读正文、附证据节点再回答。docId 指定当前文档；sessionId 用于多轮续接（把上轮返回的 sessionId 传回来）。');
  if (isWriteTier) registerAgentDelegate('edit_agent', 'edit',
    'edit/full/human 档可见：委托内置 agent 以 edit 能力代劳——它可提议编辑，提议落 owner=llm:<会话> 待审草稿，再用 draft list/merge/discard 审批。多轮/证据纪律同 ask_agent。');
  if (isFullTier) registerAgentDelegate('admin_agent', 'full',
    'full/human 档可见：委托内置 agent 以 full 能力运维——在 edit 提议之外还可做历史改写、流式、索引补建等运维。多轮/证据纪律同 ask_agent。');
}

function registerLifecycleTools(server, client) {
  server.registerTool('restart_backend', {
    description: 'full 档运维：强制重启共享后端。先优雅关停、再按 pid 强杀兜底——确保被其他客户端（opencode/codex 等）续住的旧后端也被杀掉，下次工具调用拉起最新源码实例。会中断其余客户端正在进行的后端操作（它们下次调用自会重连/重拉）。改了 MCP server 自身仍需调用方重连 MCP。'
  }, async () => {
    // pid 取自当前连接的 ready 帧；本进程还没连过后端时（client.pid 为 null）回退描述文件——
    // 别的客户端/GUI 续住的游离共享后端 pid 一直记在那里，否则首调会误判「未启动」而漏杀。
    const pid = client.sharedBackendPid;
    try {
      await client.shutdown();
    } catch { /* 后端可能已在退出 */ }
    client.close();
    // 强杀兜底（该杀就杀）：优雅 shutdown 会因 socket 已断、shutdown 请求被其他客户端的长操作阻塞在
    // 队列、或共享后端被别的客户端续住而漏杀。restart_backend 是运维动词、语义就是「保证下次拉起最新
    // 实例」，故按 pid 强制终止共享后端进程（pid 见上：当前连接或描述文件，均为后端进程、非本 mcp-server）。
    // SQLite(WAL)/LanceDB(版本化提交) 均崩溃安全，强杀不致损坏；残留连接描述文件下次发现失败即重写。
    let forced = false;
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 'SIGKILL'); forced = true; } catch { /* 已退出 / 无权限 */ }
    }
    const target = pid ? `pid=${pid}${forced ? '（已强制终止）' : '（已优雅关停）'}` : '当前未启动';
    return textResult(`已关闭后端（${target}）。下一次 MCP 工具调用会拉起最新实例；若更新了 MCP server 自身，请重连 MCP。`);
  });
}

// Progressive tier (projectneed `18-3`): read = read tools only; edit adds
// import/delete plus review of proposed changes; full adds accepting + saving.
export function registerWriteTools(server, client, tier) {
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
    owner: owner ?? selectedBranch.owner ?? DEFAULT_WRITE_OWNER
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

  const importLibraryDocument = async ({ relativePath, mode, embed, vectors }) => {
    // vectors 是 push 的内联向量口径、不是 import 的开关——传错直接回报错，别静默不建。
    if (vectors !== undefined) return textResult('import 不接受 vectors 参数；导入时同步建向量用 embed:true（vectors 是 push 的内联向量口径）。');
    const res = await client.importLibraryDocument({ relativePath, mode, embed });
    if (!res?.ok) return textResult(`导入失败：${JSON.stringify(res)}`);
    const lines = [`已导入 ${res.relativePath || relativePath}`, `#${res.docId} ${res.title || ''}`, `节点数：${res.nodeCount || 0}`];
    if (embed === true) lines.push(res.vectorWarning ? `向量：同步建立失败（${res.vectorWarning}）` : '向量：已同步建立');
    else lines.push('向量：未建（默认后补；需即时可检索传 embed:true，或用 vectors 动词）');
    return textResult(lines.join('\n'));
  };

  const ensureVectors = async ({ docId }) => {
    const res = await client.ensureDocVectors({ docId });
    if (!res || res.ok === false) return textResult(formatWriteResult(res, { label: 'vectors' }));
    if (res.skipped) return textResult(`vectors  doc:${res.docId || docId}  跳过（${res.reason || '向量未启用'}）`);
    const after = Number(res.vectorCountAfter) || 0;
    const before = Number(res.vectorCountBefore) || 0;
    const nodeCount = res.nodeCount ?? null;
    const coverage = nodeCount ? `${after}/${nodeCount}（覆盖 ${Math.round((after / nodeCount) * 100)}%）` : `${after}`;
    return textResult([
      `vectors  doc:${res.docId || docId}  向量 ${coverage}`,
      `  新增 ${res.missingInserted ?? 0} · 重嵌 ${res.changedDeleted ?? 0} · 清理孤儿 ${res.staleDeleted ?? 0} · 既有保留 ${res.existingCurrent ?? 0}（before ${before}→after ${after}）`
    ].join('\n'));
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
    const res = await client.databaseWrite(payload);
    return textResult(formatWriteResult(res, { label: 'commit' }));
  };

  const discardChange = async (input = {}) => {
    const { branchId, shadowDocId, baseDocId, owner } = branchTarget(input);
    if (branchId === undefined && shadowDocId === undefined && baseDocId === undefined) {
      return textResult('discard 需要 branchId/baseDocId/shadowDocId。');
    }
    const payload = { action: 'editBranch.discard', includeDoc: false };
    if (branchId !== undefined) payload.branchId = branchId;
    if (shadowDocId !== undefined) payload.shadowDocId = shadowDocId;
    if (baseDocId !== undefined) payload.baseDocId = baseDocId;
    if (owner) payload.owner = owner;
    const res = await client.databaseWrite(payload);
    return textResult(formatWriteResult(res, { label: 'discard' }));
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
    const res = await client.databaseWrite(payload);
    return textResult(formatWriteResult(res, { label: action }));
  };

  server.registerTool('edit', {
    description: `edit/full/human 档可见：把一条编辑动作写入当前草稿；owner 默认取档位（edit/full 档为 llm、human 档为 human），不直接改主库。action 使用现有 node/axiom/ref/entity 写动作。${nodeTypeContractText}`,
    inputSchema: {
      action: z.enum([
        'node.update',
        'node.insert',
        'node.delete',
        'node.move',
        'node.promote',
        'node.split',
        'node.mergeInto',
        'node.mergePrevious',
        'node.reparent',
        'node.moveAfter',
        'node.moveBefore',
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
      nodeId: docIdSchema.optional().describe('目标节点 id：node.update/delete/move/reparent/moveAfter/moveBefore/promote/split 的目标；node.mergeInto 的源节点（合并进 targetNodeId）。'),
      text: z.string().optional().describe('正文：node.update 改正文 / node.insert 新节点正文。'),
      nodeType: z.string().optional().describe(`节点类型：node.update/insert。${nodeTypeContractText}`),
      nodeTitle: z.string().optional().describe('节点标题：node.update/insert。'),
      nodeNote: z.string().optional().describe('节点备注：node.update/insert。'),
      parentId: docIdSchema.optional().describe('父节点 id：node.reparent 新父；node.insert 仅在插为首个子节点/空父下时需要（给了 afterNodeId 则父从锚点自动推断、不必再给）。'),
      afterNodeId: docIdSchema.optional().describe('锚点节点 id：node.insert 插其后（父从锚点自动推断，无需 parentId）/ node.moveAfter 移到其后。'),
      targetNodeId: docIdSchema.optional().describe('目标节点 id：node.moveAfter 移到其后 / node.moveBefore 移到其前 / node.mergeInto 合并进的目标节点（afterNodeId 会兜底映射到它）。'),
      direction: z.enum(['up', 'down']).optional().describe('node.move 方向。'),
      splitAsciiPunctuation: z.boolean().optional().describe('node.split: enable ASCII .!? sentence splitting; default false for Chinese documents.'),
      payload: z.record(z.string(), z.any()).optional().describe(`兜底参数：仅 axiom/ref/entity 等低频动作、或上面未覆盖的字段才需要；高频 node 操作用上面的具名字段、不必手写 payload（不裸 json，见 15-5-2）。低频动作字段（统一推荐驼峰；docId 一律走顶层 baseDocId）：axiom.add{content,status?,nodeTitle?,nodeNote?} / axiom.update{axiomId,content?,status?} / axiom.delete{axiomId} / axiom.move{axiomId,direction}；ref.addNodeToNode{sourceNodeId,targetNodeId,refKind,note?} / ref.addAxiomToNode{nodeId,axiomId,note?} / ref.delete{refId}；entity.create{literal} / entity.update{entityId,literal} / entity.delete{entityId} / entity.link|unlink{sourceEntityId,targetEntityId,kind:synonym|related} / entity.bindNode|ignoreNode|clearNodeBinding{entityId,nodeId}。${nodeTypeContractText}`),
      owner: ownerSchema.optional().describe('写入者身份；缺省取档位默认（非 human 档不接受 owner=human，18-3 运行中不升档）。'),
      baseDocId: docIdSchema.optional().describe('目标文档 id：node/axiom/ref/entity 各动作均认（顶层给即可，进编辑分支后作 docId 真相）。动作参数能推出 docId（带 nodeId/entityId/axiomId/refId 反查）时可省。'),
      branchId: z.number().int().positive().optional().describe('目标草稿 branchId：多草稿并存时精确指定写哪个分支；省略则用 switch 选中的草稿，再退回 (baseDocId, owner) 定位。')
    }
  }, async ({ action, nodeId, text, nodeType, nodeTitle, nodeNote, parentId, afterNodeId, targetNodeId, direction, splitAsciiPunctuation, payload = {}, owner, baseDocId, branchId }) => {
    const resolved = resolveWriteOwner(owner);
    if (resolved.error) return textResult(resolved.error);
    // 具名字段合入 payload：高频 node 操作无需手写 payload（不裸 json，见 15-5-2）；payload 仅兜底 axiom/ref/entity 等低频动作。
    const named = { nodeId, text, nodeType, nodeTitle, nodeNote, parentId, afterNodeId, targetNodeId, direction, splitAsciiPunctuation };
    const writePayload = /** @type {Record<string, any>} */ ({ ...payload });
    for (const [key, value] of Object.entries(named)) {
      if (value !== undefined) writePayload[key] = value;
    }
    if (action === 'node.reparent'
      && writePayload.parentId !== undefined
      && writePayload.newParentId === undefined
      && writePayload.new_parent_id === undefined) {
      writePayload.newParentId = writePayload.parentId;
    }
    if ((action === 'node.moveAfter' || action === 'node.moveBefore' || action === 'node.mergeInto')
      && writePayload.afterNodeId !== undefined
      && writePayload.targetNodeId === undefined
      && writePayload.target_node_id === undefined) {
      writePayload.targetNodeId = writePayload.afterNodeId;
    }
    writePayload.action = action;
    writePayload.editBranchOwner = resolved.owner;
    // 草稿定位优先级：显式 branchId > switch 选中的 branchId；baseDocId 同理回退 switch 选中，多草稿并存时精确路由（不再只靠 (baseDocId, owner)）。
    const targetBranchId = branchId ?? selectedBranch.branchId ?? undefined;
    if (targetBranchId !== undefined) writePayload.editBranchId = targetBranchId;
    const targetBaseDocId = baseDocId ?? selectedBranch.baseDocId ?? undefined;
    if (targetBaseDocId !== undefined) writePayload.editBranchBaseDocId = targetBaseDocId;
    const res = await client.databaseWrite(writePayload);
    return textResult(formatWriteResult(res));
  });

  server.registerTool('draft', {
    description: 'edit/full/human 档可见：草稿管理。new 起草（挂某文档，owner 取档位身份）——默认复用当前身份下最新草稿，fresh:true 才另起一份新草稿；list 列当前草稿及署名（可按 docId 过滤）。对比走 diff、弃稿走 discard、落正文走 commit/merge。',
    inputSchema: {
      action: z.enum(['new', 'list']),
      docId: docIdSchema.optional(),
      owner: ownerSchema.optional(),
      fresh: z.boolean().optional().describe('draft new：true 时强制另起一份新草稿，不复用当前身份下已有的最新草稿。')
    }
  }, async ({ action, docId, owner, fresh } = /** @type {{ action?: string, docId?: DocId, owner?: string, fresh?: boolean }} */ ({})) => {
    if (action === 'list') {
      const res = await client.databaseRead({ action: 'editBranch.listPending', ...(owner ? { owner } : {}) });
      const branches = (res?.branches || []).filter((branch) => (
        docId ? String(branch.base_doc_id) === String(docId) : true
      ));
      return textResult(branches.map((b) => formatBranchLine(b, { current: selectedBranch.branchId })).join('\n') || '(无草稿)');
    }
    if (action === 'new') {
      if (!docId) return textResult('draft new 需要 docId。');
      const resolved = resolveWriteOwner(owner);
      if (resolved.error) return textResult(resolved.error);
      const payload = { action: 'editBranch.begin', docId, includeDoc: false, owner: resolved.owner, fresh: fresh === true };
      const res = await client.databaseWrite(payload);
      return textResult(formatWriteResult(res, { label: 'draft' }));
    }
    return textResult(`未知 draft action: ${action}`);
  });

  server.registerTool('commit', {
    description: 'edit/full/human 档可见：定稿——把当前草稿生效 diff 写入正文历史并销稿。不带裁决：快进直落；非快进逐条前置验证账目，结构性失配返回 blocked（正文已被修改，只能 discard 弃稿），字段级冲突返回 conflicts 待裁清单、不落——要带裁决落库改走 merge（strategy/resolutions）。',
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
    description: 'edit/full/human 档可见：按 A5-10 把草稿调和落正文。默认只预览三方分类（fastForward、hasConflicts、逐节点 resolution 与扁平 conflicts，按稳定 node id 调和、不按地址）。yes=true 执行：快进直接写回；非快进逐条前置验证（乐观并发，O(改动数) 点查），结构性失配（正文删了被改/被挂载的节点、并发移动、拆分/并入的内容漂移）返回 blocked；字段级冲突按裁决折叠——strategy=ours/theirs 整批取正文侧/草稿侧，或 resolutions 逐条裁决 [{id,field,pick:ours|theirs|fill,value?}]；不给裁决撞冲突则返回 conflicts 待裁清单、不落。冲突与受阻时正文与草稿均不动。',
    inputSchema: {
      branchId: z.number().int().positive().optional(),
      shadowDocId: docIdSchema.optional(),
      baseDocId: docIdSchema.optional(),
      owner: ownerSchema.optional(),
      summary: z.string().optional(),
      strategy: z.enum(['ours', 'theirs']).optional().describe('整批裁决：撞字段冲突一律取正文侧(ours)/草稿侧(theirs)，对应 git -X。'),
      resolutions: z.array(z.object({
        id: docIdSchema,
        field: z.string(),
        pick: z.enum(['ours', 'theirs', 'fill']),
        value: z.string().optional()
      })).optional().describe('逐条裁决；pick=fill 时须给 value。与 strategy 同给以 resolutions 为准。'),
      yes: z.boolean().optional(),
      json: z.boolean().optional().describe('true 时返回结构化三方分类（逐节点 resolution 数组）；默认精简文本——折叠未改、只列裁决与冲突。')
    }
  }, async ({ yes, summary, strategy, resolutions, json, ...rest } = /** @type {BranchTargetArgs & { summary?: string, strategy?: string, resolutions?: any[], yes?: boolean, json?: boolean }} */ ({})) => {
    const target = branchTarget(rest);
    if (!hasBranchTarget(target)) return textResult('merge 需要 branchId/baseDocId/shadowDocId，或先 switch 到一个草稿。');
    const payload = yes
      ? { action: 'editBranch.applyMerge', includeDoc: false }
      : { action: 'editBranch.threeWayMerge' };
    if (target.branchId !== undefined) payload.branchId = target.branchId;
    if (target.shadowDocId !== undefined) payload.shadowDocId = target.shadowDocId;
    if (target.baseDocId !== undefined) payload.baseDocId = target.baseDocId;
    if (target.owner) payload.owner = target.owner;
    if (yes && summary) payload.summary = summary;
    if (yes && Array.isArray(resolutions) && resolutions.length > 0) payload.resolutions = resolutions;
    else if (yes && strategy) payload.strategy = strategy;
    const res = yes ? await client.databaseWrite(payload) : await client.databaseRead(payload);
    if (yes) return json ? jsonTextResult(slimWriteResult(res)) : textResult(formatWriteResult(res, { label: 'merge' }));
    return json ? jsonTextResult(res) : textResult(formatThreeWayMergeText(res));
  });

  server.registerTool('switch', {
    description: 'edit/full/human 档可见：切换当前草稿选择（进程内）。后续 edit/diff/commit/discard/undo/redo/merge/rebase/cherry-pick 未显式传目标时使用该选择。',
    inputSchema: { branchId: z.number().int().positive().optional(), baseDocId: docIdSchema.optional(), owner: ownerSchema.optional() }
  }, async ({ branchId, baseDocId, owner } = /** @type {{ branchId?: number, baseDocId?: DocId, owner?: string }} */ ({})) => {
    if (branchId === undefined && baseDocId === undefined) {
      return textResult(selectedBranch.branchId || selectedBranch.baseDocId
        ? formatWriteResult(selectedBranch, { label: 'switch' })
        : '(未选择草稿)');
    }
    if (branchId !== undefined || baseDocId !== undefined) {
      const payload = { action: 'editBranch.diffView', changedOnly: true };
      if (branchId !== undefined) payload.branchId = branchId;
      if (baseDocId !== undefined) payload.baseDocId = baseDocId;
      payload.owner = owner ?? DEFAULT_WRITE_OWNER; // 同上：缺省兜档位默认，避免 switch 校验阶段被 owner 挡死
      await client.databaseRead(payload);
    }
    return textResult(formatWriteResult(setSelectedBranch({ branchId, baseDocId, owner }), { label: 'switch' }));
  });

  server.registerTool('import', {
    description: 'edit/full/human 档可见：导入 library 内真实文件。mode 默认 simple：simple=按标题/段落切树，但结构不达标（无标题/层级过浅/只有单一顶层标题）且文档≤1000字时自动退化为整篇单节点（回执会提示退化原因）、超1000字则报错让你改 direct；complete=按句子细切；direct=整篇不切、单节点；smart/vector 暂未接入。embed=true 导入后同步建向量（吃性能），默认不建、留待后补。',
    inputSchema: {
      relativePath: z.string().describe('library 内相对路径，不要使用绝对路径。'),
      mode: z.enum(['simple', 'complete', 'direct', 'smart', 'vector']).optional(),
      embed: z.boolean().optional().describe('导入后是否同步建立向量（吃性能）。默认 false=后补；true=当场 embed。与 mode 切分方式正交。')
    }
  }, importLibraryDocument);

  server.registerTool('delete', {
    description: 'edit/full/human 档可见：删除已导入文档的 doc 数据，不删除 library 真实文件（`18-3-1`：与 import 成对）。`forget` 一词留给记忆系统的"遗忘记忆"。',
    inputSchema: { docId: docIdSchema }
  }, async ({ docId }) => {
    const res = await client.deleteImportedDocument({ docId });
    if (!res?.ok) return textResult(`删除失败：${JSON.stringify(res)}`);
    return textResult(`${res.changed ? '已删除' : '未找到'} doc ${docId}${res.title ? `「${res.title}」` : ''}`);
  });

  server.registerTool('memory_deliver', {
    description: 'edit/full/human 档可见：事件卷投递（projectneed 18-8-4）——把这个 session 的宿主记录导入成事件卷。你不复述、不整理：系统读 hostAnchor 指向的真实 session 文件、纯规则解析成卷（确定可重复），所以你只需给 agent + sessionId + hostAnchor。一 session 一卷：同 agent+sessionId 重投 = 旧卷全删 + 完整重导（session 只追加 + 解析确定，重导 ≡ 追加）。无真实源文件就拒投、不建空卷。节点一律 trust_level=不受控（15-10-3）。卷落库后按 24h 节律自动封卷/进入可提炼（15-11-5）。',
    inputSchema: {
      agent: z.string().describe('agent 身份标识，如 claude-code、codex。'),
      sessionId: z.string().describe('宿主侧 session id。'),
      hostAnchor: z.string().describe('宿主 session 文件锚（路径#sessionid）：必填，指向你这个 session 的真实 transcript 文件；系统读它解析成卷，文件不存在/解析不出对话即拒（15-10-4）。'),
      title: z.string().optional().describe('卷标题；省略时按 agent+日期+session 生成。'),
      startedAt: z.string().optional().describe('会话起始时间 ISO 8601。'),
      endedAt: z.string().optional().describe('会话结束时间 ISO 8601。'),
      idempotencyKey: z.string().optional().describe('请求级防抖键：只抵消同一次请求的网络重试（省去无谓的重复重导），非内容去重；同 session 重投本就由 session 身份去重，不靠此键。')
    }
  }, async ({ agent, sessionId, hostAnchor, title, startedAt, endedAt, idempotencyKey } = /** @type {{ agent?: string, sessionId?: string, hostAnchor?: string, title?: string, startedAt?: string, endedAt?: string, idempotencyKey?: string }} */ ({})) => {
    const payload = { action: 'memory.deliverVolume', agent, sessionId };
    if (hostAnchor !== undefined) payload.hostAnchor = hostAnchor;
    if (title !== undefined) payload.title = title;
    if (startedAt !== undefined) payload.startedAt = startedAt;
    if (endedAt !== undefined) payload.endedAt = endedAt;
    if (idempotencyKey !== undefined) payload.idempotencyKey = idempotencyKey;
    const res = await client.databaseWrite(payload);
    return textResult(formatDeliverResult(res));
  });

  server.registerTool('discard', {
    description: 'edit/full/human 档可见：弃稿——丢弃一份草稿（给 branchId/baseDocId/shadowDocId，或先 switch 到一个草稿）。默认只预览，yes=true 时执行；正文不变。原 branch drop 已并入此动词。',
    inputSchema: {
      branchId: z.number().int().positive().optional(),
      shadowDocId: docIdSchema.optional(),
      baseDocId: docIdSchema.optional(),
      owner: ownerSchema.optional(),
      yes: z.boolean().optional()
    }
  }, async ({ yes, ...rest } = /** @type {BranchTargetArgs & { yes?: boolean }} */ ({})) => {
    const target = branchTarget(rest);
    if (!hasBranchTarget(target)) return textResult('discard 需要 branchId/baseDocId/shadowDocId，或先 switch 到一个分支。');
    if (!yes) return branchPreview('discard', target);
    return discardChange(target);
  });

  server.registerTool('undo', {
    description: 'edit/full/human 档可见：撤销当前 edit branch 内最后一条生效临时 diff entry，只改变 entry 的 active/undone 状态，不写入主文档历史。',
    inputSchema: {
      branchId: z.number().int().positive().optional(),
      shadowDocId: docIdSchema.optional(),
      baseDocId: docIdSchema.optional(),
      owner: ownerSchema.optional()
    }
  }, (input = {}) => stepEditBranchEntry('undo', input));

  server.registerTool('redo', {
    description: 'edit/full/human 档可见：恢复当前 edit branch 内最近一条已撤销临时 diff entry，只改变 entry 的 active/undone 状态，不写入主文档历史。',
    inputSchema: {
      branchId: z.number().int().positive().optional(),
      shadowDocId: docIdSchema.optional(),
      baseDocId: docIdSchema.optional(),
      owner: ownerSchema.optional()
    }
  }, (input = {}) => stepEditBranchEntry('redo', input));

  // A2A 待审收敛（projectneed 18-1 / 乙）：内置 agent 提议进 owner=llm:<会话> 影子分支，外部 agent 用统一
  // draft list（看，filter owner=llm:*）/ merge（整批采纳）/ discard（整批弃）审批，不再设 list_diffs/apply_diff/reject_diff 专属动词。
  // full/human 档动词（restore/export/rebase/cherry-pick、vectors/push/set_mode/bulk、memory_distill）；
  // import/delete 在 edit（18-3-1 成对）、seal 已自动化无动词（memory_volumes 列卷时顺手封到期卷）。
  if (tier === 'full' || tier === 'human') {
    server.registerTool('web_search', {
      description: 'full/human 档可见：联网检索（projectneed 15-5-3），用法对齐通用 web_search、保留 URL 校验+内网拦截；只读联网。给 query 返回搜索结果。',
      inputSchema: {
        query: z.string().describe('检索词。'),
        limit: z.number().int().positive().optional().describe('返回结果数上限。')
      }
    }, async ({ query, limit }) => {
      const argv = ['web', 'search', String(query)];
      if (limit) argv.push('--limit', String(limit));
      return textResult(await dbShell(client, argv));
    });

    server.registerTool('restore', {
      description: 'full/human 档可见：按 commit id（UUID）、committed_at 精确时间戳或 summary tag 精确回滚文档历史。',
      inputSchema: {
        ref: z.union([docIdSchema, z.string()]).optional().describe('commit id（UUID）、committed_at 或 summary tag。'),
        historyId: docIdSchema.optional().describe('commit id（UUID）；兼容旧入口名。'),
        savedAt: z.string().optional().describe('精确匹配 commits.committed_at。'),
        at: z.string().optional().describe('savedAt 的别名。'),
        tag: z.string().optional().describe('精确匹配 commits.summary。'),
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

    server.registerTool('revert', {
      description: 'full/human 档可见：反向提交——撤销某次已落改动、生成反向变更、保留其后历史（不丢历史，区别于 restore 的 reset 式回滚）。三方调和：只撤目标 commit 改过而其后未再动的部分、并复活其删过的节点；撞冲突（两侧改同处 / 结构性删改）一律 blocked 交人裁、不自动解。',
      inputSchema: {
        commitId: z.union([docIdSchema, z.string()]).describe('要撤销的 commit id（UUID）。'),
        docId: docIdSchema.optional().describe('可选，限定文档。'),
        json: z.boolean().optional().describe('true 时返回原始 JSON（含完整 doc 刷新）；默认渲染要点摘要。')
      }
    }, async ({ commitId, docId, json }) => {
      const payload = { action: 'history.revert', commitId, owner: DEFAULT_WRITE_OWNER };
      if (docId !== undefined) payload.docId = docId;
      const res = await client.databaseWrite(payload);
      return json ? jsonTextResult(res) : textResult(formatWriteResult(res, { label: 'revert' }));
    });

    server.registerTool('vectors', {
      description: 'full/human 档可见：为已导入文档补建语义向量（重算力，归 full）。只接收 docId。',
      inputSchema: { docId: docIdSchema }
    }, ensureVectors);

    server.registerTool('push', {
      description: 'full/human 档可见：流式写入（projectneed 4-16）。把一批消息节点直接追加进「增量编辑」文档，不走 edit branch。首次省略 docId、给 title 即新建增量编辑文档并挂在根下；之后给 docId + parentId(uuid 挂载点) 追加，省略 parentId 挂根下。写入信任恒为不受控（18-3：trust 字段下线、不接受 trust_level，标受控走 human 档 certify）；node_type 缺省 TEXT；更细结构放 children 数组递归（缩进即深度）。系统不做内容查重，去重责任在调用方——务必先 read 当前结构确认增量、再 push，不先读就盲推导致的重复由调用方负责。idempotencyKey 只抵消同一次请求的网络重试/重复投递（请求级幂等），不是内容去重。挂载点 uuid 可在增量编辑模式下用只读动词（tree/read）查到。',
      inputSchema: {
        docId: docIdSchema.optional().describe('目标增量编辑文档；省略且给 title 则新建。'),
        title: z.string().optional().describe('新建文档标题（仅首次、docId 省略时使用）。'),
        parentId: docIdSchema.optional().describe('挂载点节点 uuid；省略时挂在文档根节点下。'),
        nodes: z.array(z.any()).describe('节点数组；每个 { node_type?, text?, node_title?, node_note?, address?, children? }。写入信任恒为不受控（18-3：不接受 trust_level）。海量追加时给 address（调用方按读到的结构算好，系统校验纯追加并直写、不重排）；省略 address 则系统自动续号（小流友好）。children 递归表达子树。'),
        idempotencyKey: z.string().optional().describe('请求级幂等键：仅抵消同一次请求的网络重试/重复投递；不做内容去重，跨调用携带同键仍会照写新节点，去重责任在调用方（先 read 后 push）。'),
        embed: z.boolean().optional().describe('是否对这批刚写入的节点即时生成向量（推一点算一点，与 import 同名）。算力富裕、写入量小可开；海量导入建议不开以保写入吞吐，导完再离线补。声明开启但向量配置不可用会直接报错。'),
        json: z.boolean().optional().describe('true 时返回原始 JSON（含完整 created 树）；默认按缩进地址渲染。')
      }
    }, async ({ docId, title, parentId, nodes, idempotencyKey, embed, vectors, json } = /** @type {{ docId?: DocId, title?: string, parentId?: DocId, nodes?: any[], idempotencyKey?: string, embed?: boolean, vectors?: boolean, json?: boolean }} */ ({})) => {
      // vectors 是旧名、已退役；传了直接回报错别静默不建（统一用 embed）。
      if (vectors !== undefined) return textResult('push 用 embed 表示同步建向量，不再接受 vectors 参数。');
      const payload = { action: 'stream.push', nodes: nodes || [] };
      if (docId !== undefined) payload.docId = docId;
      if (title !== undefined) payload.title = title;
      if (parentId !== undefined) payload.parentId = parentId;
      if (idempotencyKey !== undefined) payload.idempotencyKey = idempotencyKey;
      if (embed !== undefined) payload.embed = embed;
      const res = await client.databaseWrite(payload);
      return json ? jsonTextResult(res) : textResult(formatPushResult(res));
    });

    server.registerTool('set_mode', {
      description: 'full/human 档可见：切换文档编辑模式（projectneed 4-16-8）。readonly 只读 / incremental 增量编辑（流式写入）/ full 完整编辑（2way/3way 分支与合并）。增量编辑与完整编辑互斥：流式写入期间不能分支编辑；要修订流式文档先切回 full，改完可再切回 incremental。',
      inputSchema: {
        docId: docIdSchema,
        mode: z.enum(['readonly', 'incremental', 'full'])
      }
    }, async ({ docId, mode } = /** @type {{ docId?: DocId, mode?: string }} */ ({})) => {
      const res = await client.databaseWrite({ action: 'doc.setEditMode', docId, mode, includeDoc: false });
      return textResult(formatWriteResult(res, { label: 'set_mode' }));
    });

    server.registerTool('bulk', {
      description: 'full/human 档可见：海量流式导入加速会话（projectneed 4-16）。begin 设异步写（synchronous=OFF，journal 保持 WAL 不降级）；end 恢复安全设置并 checkpoint 截断 -wal。索引不再 drop/重建（SQL/FTS 全程增量维护，唯一延迟的重活是离线补 bge-m3 向量）。导大批语料时 begin → 多次 push → end；崩溃丢最近批由地址校验 + 幂等重推兜底。共享后端上 begin 需独占（使用前提）：有其他客户端（如 opencode/codex）在线会被拒——先确保单客户端、或 restart_backend 清场后再用；会话期间其他客户端的写请求被拒（读不受影响），开启方断线自动恢复安全设置。仅在专门导入阶段用，日常库勿开。',
      inputSchema: {
        action: z.enum(['begin', 'end'])
      }
    }, async ({ action } = /** @type {{ action?: 'begin' | 'end' }} */ ({})) => {
      const res = await client.databaseWrite({ action: action === 'begin' ? 'stream.bulkBegin' : 'stream.bulkEnd' });
      return textResult(formatWriteResult(res, { label: 'bulk' }));
    });

    server.registerTool('memory_distill', {
      description: 'full/human 档可见：标记记忆卷已提炼（15-11-5；提炼落地受控事实只经人审，故归 full）。冷却期内默认拒绝，force 仅限用户明确指示"记一下"时用；活跃卷上 force 是截至当下的快照标记、不封卷。封卷已自动化（memory_volumes 列卷时按 24h 顺手封），不再设 seal 动词。',
      inputSchema: {
        docId: docIdSchema.describe('要标记的卷 docId。'),
        force: z.boolean().optional().describe('跳过冷却期（用户明确指示时）。')
      }
    }, async ({ docId, force } = /** @type {{ docId?: DocId, force?: boolean }} */ ({})) => {
      const res = await client.databaseWrite({ action: 'memory.markDistilled', docId, force: force === true });
      return textResult(formatWriteResult(res, { label: 'memory_distill' }));
    });

    server.registerTool('relink', {
      description: 'full/human 档可见：把已导入 doc 重绑到新的源文件路径（锚改名/迁移后用，15-10-4），更新 meta.sourcePath 与 source_documents.original_path，不动正文、不改 source_type。不强制校验目标存在（记忆/会话卷由对应 agent 自己维护、我们不替外部程序管文件状态），但回执会自检并报 targetExists。',
      inputSchema: {
        docId: docIdSchema,
        sourcePath: z.string().describe('新源文件路径（与 import 记录一致，建议库内绝对路径）。')
      }
    }, async ({ docId, sourcePath }) => {
      return textResult(await dbShell(client, ['relink', String(docId), String(sourcePath)]));
    });

    server.registerTool('export', {
      description: 'full/human 档可见：导出一个已导入 doc 为 Markdown 文本。当前实现返回文本，不写文件。',
      inputSchema: {
        docId: docIdSchema,
        limit: z.number().int().positive().optional().describe('返回字数门禁；默认 1 万，超了截断并提示。要导全文显式加大到所需字数（二次突破）。')
      }
    }, async ({ docId, limit }) => {
      const res = await client.databaseRead({ action: 'doc.exportMarkdown', docId });
      return textResult(clipText(res?.text || '', limit || CHAR_LIMITS.fullText, { label: '导出全文' }));
    });

    server.registerTool('rebase', {
      description: 'full/human 档可见：把当前 edit branch 的 lazy base 刷新到当前主干 HEAD，并返回分支状态。当前不是完整冲突裁决器。',
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
      const res = await client.databaseWrite(payload);
      return textResult(formatWriteResult(res, { label: 'rebase' }));
    });

    server.registerTool('cherry-pick', {
      description: 'full/human 档可见：从同一文档的保存历史或 edit branch 中摘取 edit entries，写入目标 edit branch。目标分支须已存在：传 targetBranchId，或先 switch 到目标分支；targetBaseDocId/owner 只用于定位已有分支、不会自动新建（先用 draft new 建好目标分支再 cherry-pick）。',
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
      const res = await client.databaseWrite(payload);
      return textResult(formatWriteResult(res, { label: 'cherry-pick' }));
    });

  }

  if (tier === 'full' || tier === 'human') {
    // full 档运维：对象库 GC（mark-sweep，lazy/手动）——回收不被任何 commit 引用的历史对象。
    server.registerTool('gc_objects', {
      description: 'full 档运维：对象库垃圾回收（mark-sweep）。回收不被任何 commit 引用的历史对象（blob/tree/source）——即删文档/删 commit 后变孤儿的内容寻址对象。reset/revert 跳过的 commit 仍在表中、其对象不会被收（保住可后悔窗口）。不在写热路径，需要时手动跑。'
    }, async () => {
      const res = await client.databaseWrite({ action: 'objects.gc' });
      if (!res?.ok) return textResult(`gc 失败：${JSON.stringify(res)}`);
      return textResult(`对象库 GC 完成：扫描 ${res.scanned} · 可达 ${res.reachable} · 回收 ${res.deleted}`);
    });
  }

  if (tier === 'human') {
    // human 档专属背书动词（projectneed 18-3）：标受控的唯一合法入口，owner 恒 human、进历史可追溯。
    server.registerTool('certify', {
      description: 'human 档专属：节点级背书——把节点或整棵子树标受控（受控内容的唯一合法来源，18-3）；owner 恒 human、作为一次 human 提交进历史，改 trust 即改内容指纹（A5-2）。scope=subtree 默认标整子树、node 只本节点；trust=不受控 用于撤销背书（收回许可）。定位给 nodeId 或 address 之一。',
      inputSchema: {
        docId: docIdSchema,
        nodeId: docIdSchema.optional().describe('目标节点 id；与 address 二选一。'),
        address: z.string().optional().describe('目标节点地址（如 1-3-2）；与 nodeId 二选一。'),
        scope: z.enum(['subtree', 'node']).optional().describe('subtree 默认标整子树 / node 只本节点。'),
        trust: z.enum(['受控', '不受控']).optional().describe('默认受控；不受控用于撤销背书。')
      }
    }, async ({ docId, nodeId, address, scope, trust }) => {
      const payload = { action: 'history.certify', docId, owner: 'human' };
      if (nodeId !== undefined) payload.nodeId = nodeId;
      if (address !== undefined) payload.address = address;
      if (scope !== undefined) payload.scope = scope;
      if (trust !== undefined) payload.trust = trust;
      const res = await client.databaseWrite(payload);
      return textResult(formatWriteResult(res, { label: 'certify' }));
    });
  }
}

async function main() {
  // 后端共用（projectneed 18-6-1）：写档（edit/full）实例经连接描述文件发现并复用共享后端，
  // 连不上自行拉起（detached），单机离线回退私有 stdio；只读实例照旧各起私有后端（并发读安全）。
  const hostScriptPath = join(PROJECT_ROOT, 'scripts', 'agent-host.mjs');
  // 统一 backend-client SDK：写档（edit/full）走共享管道复用同一后端、只读档走私有 stdio（并发读安全）；
  // 各动词只调 SDK 的语义方法、内部不再散写 request('database.read'...)。owner 解析 / payload 构造仍是
  // mcp-server 的入口业务、留在动词侧不进 SDK。
  const client = createBackendClient({
    projectRoot: PROJECT_ROOT,
    hostScriptPath,
    mode: IS_WRITE_TIER ? 'shared' : 'private',
    onStderr: (text) => process.stderr.write(text),
    onStatus: (text) => process.stderr.write(text)
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
    '信任语义：节点分受控（经人工审批）/不受控（机器产物未经人审）；导入知识文档默认无人工标注（trust 为空 NULL），实践中按不受控对待；事件卷一律不受控——这是层级的时态属性，不是质量评分。命中未解决的 ERROR 节点必须停下向用户报告，不得绕过续跑。',
    '',
    '时间纪律：召回结果附带时间元数据，采信前先看时间；同主题证据冲突新者胜，不得以"内容看起来更合理"推翻时间新旧；找不到更新的证据时，旧证据就是最佳可用证据，知旧而用。',
    '',
    '记忆写入边界（18-8-3）：外部 agent 唯一合法的记忆侧写入是事件卷投递（memory_deliver，edit/full 档）——会话收尾把结构化自述日志投递成卷，用户说"记一下"时当场投快照卷；契约与骨架见 .iftree-llm-workspace/skills/memory-deliver/SKILL.md。不得把自己的结论直写成记忆。',
    '',
    `当前接入档位（IFTREE_MCP_TIER）=${TIER}：read 只读检索 / edit 增量写(owner=llm) / full 分支编辑·合并(owner=llm) / human 直写主库·审批·标受控(owner=human)。写动词是否注册由此档位决定；非 human 档不能以 human 身份写入。`,
    '',
    '更详尽的记忆库使用（召回动线、find 范围过滤、写入边界与提炼、存储定位、操作踩坑）见 docs/memory.md。'
  ].join('\n');

  const server = new McpServer({ name: 'iftree-library', version: '0.3.0' }, { instructions: SERVER_INSTRUCTIONS });
  registerRetrievalTools(server, client);
  registerAgentTools(server, client, TIER);
  registerLifecycleTools(server, client);
  if (IS_WRITE_TIER) registerWriteTools(server, client, TIER);

  const shutdown = async () => {
    // 共享后端（mode==='pipe'）是多客户端复用的，不能因单个 MCP 退出而全局关停——只断开本连接。
    // 私有兜底后端（private）/只读档自起的 headless（无 mode）由本进程独占，正常 shutdown 免泄漏子进程。
    // restart_backend 仍走 client.shutdown()（有意全局重启共享后端），不受此处影响。
    try {
      if (client.mode !== 'pipe') await client.shutdown();
    } catch { /* already closing */ }
    client.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
}

// 仅在被直接运行（electron scripts/mcp-server.mjs）时自启 server；被测试 import 时不启动。
if ((process.argv[1] || '').endsWith('mcp-server.mjs')) main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || error}\n`);
  process.exit(1);
});
