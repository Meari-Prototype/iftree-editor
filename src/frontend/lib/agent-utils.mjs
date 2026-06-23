export const AGENT_REASONING_OPTIONS = [
  { value: 'auto', label: '自动' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' }
];

const AGENT_REASONING_VALUES = new Set(AGENT_REASONING_OPTIONS.map((option) => option.value));

export function normalizeAgentReasoningEfforts(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/[,，\s/]+/);
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const raw = String(item || '').trim().toLowerCase();
    const effort = raw === 'max' ? 'xhigh' : raw;
    if (effort && effort !== 'auto' && AGENT_REASONING_VALUES.has(effort) && !seen.has(effort)) {
      seen.add(effort);
      result.push(effort);
    }
  }
  return result;
}

export function formatAgentElapsed(value) {
  const ms = Number(value || 0);
  if (!Number.isFinite(ms)) return '';
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `已处理 ${seconds} 秒`;
  return `已处理 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function agentHistoryForRequest(messages = []) {
  return messages
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      mode: message.mode,
      content: message.role === 'assistant' ? message.answer : message.content,
      // 结构压缩的原料：历史压缩按 toolEvents 提取触达过的 doc/address/path 指针。
      // 只传压缩所需的最小子集，resultPreview 体积大且指针从 args 已可提取。
      toolEvents: message.role === 'assistant' && Array.isArray(message.toolEvents)
        ? message.toolEvents.map((event) => ({
            name: event?.name,
            status: event?.status,
            argsPreview: event?.argsPreview
          }))
        : undefined
    }))
    .filter((message) => String(message.content || '').trim());
}

export function agentSessionTitle(session) {
  return clipText(session?.prompt || `会话 ${session?.id || ''}`, 26);
}

export function agentSessionTime(session) {
  const value = session?.updated_at || session?.created_at;
  const date = parseAgentSessionDate(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function parseAgentSessionDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) {
    return new Date(`${text.replace(' ', 'T')}Z`);
  }
  return new Date(text);
}

export function agentMessagesFromSession(session) {
  if (!session) return [];
  const result = session.result || {};
  if (Array.isArray(result.messages) && result.messages.length > 0) {
    return result.messages.map((message, index) => {
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      return {
        id: `session-${session.id}-${index}`,
        sessionId: session.id,
        role,
        mode: message.mode || session.mode,
        content: role === 'user' ? message.content || '' : undefined,
        answer: role === 'assistant' ? message.content || message.answer || '' : undefined,
        status: message.status || (role === 'assistant' ? '已保存' : undefined),
        diffCount: Number(message.diffCount || 0),
        usage: message.usage || null,
        toolEvents: Array.isArray(message.toolEvents) ? message.toolEvents : [],
        segments: Array.isArray(message.segments) ? message.segments : [],
        error: Boolean(message.error),
        streaming: false,
        createdAt: Date.parse(message.createdAt || '') || Date.parse(session.updated_at || '') || Date.now()
      };
    });
  }
  const createdAt = Date.parse(session.created_at || '') || Date.now();
  const updatedAt = Date.parse(session.updated_at || '') || createdAt;
  return [
    {
      id: `session-${session.id}-user`,
      sessionId: session.id,
      role: 'user',
      mode: session.mode,
      content: session.prompt || '',
      createdAt
    },
    {
      id: `session-${session.id}-assistant`,
      sessionId: session.id,
      role: 'assistant',
      mode: session.mode,
      answer: result.answer || result.error || '会话已保存，但没有完成回答。',
      status: result.error ? '失败' : '已保存',
      diffCount: Number(result.pendingDiffCount || session.pending_diff_count || 0),
      usage: result.usage || null,
      toolEvents: Array.isArray(result.toolEvents) ? result.toolEvents : [],
      error: Boolean(result.error),
      streaming: false,
      createdAt: updatedAt
    }
  ];
}

export function buildAgentModelOptions(settings = {}) {
  const config = settings || {};
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const options = [];
  for (const provider of providers) {
    const apis = Array.isArray(provider.apis) ? provider.apis : [];
    for (const apiItem of apis) {
      if (apiItem.enabled === false) continue;
      if (!String(apiItem.apiKey || '').trim()) continue;
      const model = String(apiItem.model || '').trim();
      options.push({
        key: `${provider.id}:${apiItem.id}`,
        providerId: provider.id,
        apiId: apiItem.id,
        model,
        protocol: apiItem.protocol || 'openai-compatible',
        reasoningEfforts: normalizeAgentReasoningEfforts(apiItem.reasoningEfforts || apiItem.reasoning_efforts),
        label: model || apiItem.name || provider.name || '默认模型',
        title: `${provider.name || 'API'} / ${apiItem.name || model || '模型'}`
      });
    }
  }
  return options;
}

export function defaultAgentModelKey(settings = {}, options = []) {
  const config = settings || {};
  const key = `${config.activeProviderId || ''}:${config.activeApiId || ''}`;
  return options.some((option) => option.key === key) ? key : options[0]?.key || 'default';
}

export function compactAgentModelLabel(value) {
  const text = String(value || '').trim();
  if (!text) return '模型';
  const lower = text.toLowerCase();
  const version = lower.match(/(?:^|[-_])(?:gpt-)?(\d+(?:\.\d+)?)(?:[-_]|$)/);
  if (version?.[1]) return version[1].slice(0, 4);
  const vName = lower.match(/(?:^|[-_])v(\d+)/);
  if (vName?.[1]) return `v${vName[1]}`.slice(0, 4);
  if (lower.includes('sonnet')) return 'Sn';
  if (lower.includes('opus')) return 'Op';
  if (lower.includes('flash')) return 'Fl';
  const cleaned = text.replace(/^(deepseek|claude|gemini|gpt|openai|glm|kimi|grok)[-_ ]*/i, '');
  return (cleaned || text).slice(0, 2);
}

export function agentReasoningLabel(value) {
  return AGENT_REASONING_OPTIONS.find((option) => option.value === value)?.label || '自动';
}

export function agentReasoningShortLabel(value) {
  if (value === 'xhigh') return '超';
  if (value === 'auto') return '自';
  return agentReasoningLabel(value).slice(0, 1);
}

export function agentModeLabel(value) {
  if (value === 'full') return '完全';
  return value === 'edit' ? '协作' : '问答';
}

export function formatTokenCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '0';
  if (number >= 1000000) return `${(number / 1000000).toFixed(1)}m`;
  if (number >= 1000) return `${(number / 1000).toFixed(number >= 10000 ? 0 : 1)}k`;
  return String(Math.round(number));
}

export function agentContextUsageView(usage) {
  if (!usage?.promptTokens) return { label: 'ctx --', title: '等待 API usage 字段', ratio: 0, level: 'empty' };
  const prompt = formatTokenCount(usage.promptTokens);
  const contextLimit = Number(usage.contextLimit);
  const cached = usage.cachedTokens ? `，缓存 ${formatTokenCount(usage.cachedTokens)}` : '';
  const cacheMiss = usage.cacheMissTokens ? `，未命中 ${formatTokenCount(usage.cacheMissTokens)}` : '';
  const reasoning = usage.reasoningTokens ? `，推理 ${formatTokenCount(usage.reasoningTokens)}` : '';
  if (!Number.isFinite(contextLimit) || contextLimit <= 0) {
    return {
      label: `ctx · ${prompt}/?`,
      title: `上下文使用：prompt ${usage.promptTokens}；当前 API 未配置上下文窗口${cached}${cacheMiss}${reasoning}`,
      ratio: 0,
      level: 'empty'
    };
  }
  const ratio = Math.max(0, Math.min(1, Number(usage.ratio) || 0));
  const percent = Math.round(ratio * 100);
  const limit = formatTokenCount(usage.contextLimit);
  return {
    label: `${percent}% · ${prompt}/${limit}`,
    title: `上下文使用：prompt ${usage.promptTokens} / ${usage.contextLimit}${cached}${cacheMiss}${reasoning}`,
    ratio,
    level: ratio > 0.8 ? 'danger' : ratio > 0.55 ? 'warn' : 'ok'
  };
}

export function upsertAgentToolEvent(events = [], tool = {}) {
  const list = Array.isArray(events) ? events : [];
  const id = String(tool.id || `${tool.name || 'tool'}-${list.length}`);
  const next = { ...tool, id };
  const index = list.findIndex((event) => event.id === id);
  if (index < 0) return [...list, next];
  return list.map((event, eventIndex) => (eventIndex === index ? { ...event, ...next } : event));
}

// 有序段（交错渲染）：delta 落到末尾 text 段（无则新建）；tool 事件按 toolId 占位、保持时间线顺序。
// tool 段只记 toolId，工具数据始终在 toolEvents 单一来源，渲染时按 id 回查。
export function appendTextToSegments(segments, text) {
  if (!text) return Array.isArray(segments) ? segments : [];
  const list = Array.isArray(segments) ? segments.slice() : [];
  const last = list[list.length - 1];
  if (last && last.kind === 'text') {
    list[list.length - 1] = { ...last, text: `${last.text}${text}` };
  } else {
    list.push({ kind: 'text', text });
  }
  return list;
}

export function appendToolToSegments(segments, toolId) {
  const id = String(toolId || '');
  const list = Array.isArray(segments) ? segments : [];
  if (!id || list.some((segment) => segment.kind === 'tool' && segment.toolId === id)) return list;
  return [...list, { kind: 'tool', toolId: id }];
}

export function appendReasoningToSegments(segments, text) {
  if (!text) return Array.isArray(segments) ? segments : [];
  const list = Array.isArray(segments) ? segments.slice() : [];
  const last = list[list.length - 1];
  if (last && last.kind === 'reasoning') {
    list[list.length - 1] = { ...last, text: `${last.text}${text}` };
  } else {
    list.push({ kind: 'reasoning', text });
  }
  return list;
}

export function agentToolStatusText(status) {
  if (status === 'done') return '完成';
  if (status === 'error') return '失败';
  return '运行中';
}

// 工具行单行摘要：取参数预览压成一行，剥掉最外层 JSON 花括号，类似 cc 的 Tool(args) 形态。
export function agentToolArgsSummary(tool, limit = 60) {
  let text = String(tool?.argsPreview || '').replace(/\s+/g, ' ').trim();
  if (text.startsWith('{') && text.endsWith('}')) text = text.slice(1, -1).trim();
  return clipText(text, limit);
}

export function agentToolNameText(name) {
  if (name === 'default_context') return '默认上下文';
  if (name === 'search_manifest') return '搜索清单';
  if (name === 'fetch_content') return '读取内容';
  if (name === 'propose_changes') return '生成待审变更';
  if (name === 'propose_node_patch') return '修改节点待审';
  if (name === 'propose_node_insert') return '新增节点待审';
  if (name === 'propose_node_delete') return '删除节点待审';
  if (name === 'propose_ref_delete') return '删除引用待审';
  if (name === 'propose_source_bind_path') return '绑定路径待审';
  if (name === 'workspace_file') return '工作区文件';
  if (name === 'admin_override') return '管理员直查';
  if (name === 'database_write') return '数据库写入';
  if (name === 'web_search') return '联网搜索';
  return name || '工具调用';
}

export function clipText(value, limit = 180) {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// A2A 收敛后（projectneed 18-1）agentDiffs = owner=llm:<会话> 编辑分支列表（整批，一分支 = 一组提议）。
// 下面把分支的 diff.entries 解析成卡片摘要；明细对照走统一 diff 视图。
const AGENT_ENTRY_LABELS = {
  'node.update': '改节点', 'node.insert': '增节点', 'node.delete': '删节点',
  'node.move': '移动节点', 'node.promote': '提升节点', 'node.split': '拆分节点',
  'node.mergeInto': '并入节点', 'node.mergePrevious': '并入上一条', 'node.reparent': '改父节点',
  'node.moveBefore': '前移节点', 'node.moveAfter': '后移节点',
  'axiom.add': '增前提', 'axiom.update': '改前提', 'axiom.delete': '删前提', 'axiom.move': '移前提',
  'ref.addNodeToNode': '加引用', 'ref.addAxiomToNode': '加前提引用', 'ref.delete': '删引用'
};

export function agentBranchEntries(branch) {
  let diff = {};
  try {
    diff = typeof branch?.diff === 'string' ? JSON.parse(branch.diff || '{}') : (branch?.diff || {});
  } catch {
    diff = {};
  }
  const entries = Array.isArray(diff.entries) ? diff.entries : [];
  return entries
    .filter((entry) => entry && entry.status !== 'undone')
    .map((entry, index) => ({
      key: entry.createdAt || `${branch?.id ?? 'b'}:${index}`,
      label: AGENT_ENTRY_LABELS[entry.kind] || entry.kind || '改动',
      address: entry.address || entry.parent_ref || entry.target_ref || entry.node_ref || ''
    }));
}

export function agentBranchDocLabel(branch, docs = []) {
  if (branch?.base_title) return branch.base_title;
  const match = Array.isArray(docs)
    ? docs.find((doc) => String(doc?.id) === String(branch?.base_doc_id))
    : null;
  return match?.title || branch?.base_doc_id || '未知文档';
}

// owner 标签：A2A 待审分支 owner 形如 llm:<会话id>（A5-5 写入者身份+会话隔离，每会话一条分支）。
// 优先映射成该会话的可读标题，找不到会话时回落「会话 <id>」；llm/human/其他原样转友好名。
export function agentBranchOwnerLabel(branch, sessions = []) {
  const owner = String(branch?.owner || '').trim();
  if (!owner) return '未知来源';
  const match = owner.match(/^llm:(.+)$/);
  if (match) {
    const sessionId = match[1];
    const session = Array.isArray(sessions)
      ? sessions.find((item) => String(item?.id) === String(sessionId))
      : null;
    return session ? agentSessionTitle(session) : `会话 ${sessionId}`;
  }
  const ownerRoleSeg = String(owner || '').split('#')[0].split(':')[0];
  if (ownerRoleSeg === 'llm') return '智能体';
  if (ownerRoleSeg === 'human') return '人类';
  return owner;
}
