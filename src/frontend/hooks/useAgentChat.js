import { useEffect, useMemo, useRef, useState } from 'react';

import { agentMessagesFromSession, upsertAgentToolEvent } from '../lib/agent-utils.mjs';
import { agentRepository } from '../data/repositories.js';

export function useAgentChat({ setNotice } = {}) {
  const [agentSettings, setAgentSettings] = useState(null);
  const [agentMessages, setAgentMessages] = useState([]);
  const [agentDiffs, setAgentDiffs] = useState([]);
  const [agentSessions, setAgentSessions] = useState([]);
  const [activeAgentSessionId, setActiveAgentSessionId] = useState(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentContextUsage, setAgentContextUsage] = useState(null);
  const agentSettingsSaveSeqRef = useRef(0);

  useEffect(() => {
    if (!agentRepository.canStream()) return undefined;
    return agentRepository.onStream((event) => {
      if (event?.usage) setAgentContextUsage(event.usage);
      setAgentMessages((previous) => previous.map((message) => {
        if (message.requestId !== event?.requestId || message.role !== 'assistant') return message;
        if (event.type === 'delta') {
          return {
            ...message,
            answer: `${message.answer || ''}${event.text || ''}`,
            status: '正在回复...',
            streaming: true
          };
        }
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
            streaming: true
          };
        }
        if (event.type === 'done') {
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
  }, []);

  async function saveSettings(next) {
    const seq = agentSettingsSaveSeqRef.current + 1;
    agentSettingsSaveSeqRef.current = seq;
    const merged = { ...(agentSettings || {}), ...(next || {}) };
    setAgentSettings(merged);
    try {
      const updated = await agentRepository.saveSettings(merged);
      if (agentSettingsSaveSeqRef.current !== seq) return null;
      setAgentSettings(updated);
      return updated;
    } catch (error) {
      setNotice?.(error.message);
      return null;
    }
  }

  async function refreshSessions() {
    if (!agentRepository.canListSessions()) return [];
    const sessions = await agentRepository.listSessions({ limit: 60 });
    const list = Array.isArray(sessions) ? sessions : [];
    setAgentSessions(list);
    return list;
  }

  function newSession() {
    setActiveAgentSessionId(null);
    setAgentMessages([]);
  }

  async function loadSession(sessionId) {
    if (!agentRepository.canGetSession()) return;
    try {
      const session = await agentRepository.getSession({ sessionId });
      if (!session) return;
      setActiveAgentSessionId(session.id);
      setAgentMessages(agentMessagesFromSession(session));
      if (session.result?.usage) setAgentContextUsage(session.result.usage);
    } catch (error) {
      setNotice?.(error.message);
    }
  }

  async function deleteSession(sessionId) {
    if (!agentRepository.canDeleteSession()) return;
    const ok = window.confirm('删除这个 Agent 会话记录？待审变更不会被自动应用。');
    if (!ok) return;
    try {
      const result = await agentRepository.deleteSession({ sessionId });
      setAgentSessions(Array.isArray(result?.sessions) ? result.sessions : []);
      if (Number(activeAgentSessionId) === Number(sessionId)) newSession();
    } catch (error) {
      setNotice?.(error.message);
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
