import { callIftree, hasIftreeMethod, onAgentStream } from './iftree-api.js';
import { settingsRepository } from './settings-service.js';

type AgentPayload = Record<string, unknown>;
type AgentStreamCallback = (event: unknown) => void;

export const agentRepository = {
  onStream(callback: AgentStreamCallback) {
    return onAgentStream(callback);
  },

  canStream() {
    return hasIftreeMethod('onAgentStream');
  },

  saveSettings(settings: AgentPayload) {
    return settingsRepository.saveAgentSettings(settings);
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
    return callIftree('listAgentDiffs');
  },

  applyDiff(payload: AgentPayload) {
    return callIftree('applyAgentDiff', payload);
  },

  rejectDiff(payload: AgentPayload) {
    return callIftree('rejectAgentDiff', payload);
  },

  listSessions(payload: AgentPayload) {
    return callIftree('listAgentSessions', payload);
  },

  canListSessions() {
    return hasIftreeMethod('listAgentSessions');
  },

  getSession(payload: AgentPayload) {
    return callIftree('getAgentSession', payload);
  },

  canGetSession() {
    return hasIftreeMethod('getAgentSession');
  },

  deleteSession(payload: AgentPayload) {
    return callIftree('deleteAgentSession', payload);
  },

  canDeleteSession() {
    return hasIftreeMethod('deleteAgentSession');
  }
};
