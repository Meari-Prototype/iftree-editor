// @ts-nocheck
// IPC channel 名集中表——main（注册/推送侧）与 preload（暴露/监听侧）共用。
// 抽出来防两边字符串拼写错位：main 改了 channel 名 preload 不知道 = 调用静默失败。

export default {
  // launcher
  LAUNCHER_STATE: 'launcher:state',
  LAUNCHER_START: 'launcher:start',
  LAUNCHER_DELETE_DOC: 'launcher:deleteDoc',

  // window
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggleMaximize',
  WINDOW_CLOSE: 'window:close',

  // entity
  ENTITY_OPEN_MAINTENANCE_WINDOW: 'entity:openMaintenanceWindow',

  // startup
  STARTUP_HEARTBEAT: 'startup:heartbeat',
  STARTUP_OPTIONS: 'startup:options',
  STARTUP_SUCCESS: 'startup:success',
  STARTUP_FAILURE: 'startup:failure',

  // debug / e2e
  DEBUG_LOG: 'debug:log',
  E2E_CAPTURE_WINDOW: 'e2e:captureWindow',

  // settings
  SETTINGS_READ_VECTOR: 'settings:readVector',
  SETTINGS_SAVE_VECTOR: 'settings:saveVector',
  SETTINGS_READ_MEMORY: 'settings:readMemory',
  SETTINGS_SAVE_MEMORY: 'settings:saveMemory',
  SETTINGS_READ_LLM_SUMMARY: 'settings:readLlmSummary',
  SETTINGS_SAVE_LLM_SUMMARY: 'settings:saveLlmSummary',
  SETTINGS_READ_AGENT: 'settings:readAgent',
  SETTINGS_SAVE_AGENT: 'settings:saveAgent',
  SETTINGS_READ_NODE_LAYOUT: 'settings:readNodeLayout',
  SETTINGS_SAVE_NODE_LAYOUT: 'settings:saveNodeLayout',
  SETTINGS_CHOOSE_LOCAL_MODEL_ROOT: 'settings:chooseLocalModelRoot',
  SETTINGS_DOWNLOAD_VECTOR_MODEL: 'settings:downloadVectorModel',

  // library
  LIBRARY_READ_TREE: 'library:readTree',
  LIBRARY_MOVE: 'library:move',
  LIBRARY_CHANGED: 'library:changed',

  // database
  DATABASE_READ: 'database:read',
  DATABASE_RUN: 'database:run',
  DATABASE_WRITE: 'database:write',

  // source
  SOURCE_READ_PDF_DATA: 'source:readPdfData',
  SOURCE_READ_PDF_HIGHLIGHTS: 'source:readPdfHighlights',
  SOURCE_READ_PDF_SPAN_RECTS: 'source:readPdfSpanRects',

  // summary
  SUMMARY_GENERATE_NODE: 'summary:generateNode',
  SUMMARY_CANCEL_NODE: 'summary:cancelNode',

  // agent
  AGENT_RUN: 'agent:run',
  AGENT_CANCEL: 'agent:cancel',
  AGENT_DIFFS: 'agent:diffs',
  AGENT_SESSIONS: 'agent:sessions',
  AGENT_SESSION: 'agent:session',
  AGENT_DELETE_SESSION: 'agent:deleteSession',
  AGENT_APPLY_DIFF: 'agent:applyDiff',
  AGENT_REJECT_DIFF: 'agent:rejectDiff',
  AGENT_STREAM: 'agent:stream',

  // asset
  ASSET_CREATE_IMAGE: 'asset:createImage',
  ASSET_RESOLVE_IMAGE_SOURCES: 'asset:resolveImageSources',

  // import
  IMPORT_CHOOSE_FILE: 'import:chooseFile',
  IMPORT_LIBRARY_DOCUMENT: 'import:libraryDocument',
  IMPORT_SMART_TASK: 'import:smartTask',

  // main → renderer push
  OP_PROGRESS: 'op:progress',
  MENU_ACTION: 'menu:action'
};
