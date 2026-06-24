const TOOL_ARGS_PREVIEW_LIMIT = 200;

interface TranscriptBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface TranscriptEvent {
  type: string;
  message?: {
    content?: string | TranscriptBlock[];
    stop_reason?: string;
  };
  timestamp?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
}

interface TurnMessage {
  role: 'user' | 'assistant';
  content: string;
  status?: string;
  createdAt?: string;
  toolEvents?: ToolEvent[];
}

interface ToolEvent {
  name: string;
  status: string;
  argsPreview: string;
}

function clip(value: unknown, max: number): string {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function textFromBlocks(blocks: TranscriptBlock[]): string {
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!)
    .join('\n')
    .trim();
}

function toolEventsFromBlocks(blocks: TranscriptBlock[]): ToolEvent[] {
  return blocks
    .filter((block) => block && block.type === 'tool_use')
    .map((block) => ({
      name: block.name || 'tool',
      status: 'called',
      argsPreview: clip(JSON.stringify(block.input ?? {}), TOOL_ARGS_PREVIEW_LIMIT)
    }));
}

const SYSTEM_USER_LINE_PREFIXES = [
  '<command-name', '<command-message', '<command-args',
  '<local-command-stdout', '<local-command-stderr', '<local-command-caveat',
  '<system-reminder', '<task-notification', '<user-memory-input'
];

function isSyntheticUserEvent(event: TranscriptEvent, text: string): boolean {
  if (event.isMeta === true) return true;
  if (event.isCompactSummary === true || event.isVisibleInTranscriptOnly === true) return true;
  return SYSTEM_USER_LINE_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export function messagesFromClaudeTranscript(text: unknown): TurnMessage[] {
  const messages: TurnMessage[] = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    let event: TranscriptEvent;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
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
      const blocks = Array.isArray(event.message?.content) ? event.message!.content : [];
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