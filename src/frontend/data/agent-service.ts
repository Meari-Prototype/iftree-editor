import { callIftree, hasIftreeMethod, onAgentStream } from './iftree-api.js';
import { settingsRepository } from './settings-service.js';
import type {
  AgentBranch,
  AgentSession,
  AgentSettingsLike,
  AgentToolEvent,
  AgentUsage
} from '../lib/agent-utils.js';

type AgentPayload = Record<string, unknown>;
export interface AgentStreamEvent {
  type: 'delta' | 'reasoning' | 'status' | 'usage' | 'tool' | 'done' | string;
  requestId: string;
  text?: string;
  answer?: string;
  diffCount?: number;
  usage?: AgentUsage | null;
  tool?: AgentToolEvent;
}

export interface AgentDeleteSessionResult {
  ok: boolean;
  sessions: AgentSession[];
}

export interface AgentDiffMutationResult {
  ok?: boolean;
  diffs?: AgentBranch[];
  result?: Record<string, unknown>;
}

type AgentStreamCallback = (event: AgentStreamEvent) => void;

export const agentRepository = {
  onStream(callback: AgentStreamCallback) {
    return onAgentStream(callback);
  },

  canStream() {
    return hasIftreeMethod('onAgentStream');
  },

  saveSettings(settings: AgentSettingsLike): Promise<AgentSettingsLike> {
    return settingsRepository.saveAgentSettings(settings) as Promise<AgentSettingsLike>;
  },

  runAgentRequest(payload: AgentPayload) {
    return callIftree('runAgent', payload);
  },

  cancelAgentRequest(payload: AgentPayload) {
    return callIftree('cancelAgent', payload);
  },

  canCancelAgentRequest() {
    return hasIftreeMethod('cancelAgent');
  },

  listDiffs() {
    return callIftree<AgentBranch[]>('listAgentDiffs');
  },

  applyDiff(payload: AgentPayload) {
    return callIftree<AgentDiffMutationResult>('applyAgentDiff', payload);
  },

  rejectDiff(payload: AgentPayload) {
    return callIftree<AgentDiffMutationResult>('rejectAgentDiff', payload);
  },

  listSessions(payload: AgentPayload) {
    return callIftree<AgentSession[]>('listAgentSessions', payload);
  },

  canListSessions() {
    return hasIftreeMethod('listAgentSessions');
  },

  getSession(payload: AgentPayload) {
    return callIftree<AgentSession | null>('getAgentSession', payload);
  },

  canGetSession() {
    return hasIftreeMethod('getAgentSession');
  },

  deleteSession(payload: AgentPayload) {
    return callIftree<AgentDeleteSessionResult>('deleteAgentSession', payload);
  },

  canDeleteSession() {
    return hasIftreeMethod('deleteAgentSession');
  }
};
