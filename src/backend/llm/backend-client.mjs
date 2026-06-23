// 统一后端通信 SDK（解耦第 10 步 / projectneed 18-6-1 / §4.1 目标架构）：所有入口——渲染进程宿主
// （electron main）、外部 agent（mcp-server）、内嵌 agent——都经这一个 SDK 与共享后端 host 通信。
// SDK 把「怎么跟后端通信」的处理逻辑（连接、请求信封、流式订阅、请求观测）全收在这里，调用方只调
// 语义方法、内部不再散写 request('database.read', {...})。SDK 之下是纯后端，谁调都行、不依赖前端。
//
// 连接方式按入口裁剪（mode）：
//   - shared（默认，主进程 / mcp-server 写档）：连命名管道复用同一个共享后端，连不上自拉起、回退私有。
//   - private（mcp-server 只读档）：各起私有 stdio 后端，并发读安全、互不抢占。
// 请求观测（onDebug）也按入口裁剪：主进程注入（记每次请求 start/end），mcp-server 不注入。
import { createSharedBackendClient } from './backend-pipe-client.mjs';
import { createHeadlessAgentClient } from './headless-agent-client.mjs';

export function createBackendClient({
  projectRoot = null,
  hostScriptPath = null,
  processPath = process.execPath,
  mode = 'shared',
  env = process.env,
  onStderr = null,
  onStatus = null,
  onDebug = null
} = {}) {
  if (!projectRoot) throw new Error('createBackendClient requires projectRoot');
  // processPath 决定 host 跑什么 runtime（路 B）：默认跟随父进程 execPath（mcp-server 由 node 起即 node host）；
  // electron 主进程显式传真 node 路径，让 host 跑 node ABI、主进程自身不再 in-process 用 better-sqlite3。
  const transport = mode === 'private'
    ? createHeadlessAgentClient({ cwd: projectRoot, scriptPath: hostScriptPath, processPath, env, onStderr: onStderr || undefined })
    : createSharedBackendClient({ projectRoot, hostScriptPath, processPath, env, onStderr, onStatus });

  // 唯一的出站点：可选 onDebug 包住 transport.request 做计时 + start/end 观测（消除调用方各抄一套的
  // try/catch+计时模板）。requestOptions 透传给传输层（onEvent 流式回调原样转发，不在 SDK 缓冲）。
  async function call(type, body = {}, requestOptions = undefined) {
    if (!onDebug) return transport.request(type, body, requestOptions);
    const startedAt = Date.now();
    onDebug({ type, phase: 'start', body });
    try {
      const result = await transport.request(type, body, requestOptions);
      onDebug({ type, phase: 'end', ok: true, ms: Date.now() - startedAt, body, result });
      return result;
    } catch (error) {
      onDebug({ type, phase: 'end', ok: false, ms: Date.now() - startedAt, body, error });
      throw error;
    }
  }

  return {
    // —— 数据库 ——
    databaseRead: (payload = {}) => call('database.read', { payload }),
    databaseWrite: (payload = {}) => call('database.write', { payload }),
    databaseRun: (command = {}, fallbackOperation = 'read') => call('database.run', { commandPayload: command || {}, fallbackOperation }),
    dbShell: (argv = [], extra = {}) => call('db.shell', { argv, ...extra }),
    updateSourceBinding: (payload = {}) => call('database.updateSourceBinding', { payload }),

    // —— source 只读（路 B：前端去 native，PDF 原件/高亮走后端 RPC）——
    readPdfData: (docId) => call('source.readPdfData', { payload: { docId } }),
    readPdfHighlights: (payload = {}) => call('source.readPdfHighlights', { payload }),
    readPdfSpanRects: (docId) => call('source.readPdfSpanRects', { payload: { docId } }),

    // —— 导入 / 库 ——
    importLibraryDocument: (payload = {}) => call('import.libraryDocument', { payload }),
    smartImportTask: (payload = {}) => call('import.smartTask', { payload }),
    deleteImportedDocument: (payload = {}) => call('import.deleteDocument', { payload }),
    updateImportedSourcePaths: (payload = {}) => call('library.updateImportedSourcePaths', { payload }),

    // —— 派生索引（向量）——
    resetVectorStore: (payload = {}) => call('vector.resetStore', { payload }),
    ensureDocVectors: (payload = {}, requestOptions) => call('vector.ensureDoc', { payload }, requestOptions),

    // —— 摘要 ——
    generateNodeSummary: (payload = {}) => call('summary.generateNode', { payload }),
    cancelNodeSummary: (payload = {}) => call('summary.cancelNode', { payload }),

    // —— 记忆运维 ——
    purgeOrphanedMemory: (options = {}) => call('memory.purgeOrphaned', options),

    // —— 内嵌 agent ——
    runAgent: (payload = {}, requestOptions) => call('agent.run', { payload }, requestOptions),
    runAgentTool: (payload = {}) => call('agent.tool', { payload }),
    cancelAgent: (payload = {}) => call('agent.cancel', { payload }),
    listAgentDiffs: () => call('agent.diffs', {}),
    listAgentSessions: (payload = {}) => call('agent.sessions', { payload }),
    getAgentSession: (payload = {}) => call('agent.session', { payload }),
    deleteAgentSession: (payload = {}) => call('agent.deleteSession', { payload }),
    applyAgentDiff: (payload) => call('agent.applyDiff', { payload }),
    rejectAgentDiff: (payload) => call('agent.rejectDiff', { payload }),

    // —— 生命周期 + 兜底 ——
    ping: () => call('ping', {}),
    // 兜底透传：尚未语义化的请求类型直接发（迁移期保险口；理想是逐步收成上面的具名方法）。
    request: (type, body = {}, requestOptions) => call(type, body, requestOptions),
    shutdown: () => transport.shutdown(),
    close: () => transport.close(),
    get pid() {
      return transport.pid;
    },
    // restart_backend 强杀共享后端要的 pid（已连接取 ready 帧 pid、未连接回退描述文件）——必须经 SDK
    // 透传，否则 mcp-server 走 SDK 时取到 undefined、restart 永远误判「未启动」漏杀游离后端（private
    // transport 无共享后端概念、回退 null：私有 stdio 后端由 shutdown() 关，不靠 pid 强杀）。
    get sharedBackendPid() {
      return transport.sharedBackendPid ?? null;
    },
    get mode() {
      return transport.mode ?? mode;
    }
  };
}
