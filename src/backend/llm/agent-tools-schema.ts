// 内置 agent 工具面的 schema 与变更提案规整（agent-runtime 拆分，§6-7）：
// propose_* / workspace_file / import / vectors / web_search / bash 的 inputSchema，
// 以及 node_patch 字段白名单与变更动作判定。只描述工具形状，不含执行逻辑。
import { normalizeNodeType } from '../../core/node-model.js';
import type { Json, AnyRecord } from './agent-shared.js';

﻿export const STABLE_ID_SCHEMA = Object.freeze({
  anyOf: [{ type: 'string' }, { type: 'number' }]
});

export const AGENT_CHANGE_ACTIONS = new Set([
  'node_patch',
  'node_insert',
  'node_delete',
  'ref_delete',
  'source_bind_path'
]);

export function normalizeNodePatch(patch: AnyRecord = {}): AnyRecord {
  if (
    Object.prototype.hasOwnProperty.call(patch, 'human_tag') ||
    Object.prototype.hasOwnProperty.call(patch, 'humanTag')
  ) {
    throw new Error('node_patch no longer supports human_tag; set node_type instead');
  }
  const allowed = ['text', 'node_title', 'node_note', 'node_type', 'trust_level'];
  const next: AnyRecord = {};
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

export function agentOperationAction(operation: AnyRecord = {}): string {
  const action = String(operation.action || operation.type || '').trim();
  return AGENT_CHANGE_ACTIONS.has(action) ? action : '';
}

export function patchFieldsSchema(): Json {
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

export function proposeNodePatchToolSchema(): Json {
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

export function proposeNodeInsertToolSchema(): Json {
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

export function proposeNodeDeleteToolSchema(): Json {
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

export function proposeRefDeleteToolSchema(): Json {
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

export function proposeSourceBindPathToolSchema(): Json {
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

export function workspaceFileToolSchema(): Json {
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

export function importLibraryDocumentToolSchema(): Json {
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

export function deleteLibraryDocumentToolSchema(): Json {
  return {
    type: 'object',
    properties: {
      docId: { ...STABLE_ID_SCHEMA, description: '要删除的已导入数据库文档 id；只删数据库数据，不删 library 真实文件。' }
    },
    required: ['docId']
  };
}

export function ensureDocVectorsToolSchema(): Json {
  return {
    type: 'object',
    properties: {
      docId: { ...STABLE_ID_SCHEMA, description: '已导入文档 id。只补当前缺失或正文已变更节点的语义向量；节点重挂或地址变化不触发重算。' }
    },
    required: ['docId']
  };
}

export function webSearchToolSchema(): Json {
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

export function bashToolSchema(): Json {
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