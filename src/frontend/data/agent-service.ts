// @ts-nocheck
import { callIftree, hasIftreeMethod, onAgentStream } from './iftree-api.js';
import { settingsRepository } from './settings-service.js';

export const agentRepository = {
  onStream(callback) {
    return onAgentStream(callback);
  },

  canStream() {
    return hasIftreeMethod('onAgentStream');
  },

  saveSettings(settings) {
    return settingsRepository.saveAgentSettings(settings);
  },

  runAgentRequest(payload) {
    return callIftree('runAgent', payload);
  },

  cancelAgentRequest(payload) {
    return callIftree('cancelAgent', payload);
  },

  canCancelAgentRequest() {
    return hasIftreeMethod('cancelAgent');
  },

  listDiffs() {
    return callIftree('listAgentDiffs');
  },

  applyDiff(payload) {
    return callIftree('applyAgentDiff', payload);
  },

  rejectDiff(payload) {
    return callIftree('rejectAgentDiff', payload);
  },

  listSessions(payload) {
    return callIftree('listAgentSessions', payload);
  },

  canListSessions() {
    return hasIftreeMethod('listAgentSessions');
  },

  getSession(payload) {
    return callIftree('getAgentSession', payload);
  },

  canGetSession() {
    return hasIftreeMethod('getAgentSession');
  },

  deleteSession(payload) {
    return callIftree('deleteAgentSession', payload);
  },

  canDeleteSession() {
    return hasIftreeMethod('deleteAgentSession');
  }
};
