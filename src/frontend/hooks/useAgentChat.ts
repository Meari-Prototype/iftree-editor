import { useEffect, useMemo, useRef, useState } from 'react';

import { agentMessagesFromSession, appendReasoningToSegments, appendTextToSegments, appendToolToSegments, upsertAgentToolEvent } from '../lib/agent-utils.js';
import { agentRepository } from '../data/repositories.js';
import { useAppUIContext } from './useAppUI.js';

type AgentRecord = Record<string, unknown>;
type PendingDelta = {
  text: string;
  usage: unknown;
  reasoning?: string;
};

export function useAgentChat() {
  const { setNotice } = useAppUIContext();
  const [agentSettings, setAgentSettings] = useState<AgentRecord | null>(null);
  const [agentMessages, setAgentMessages] = useState<AgentRecord[]>([]);
  const [agentDiffs, setAgentDiffs] = useState<AgentRecord[]>([]);
  const [agentSessions, setAgentSessions] = useState<AgentRecord[]>([]);
  const [activeAgentSessionId, setActiveAgentSessionId] = useState<any>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentContextUsage, setAgentContextUsage] = useState<any>(null);
  const agentSettingsSaveSeqRef = useRef(0);

  useEffect(() => {
    if (!agentRepository.canStream()) return undefined;
    // delta 节流：流式 token 每秒几十个，逐个 setState 会让 App 整树以同频重渲染。
    // 这里把 delta 文本按 requestId 累积，最长 80ms 合并提交一次；
    // 非 delta 事件（status/tool/done）先冲掉积压再处理，保证顺序不乱。
    const pendingDeltas = new Map<unknown, PendingDelta>();
    let flushTimer = 0;
    const applyPendingDeltas = () => {
      if (pendingDeltas.size === 0) return;
      const batch = new Map(pendingDeltas);
      pendingDeltas.clear();
      let usage: unknown = null;
      for (const entry of batch.values()) {
        if (entry.usage) usage = entry.usage;
      }
      if (usage) setAgentContextUsage(usage);
      setAgentMessages((previous) => previous.map((message) => {
        const entry = batch.get(message.requestId);
        if (!entry || message.role !== 'assistant') return message;
        let segments = message.segments;
        if (entry.reasoning) segments = appendReasoningToSegments(segments, entry.reasoning);
        if (entry.text) segments = appendTextToSegments(segments, entry.text);
        // 流式同时累积两份投影：segments 给界面渲染（交错结构）、answer 给历史回传（纯文本）。
        // 收尾时 answer 会被后端的最终回答覆盖校准（见 done 分支），segments 保留——两者本就不强求逐字一致。
        return {
          ...message,
          answer: `${message.answer || ''}${entry.text || ''}`,
          segments,
          status: '正在回复...',
          streaming: true
        };
      }));
    };
    const unsubscribe = agentRepository.onStream((rawEvent: unknown) => {
      const event = rawEvent as AgentRecord;
      if (event?.type === 'delta') {
        const entry = pendingDeltas.get(event.requestId) || { text: '', usage: null };
        entry.text += event.text || '';
        if (event.usage) entry.usage = event.usage;
        pendingDeltas.set(event.requestId, entry);
        if (!flushTimer) {
          flushTimer = window.setTimeout(() => {
            flushTimer = 0;
            applyPendingDeltas();
          }, 80);
        }
        return;
      }
      if (event?.type === 'reasoning') {
        const entry = pendingDeltas.get(event.requestId) || { text: '', usage: null };
        entry.reasoning = `${entry.reasoning || ''}${event.text || ''}`;
        pendingDeltas.set(event.requestId, entry);
        if (!flushTimer) {
          flushTimer = window.setTimeout(() => {
            flushTimer = 0;
            applyPendingDeltas();
          }, 80);
        }
        return;
      }
      if (flushTimer) {
        window.clearTimeout(flushTimer);
        flushTimer = 0;
      }
      applyPendingDeltas();
      if (event?.usage) setAgentContextUsage(event.usage);
      setAgentMessages((previous) => previous.map((message) => {
        if (message.requestId !== event?.requestId || message.role !== 'assistant') return message;
        if (event.type === 'status') {
          return { ...message, status: event.text || message.status, streaming: true };
        }
        if (event.type === 'usage') {
          return { ...message, usage: event.usage || message.usage };
        }
        if (event.type === 'tool') {
          return {
            ...message,
            toolEvents: upsertAgentToolEvent(message.toolEvents, event.tool),
            segments: appendToolToSegments(message.segments, (event.tool as { id?: unknown } | undefined)?.id),
            streaming: true
          };
        }
        if (event.type === 'done') {
          // answer 与 segments 是两个有意的不同投影，别当成"漏回写 segments"的 bug：
          // segments 给界面渲染（流式已累积完整、含全过程交错），done 不动它；
          // answer 给「下一轮回传模型的历史」，这里用后端的最终回答（模型真实最后一步输出）覆盖前端流式拼的版本，
          // 让历史逐字节稳定、命中 prompt 前缀缓存。只覆盖 answer 不回写 segments 是刻意的。
          return {
            ...message,
            answer: event.answer || message.answer || '',
            diffCount: Number.isFinite(Number(event.diffCount)) ? Number(event.diffCount) : message.diffCount,
            usage: event.usage || message.usage,
            status: '完成',
            streaming: false
          };
        }
        return message;
      }));
    });
    return () => {
      if (flushTimer) window.clearTimeout(flushTimer);
      unsubscribe?.();
    };
  }, []);

  async function saveSettings(next?: AgentRecord | null) {
    const seq = agentSettingsSaveSeqRef.current + 1;
    agentSettingsSaveSeqRef.current = seq;
    const merged = { ...(agentSettings || {}), ...(next || {}) };
    setAgentSettings(merged);
    try {
      const updated = await agentRepository.saveSettings(merged) as AgentRecord;
      if (agentSettingsSaveSeqRef.current !== seq) return null;
      setAgentSettings(updated);
      return updated;
    } catch (error: unknown) {
      setNotice?.((error as { message?: string }).message || '');
      return null;
    }
  }

  async function refreshSessions() {
    if (!agentRepository.canListSessions()) return [];
    const sessions = await agentRepository.listSessions({ limit: 60 }) as unknown;
    const list = Array.isArray(sessions) ? sessions as AgentRecord[] : [];
    setAgentSessions(list);
    return list;
  }

  function newSession() {
    setActiveAgentSessionId(null);
    setAgentMessages([]);
  }

  async function loadSession(sessionId: unknown) {
    if (!agentRepository.canGetSession()) return;
    try {
      const session = await agentRepository.getSession({ sessionId }) as AgentRecord | null;
      if (!session) return;
      setActiveAgentSessionId(session.id);
      setAgentMessages(agentMessagesFromSession(session) as AgentRecord[]);
      const sessionUsage = (session.result as { usage?: unknown } | null | undefined)?.usage;
      if (sessionUsage) setAgentContextUsage(sessionUsage);
    } catch (error: unknown) {
      setNotice?.((error as { message?: string }).message || '');
    }
  }

  async function deleteSession(sessionId: unknown) {
    if (!agentRepository.canDeleteSession()) return;
    const ok = window.confirm('删除这个 Agent 会话记录？待审变更不会被自动应用。');
    if (!ok) return;
    try {
      const result = await agentRepository.deleteSession({ sessionId }) as AgentRecord;
      setAgentSessions(Array.isArray(result?.sessions) ? result.sessions : []);
      if (Number(activeAgentSessionId) === Number(sessionId)) newSession();
    } catch (error: unknown) {
      setNotice?.((error as { message?: string }).message || '');
    }
  }

  return useMemo(() => ({
    settings: agentSettings,
    messages: agentMessages,
    diffs: agentDiffs,
    sessions: agentSessions,
    activeSessionId: activeAgentSessionId,
    busy: agentBusy,
    contextUsage: agentContextUsage,
    saveSettings,
    refreshSessions,
    newSession,
    loadSession,
    deleteSession,
    setSettings: setAgentSettings,
    setMessages: setAgentMessages,
    setDiffs: setAgentDiffs,
    setBusy: setAgentBusy,
    setContextUsage: setAgentContextUsage,
    setActiveSessionId: setActiveAgentSessionId,
    agentSettingsSaveSeqRef
  }), [
    activeAgentSessionId,
    agentBusy,
    agentContextUsage,
    agentDiffs,
    agentMessages,
    agentSessions,
    agentSettings,
    setNotice
  ]);
}
