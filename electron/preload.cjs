const { contextBridge, ipcRenderer } = require('electron');

let menuHandler = null;

ipcRenderer.on('menu:action', (_event, action) => {
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
  minimizeWindow: wrap('window:minimize'),
  toggleMaximizeWindow: wrap('window:toggleMaximize'),
  closeWindow: wrap('window:close'),
  openEntityMaintenanceWindow: wrap('entity:openMaintenanceWindow'),
  getLauncherState: wrap('launcher:state'),
  startMainApp: wrap('launcher:start'),
  deleteLauncherDoc: wrap('launcher:deleteDoc'),
  startupHeartbeat: (payload) => ipcRenderer.send('startup:heartbeat', payload),
  getStartupOptions: wrap('startup:options'),
  captureE2EWindow: wrap('e2e:captureWindow'),
  reportStartupSuccess: wrap('startup:success'),
  reportStartupFailure: wrap('startup:failure'),
  debugLog: wrap('debug:log'),
  readLibraryTree: wrap('library:readTree'),
  moveLibraryEntry: wrap('library:move'),
  runDatabaseCommand: wrap('database:run'),
  readDatabase: wrap('database:read'),
  writeDatabase: wrap('database:write'),
  readSourcePdfData: wrap('source:readPdfData'),
  readSourcePdfHighlights: wrap('source:readPdfHighlights'),
  readSourcePdfSpanRects: wrap('source:readPdfSpanRects'),
  generateNodeSummary: wrap('summary:generateNode'),
  cancelNodeSummary: wrap('summary:cancelNode'),
  createImageAsset: wrap('asset:createImage'),
  resolveImageSources: wrap('asset:resolveImageSources'),
  chooseImportFile: wrap('import:chooseFile'),
  importLibraryDocument: wrap('import:libraryDocument'),
  readVectorSettings: wrap('settings:readVector'),
  saveVectorSettings: wrap('settings:saveVector'),
  readLlmSummarySettings: wrap('settings:readLlmSummary'),
  saveLlmSummarySettings: wrap('settings:saveLlmSummary'),
  readAgentSettings: wrap('settings:readAgent'),
  saveAgentSettings: wrap('settings:saveAgent'),
  readNodeLayoutSettings: wrap('settings:readNodeLayout'),
  saveNodeLayoutSettings: wrap('settings:saveNodeLayout'),
  chooseLocalModelRoot: wrap('settings:chooseLocalModelRoot'),
  downloadVectorModel: wrap('settings:downloadVectorModel'),
  sendEmbeddingBatchResult: (payload) => ipcRenderer.send('embedding:batch:result', payload),
  sendEmbeddingBatchProgress: (payload) => ipcRenderer.send('embedding:batch:progress', payload),
  onEmbeddingBatchRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('embedding:batch:request', listener);
    return () => ipcRenderer.removeListener('embedding:batch:request', listener);
  },
  setMenuHandler: (handler) => { menuHandler = handler; },
  onProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('op:progress', listener);
    return () => ipcRenderer.removeListener('op:progress', listener);
  },
  onLibraryChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('library:changed', listener);
    return () => ipcRenderer.removeListener('library:changed', listener);
  },
  onAgentStream: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:stream', listener);
    return () => ipcRenderer.removeListener('agent:stream', listener);
  },
  runAgent: wrap('agent:run'),
  cancelAgent: wrap('agent:cancel'),
  listAgentDiffs: wrap('agent:diffs'),
  listAgentSessions: wrap('agent:sessions'),
  getAgentSession: wrap('agent:session'),
  deleteAgentSession: wrap('agent:deleteSession'),
  applyAgentDiff: wrap('agent:applyDiff'),
  rejectAgentDiff: wrap('agent:rejectDiff')
});
