// @ts-nocheck
import { contextBridge, ipcRenderer } from 'electron';
import channels from './ipc-channels.js';

let menuHandler = null;

ipcRenderer.on(channels.MENU_ACTION, (_event, action) => {
  if (menuHandler) menuHandler(action);
});

function wrap(channel) {
  return (...args) => ipcRenderer.invoke(channel, ...args).catch((err) => {
    const msg = String(err?.message || err || '');
    if (msg.includes('could not be cloned') || msg.includes('克隆') || msg.includes('circular') || msg.includes('stringify')) {
      throw new Error('操作失败：数据通信异常，请重启应用后重试');
    }
    throw err;
  });
}

contextBridge.exposeInMainWorld('iftree', {
  minimizeWindow: wrap(channels.WINDOW_MINIMIZE),
  toggleMaximizeWindow: wrap(channels.WINDOW_TOGGLE_MAXIMIZE),
  closeWindow: wrap(channels.WINDOW_CLOSE),
  openEntityMaintenanceWindow: wrap(channels.ENTITY_OPEN_MAINTENANCE_WINDOW),
  getLauncherState: wrap(channels.LAUNCHER_STATE),
  startMainApp: wrap(channels.LAUNCHER_START),
  deleteLauncherDoc: wrap(channels.LAUNCHER_DELETE_DOC),
  startupHeartbeat: (payload) => ipcRenderer.send(channels.STARTUP_HEARTBEAT, payload),
  getStartupOptions: wrap(channels.STARTUP_OPTIONS),
  captureE2EWindow: wrap(channels.E2E_CAPTURE_WINDOW),
  reportStartupSuccess: wrap(channels.STARTUP_SUCCESS),
  reportStartupFailure: wrap(channels.STARTUP_FAILURE),
  debugLog: wrap(channels.DEBUG_LOG),
  readLibraryTree: wrap(channels.LIBRARY_READ_TREE),
  moveLibraryEntry: wrap(channels.LIBRARY_MOVE),
  runDatabaseCommand: wrap(channels.DATABASE_RUN),
  readDatabase: wrap(channels.DATABASE_READ),
  writeDatabase: wrap(channels.DATABASE_WRITE),
  readSourcePdfData: wrap(channels.SOURCE_READ_PDF_DATA),
  readSourcePdfHighlights: wrap(channels.SOURCE_READ_PDF_HIGHLIGHTS),
  readSourcePdfSpanRects: wrap(channels.SOURCE_READ_PDF_SPAN_RECTS),
  generateNodeSummary: wrap(channels.SUMMARY_GENERATE_NODE),
  cancelNodeSummary: wrap(channels.SUMMARY_CANCEL_NODE),
  createImageAsset: wrap(channels.ASSET_CREATE_IMAGE),
  resolveImageSources: wrap(channels.ASSET_RESOLVE_IMAGE_SOURCES),
  chooseImportFile: wrap(channels.IMPORT_CHOOSE_FILE),
  importLibraryDocument: wrap(channels.IMPORT_LIBRARY_DOCUMENT),
  smartImportTask: wrap(channels.IMPORT_SMART_TASK),
  readVectorSettings: wrap(channels.SETTINGS_READ_VECTOR),
  saveVectorSettings: wrap(channels.SETTINGS_SAVE_VECTOR),
  readMemorySettings: wrap(channels.SETTINGS_READ_MEMORY),
  saveMemorySettings: wrap(channels.SETTINGS_SAVE_MEMORY),
  readLlmSummarySettings: wrap(channels.SETTINGS_READ_LLM_SUMMARY),
  saveLlmSummarySettings: wrap(channels.SETTINGS_SAVE_LLM_SUMMARY),
  readAgentSettings: wrap(channels.SETTINGS_READ_AGENT),
  saveAgentSettings: wrap(channels.SETTINGS_SAVE_AGENT),
  readNodeLayoutSettings: wrap(channels.SETTINGS_READ_NODE_LAYOUT),
  saveNodeLayoutSettings: wrap(channels.SETTINGS_SAVE_NODE_LAYOUT),
  chooseLocalModelRoot: wrap(channels.SETTINGS_CHOOSE_LOCAL_MODEL_ROOT),
  downloadVectorModel: wrap(channels.SETTINGS_DOWNLOAD_VECTOR_MODEL),
  setMenuHandler: (handler) => { menuHandler = handler; },
  onProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channels.OP_PROGRESS, listener);
    return () => ipcRenderer.removeListener(channels.OP_PROGRESS, listener);
  },
  onLibraryChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on(channels.LIBRARY_CHANGED, listener);
    return () => ipcRenderer.removeListener(channels.LIBRARY_CHANGED, listener);
  },
  onAgentStream: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channels.AGENT_STREAM, listener);
    return () => ipcRenderer.removeListener(channels.AGENT_STREAM, listener);
  },
  runAgent: wrap(channels.AGENT_RUN),
  cancelAgent: wrap(channels.AGENT_CANCEL),
  listAgentDiffs: wrap(channels.AGENT_DIFFS),
  listAgentSessions: wrap(channels.AGENT_SESSIONS),
  getAgentSession: wrap(channels.AGENT_SESSION),
  deleteAgentSession: wrap(channels.AGENT_DELETE_SESSION),
  applyAgentDiff: wrap(channels.AGENT_APPLY_DIFF),
  rejectAgentDiff: wrap(channels.AGENT_REJECT_DIFF)
});
