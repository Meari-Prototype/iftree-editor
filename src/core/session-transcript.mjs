// 宿主 agent 的 session transcript → 标准 turn messages（启发式、纯规则解析，projectneed 15-10）。
//
// 事件卷不靠 agent 复述自述日志（那不确定、每次不一样、白烧 token），而是对宿主原始 session 文件
// 做确定性规则解析。同一份 transcript、同样的规则 → 同样的 messages → 同样的节点树（位置恒常不变），
// 这正是「全删旧卷 + 完整重新导入」能等价于「增量追加」、从而甩掉声明地址/幂等键/抢锚那一摊的根基。
//
// 产出的 messages 与内置 agent 落卷同形（{ role, content, status?, createdAt?, toolEvents? }），
// 交给 volumeNodesFromTurnMessages 转成卷节点——内外两路 agent「导入方式完全一样」。
// 纯函数、不碰 fs：调用方（host）读出文本后传进来。

const TOOL_ARGS_PREVIEW_LIMIT = 200;

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// CC transcript 的 assistant 内容是块数组（thinking / text / tool_use）；user 内容是字符串，
// 或块数组（含 tool_result 等附件）。这里只取 text 块拼成正文——thinking 是 agent 内心戏、
// 不是「发生过什么」，tool_result 是工具返回不是对话，都不进卷。
function textFromBlocks(blocks) {
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function toolEventsFromBlocks(blocks) {
  return blocks
    .filter((block) => block && block.type === 'tool_use')
    .map((block) => ({
      name: block.name || 'tool',
      status: 'called',
      argsPreview: clip(JSON.stringify(block.input ?? {}), TOOL_ARGS_PREVIEW_LIMIT)
    }));
}

// CC 会把不少「系统合成内容」也写成 type=user 的行——斜杠命令展开（<command-name> 等）、本地命令
// 输出（<local-command-stdout/stderr/caveat>）、system-reminder（可夹带整段 CLAUDE.md / 工具列表）、
// task-notification（后台任务通知）、/compact·续接生成的对话摘要、以及工具重试提示（"…malformed…"）。
// 它们不是用户原话，混进卷会污染事件卷与下游检索。判据对齐 CC 自身的过滤、并按本机全量 session 实测校准：
//   · 事件级元标记：isMeta（caveat / 重试提示）、isCompactSummary / isVisibleInTranscriptOnly（compact 摘要）；
//   · 已知系统标签前缀（仅出现在 string 形态的 user 正文）。
// 负向排除：默认当真实保留（尽量不丢真实事件），只在确证是系统行时才跳过。
const SYSTEM_USER_LINE_PREFIXES = [
  '<command-name', '<command-message', '<command-args',
  '<local-command-stdout', '<local-command-stderr', '<local-command-caveat',
  '<system-reminder', '<task-notification', '<user-memory-input'
];

function isSyntheticUserEvent(event, text) {
  if (event.isMeta === true) return true;
  if (event.isCompactSummary === true || event.isVisibleInTranscriptOnly === true) return true;
  return SYSTEM_USER_LINE_PREFIXES.some((prefix) => text.startsWith(prefix));
}

// Claude Code transcript（每行一个事件 JSON）→ 标准 turn messages。
// 只取真正的对话回合：
//   · type=user：content 为字符串（或块数组里的 text 块）= 用户逐字原话；系统合成的 user 行（见上）过滤掉。
//   · type=assistant：text 块拼成回复正文，tool_use 块成工具事件（子节点）。
export function messagesFromClaudeTranscript(text) {
  const messages = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      continue; // 半行/损坏行：跳过，不让一行坏数据毁掉整卷
    }
    if (!event || typeof event !== 'object') continue;

    if (event.type === 'user') {
      const content = event.message?.content;
      const userText = typeof content === 'string'
        ? content.trim()
        : Array.isArray(content) ? textFromBlocks(content) : '';
      if (userText && !isSyntheticUserEvent(event, userText)) {
        messages.push({ role: 'user', content: userText, createdAt: event.timestamp || '' });
      }
      continue;
    }

    if (event.type === 'assistant') {
      const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
      const content = textFromBlocks(blocks);
      const toolEvents = toolEventsFromBlocks(blocks);
      if (content || toolEvents.length) {
        messages.push({
          role: 'assistant',
          content,
          status: event.message?.stop_reason || '完成',
          createdAt: event.timestamp || '',
          toolEvents
        });
      }
    }
  }
  return messages;
}
