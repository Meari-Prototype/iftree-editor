import { listMemoryVolumes, sealDueMemoryVolumes } from './volumes.js';
import type { IftreeStore } from '../store/index.js';

export const MEMORY_READ_ACTIONS: string[] = ['memory.listVolumes'];

interface MemoryReadPayload {
  state?: string | null;
  agent?: string | null;
  sessionId?: string | null;
  session_id?: string | null;
  limit?: number | string | null;
}

// 记忆卷只读动作（projectneed 15-10）：列卷（开工先看最近发生过什么）。
export function runMemoryRead(store: IftreeStore, payload: MemoryReadPayload = {}, action: string) {
  if (action === 'memory.listVolumes') {
    // 封卷自动化（15-10-1/15-11-5）：列卷时顺手物理封到期卷（末次活动+24h），不再设 seal 动词。
    // 纯时间戳判断、零 LLM；只在可写连接上做（query-db 的只读路径跳过）。
    if (!store.readonly) sealDueMemoryVolumes(store);
    return listMemoryVolumes(store, {
      state: payload.state ?? null,
      agent: payload.agent ?? null,
      sessionId: payload.sessionId ?? payload.session_id ?? null,
      limit: typeof payload.limit === 'number' ? payload.limit : undefined
    });
  }
  throw new Error(`Unhandled memory read action: ${action}`);
}
