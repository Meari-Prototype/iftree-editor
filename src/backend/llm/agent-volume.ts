// 事件卷投递的节点组装（agent-runtime 拆分，§6-7）——卷投递块的纯转换部分；
// 投递动作本身经 db 契约 memory.deliverVolume（15-10 / 18-8）。
import type { ToolEvent } from './agent-history.js';

﻿// 内置自动落卷的 session→节点树转换（15-10-2）：消息粒度局部展开——一条消息一个节点，
// 工具事件作为助手消息的子节点；事件卷一律不受控（15-10-3）。
export interface VolumeMessage {
  role?: string;
  mode?: string;
  status?: string;
  content?: unknown;
  createdAt?: string;
  toolEvents?: ToolEvent[];
}

export interface VolumeNode {
  node_title: string;
  node_note?: string;
  text: string;
  trust_level: string;
  children?: VolumeNode[];
}

export function volumeNodesFromTurnMessages(messages: VolumeMessage[] = []): VolumeNode[] {
  const nodes: VolumeNode[] = [];
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
    const children: VolumeNode[] = (Array.isArray(message.toolEvents) ? message.toolEvents : []).map((event) => ({
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