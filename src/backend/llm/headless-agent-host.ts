import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { createDatabaseService } from '../database-service.js';
import { createDerivedIndexReconciler } from '../derived-index-reconciler.js';
import {
  eventVolumeAnchorDir,
  illegalEventVolumeMessage,
  isLegalEventVolumeLayout,
  PLACEHOLDER_TENANT,
  PLACEHOLDER_WORKSPACE,
  purgeOrphanedMemoryVolumes as purgeMemoryVolumes
} from '../memory/index.js';
import { createLibraryDocumentService } from '../import-service.js';
import { runDbShellArgv, resolveDocRef } from '../db-shell.js';
import { normalizeStableId } from '../db/ids.js';
import { AgentStore } from '../../agent/agent-store.js';
import {
  DEFAULT_VECTOR_CONFIG,
  normalizeVectorConfig
} from '../../vector/embeddings.js';
import { createEmbeddingService } from '../../vector/embedding-service.js';
import { createSummaryService } from './summary.js';
import { loadPromptCatalog, renderPrompt } from '../../lang/index.js';
import { createAgentRuntime, volumeNodesFromTurnMessages } from './agent-runtime.js';
import { messagesFromClaudeTranscript } from '../../core/session-transcript.js';
import {
  createLlmSettingsReader,
  readDotEnv
} from './settings.js';
import {
  createLibraryFs,
  createLlmWorkspace,
  normalizeLibraryRelativePath
} from '../library-fs.js';

const DEFAULT_TREE_SLICE_DEPTH = 1;

interface StrippedTreeNode {
  id: unknown;
  doc_id: unknown;
  parent_id: unknown;
  sort_order: unknown;
  node_type: unknown;
  text: unknown;
  node_title: unknown;
  node_note: unknown;
  source_position: unknown;
  child_count: unknown;
  trust_level: unknown;
  created_at: unknown;
  updated_at: unknown;
  address: unknown;
  children: StrippedTreeNode[];
}

interface TreeNodeLike {
  id?: unknown;
  doc_id?: unknown;
  parent_id?: unknown;
  sort_order?: unknown;
  node_type?: unknown;
  text?: unknown;
  node_title?: unknown;
  node_note?: unknown;
  source_position?: unknown;
  child_count?: unknown;
  trust_level?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  address?: unknown;
  children?: TreeNodeLike[];
}

function stripTree(node: TreeNodeLike | null | undefined): StrippedTreeNode | null {
  if (!node) return null;
  return {
    id: node.id,
    doc_id: node.doc_id,
    parent_id: node.parent_id,
    sort_order: node.sort_order,
    node_type: node.node_type,
    text: node.text,
    node_title: node.node_title,
    node_note: node.node_note,
    source_position: node.source_position,
    child_count: node.child_count,
    trust_level: node.trust_level,
    created_at: node.created_at,
    updated_at: node.updated_at,
    address: node.address,
    children: (node.children || [])
      .map((child) => stripTree(child))
      .filter((child): child is StrippedTreeNode => child !== null)
  };
}

export interface HeadlessAgentHostOptions {
  projectRoot?: string;
  enqueueWrite?: ((task: () => unknown) => unknown) | null;
  sendEvent?: ((event: Record<string, unknown>) => void) | null;
  fetchers?: () => unknown[];
}

interface MaintenanceCapableStore {
  maintenance?: {
    setSerialize?: (enqueue: (task: () => unknown) => unknown) => void;
    register: (name: string, handler: () => unknown) => void;
    start: () => void;
  } | null;
}

type RequestEnvelope = Record<string, unknown> & {
  type?: unknown;
  method?: unknown;
  command?: unknown;
  id?: unknown;
  argv?: unknown[];
  currentDocId?: unknown;
  docId?: unknown;
  databaseCommand?: Record<string, unknown>;
  commandPayload?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  fallbackOperation?: 'read' | 'write';
  dryRun?: boolean;
};

type RequestHandler = (request: RequestEnvelope) => unknown;

export interface HeadlessAgentHost {
  handleRequest(request?: RequestEnvelope): Promise<unknown>;
  close(): void;
}

export function createHeadlessAgentHost(options: HeadlessAgentHostOptions = {}): HeadlessAgentHost {
  const projectRoot = resolve(options.projectRoot || process.cwd());
  const enqueueWrite = typeof options.enqueueWrite === 'function' ? options.enqueueWrite : null;
  const libraryRoot = process.env.IFTREE_LIBRARY_ROOT || join(projectRoot, 'library');
  const workspaceRoot = join(projectRoot, '.iftree-llm-workspace');
  const workspaceBin = join(workspaceRoot, '.bin');
  const databaseRoot = join(projectRoot, 'database');
  const configPath = join(projectRoot, 'iftree.config.json');
  const envPath = join(projectRoot, '.env');
  // .env 作为统一配置入口：headless 子进程继承 MCP server 的 process.env，而 MCP
  // server 不加载 .env 文件，导致读 process.env 的项（如嵌入后端 IFTREE_EMBED_*）
  // 拿不到 .env 配置。这里在子进程内把 .env 灌进 process.env，只填未显式设置的键
  // （不覆盖外部注入），restart_backend 即可让 .env 生效，无需重连 MCP。
  for (const [dotEnvKey, dotEnvValue] of Object.entries(readDotEnv(envPath))) {
    if (process.env[dotEnvKey] === undefined && dotEnvValue !== undefined) process.env[dotEnvKey] = dotEnvValue;
  }
  type DatabaseService = ReturnType<typeof createDatabaseService>;
  let database: DatabaseService | null = null;
  let agentStore: AgentStore | null = null;
  type AgentRuntime = ReturnType<typeof createAgentRuntime>;
  let agentRuntime: AgentRuntime | null = null;
  let llmWorkspaceState: ReturnType<ReturnType<typeof createLlmWorkspace>['refreshLlmWorkspaceState']> | null = null;
  const dbShellState: Record<string, unknown> = {};
  let vectorConfigCache: ReturnType<typeof normalizeVectorConfig> | null = null;
  const streamRequestIds = new Map<string, unknown>();

  interface ProjectConfig {
    debugLogging?: boolean;
    [extra: string]: unknown;
  }

  function readProjectConfig(): ProjectConfig {
    if (!existsSync(configPath)) return {};
    try {
      return (JSON.parse(readFileSync(configPath, 'utf8')) as ProjectConfig) || {};
    } catch {
      return {};
    }
  }

  // LLM 调试日志（debug 功能）：开关同主进程——IFTREE_DEBUG_LOGGING=1 或项目配置 debugLogging=true；
  // 开启时把 agent 的每次 LLM 请求/响应原文逐行写入 .iftree-debug/agent-<起始时刻>.jsonl，
  // 便于排查"上下文拼接 / 模型实际输出"。请求 body 不含 api key（key 在 HTTP header，不入日志）。
  // 日志层异常一律吞掉，绝不影响 agent 运行。
  const debugSessionStamp = new Date().toISOString().replace(/[:.]/g, '-');
  function agentDebugLoggingEnabled(): boolean {
    return process.env.IFTREE_DEBUG_LOGGING === '1' || readProjectConfig().debugLogging === true;
  }
  function agentDebugLog(event: string, payload: Record<string, unknown> = {}): void {
    if (!agentDebugLoggingEnabled()) return;
    try {
      const dir = join(projectRoot, '.iftree-debug');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const line = `${JSON.stringify({ ts: new Date().toISOString(), event, ...payload })}\n`;
      appendFileSync(join(dir, `agent-${debugSessionStamp}.jsonl`), line);
    } catch {
      // debug 日志绝不影响 agent 运行
    }
  }

  // LLM 三套设置（shared/summary/agent + 策略）统一走共享读取器；
  // 进程特异的只有 envPath/configPath 两个事实。
  const llmSettings = createLlmSettingsReader({ envPath, configPath, readProjectConfig });
  const {
    readAgentSettings,
    agentApiFromPayload,
    activeLlmSummaryApi
  } = llmSettings;

  // provider 选择逻辑（.env 直连覆盖 / 共享 provider / 独立摘要 provider / legacy env）已下沉到
  // settings.mjs 的 createLlmSettingsReader，从上面 llmSettings 解构取用（解耦第 2 步）。

  // 提示词/文案读取走语言模块（src/lang）：每次取时读 system_prompt.md 解析成目录
  // （md 小、保持「改后即时生效」、无需重启）。systemPromptSection 保留同名薄适配——
  // summary 与注入 agent 框架处沿用它，实现改为「按键取值 + {{占位}} 插值 + 缺省回退」。
  const getPromptCatalog = () => loadPromptCatalog(projectRoot);
  const systemPromptSection = (name: string, fallback: string = ''): string => renderPrompt(getPromptCatalog(), name, {}, fallback);

  // 摘要子系统已下沉到 ./summary.mjs（解耦第 1b 步）：host 只注入「摘要 API 配置读取 / 提示词目录 /
  // 外部 fetch」，提示词拼装与 provider 协议调用收在模块内。requestHandlers 的 summary.* 转调它。
  const summaryService = createSummaryService({
    activeLlmSummaryApi: activeLlmSummaryApi as never,
    getPromptCatalog,
    fetchers: (() => options.fetchers?.() || []) as never
  });

  function ensureLibraryRoot(): string {
    mkdirSync(libraryRoot, { recursive: true });
    return libraryRoot;
  }

  const libraryFs = createLibraryFs({ ensureRoot: ensureLibraryRoot });
  const { libraryPath, listLibraryChildren, libraryRelativePathForAgent } = libraryFs;

  function normalizeAgentLibraryPath(value: unknown = ''): string {
    const raw = String(value || '').trim();
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
      throw new Error('Agent 本地文件路径必须是 library 工作区相对路径');
    }
    return normalizeLibraryRelativePath(raw);
  }

  const llmWorkspace = createLlmWorkspace({ workspaceRoot, workspaceBin, projectRoot, readProjectConfig });

  function refreshLlmWorkspaceState() {
    llmWorkspaceState = llmWorkspace.refreshLlmWorkspaceState();
    return llmWorkspaceState;
  }

  function dbPath(): string {
    return process.env.IFTREE_DB || join(databaseRoot, 'store.sqlite');
  }

  function agentDbPath(): string {
    return join(databaseRoot, 'agent.sqlite');
  }

  function appHome(): string {
    // 默认锚工作区内（与 dbPath/agentDbPath 同根 databaseRoot），不再回落用户主目录 ~/.iftree。
    // 早期布局曾把向量/settings 放 ~/.iftree，导致 IFTREE_HOME 未设时向量库与 SQLite 分家
    // （SQLite 在工作区、向量回落 C 盘空库）。显式 IFTREE_HOME 仍可 override（压测等场景）。
    return process.env.IFTREE_HOME || databaseRoot;
  }

  function settingsPath(): string {
    return join(appHome(), 'settings.json');
  }

  interface UserSettings {
    vector?: { enabled?: boolean; [extra: string]: unknown };
    memory?: { enabled?: boolean; [extra: string]: unknown };
    [extra: string]: unknown;
  }

  function readSettingsFile(): UserSettings {
    try {
      return (JSON.parse(readFileSync(settingsPath(), 'utf8').replace(/^﻿/, '')) as UserSettings) || {};
    } catch {
      return {};
    }
  }

  function isVectorModuleEnabled(settings: UserSettings = readSettingsFile()): boolean {
    const configured = settings?.vector?.enabled;
    return configured !== false;
  }

  // 记忆子系统开关（projectneed 15-10-5）：默认关闭，与向量模块并列。
  // 关闭时内置 agent 不挂载记忆常驻指令（见 agent-runtime 的 memory.schema gate）。
  function isMemoryEnabled(settings: UserSettings = readSettingsFile()): boolean {
    return settings?.memory?.enabled === true;
  }

  function lanceDbPath(): string {
    return join(appHome(), 'vectors', 'nodes.lance');
  }

  function getVectorConfig() {
    if (!vectorConfigCache) {
      const settings = readSettingsFile();
      vectorConfigCache = normalizeVectorConfig(settings.vector || DEFAULT_VECTOR_CONFIG);
    }
    return vectorConfigCache;
  }

  // 嵌入计算已下沉到 src/vector/embedding-service.mjs（解耦第 1a 步）：host 只注入向量配置读取与模块开关，
  // 本地 transformers 推理 / 远近后端选择 / 嵌入入口 / token 计数收在模块内。derivedIndexes 用它的 embed / countTokens。
  const embeddingService = createEmbeddingService({ getVectorConfig, isVectorModuleEnabled });

  const derivedIndexes = createDerivedIndexReconciler({
    lanceDbPath,
    getStore: () => getDatabase().getStore() as never,
    getVectorConfig,
    isVectorModuleEnabled,
    vectorDisabledMessage: '向量模块已由用户禁用',
    embedTexts: embeddingService.embed,
    countTokens: embeddingService.countTokens
  });

  // 启动后台回填 docs.meta.semantic（读取侧改读这一列后，存量文档需一次性补上、否则显示退化）。
  // fire-and-forget：延到微任务、不阻塞初始化，单文档失败在内部吞掉。
  Promise.resolve().then(() => derivedIndexes.backfillDocSemanticMeta()).catch(() => {});

  function databaseReadContext() {
    return derivedIndexes.readContext();
  }

  function memoryAnchorTargetWorkspace(anchor: unknown): { targetPath: string; workspace: string } {
    const raw = String(anchor || '');
    const targetPath = raw.split('#')[0].trim();
    const matched = targetPath.match(/[\\/]\.claude[\\/]projects[\\/]([^\\/]+)[\\/]/);
    return { targetPath, workspace: matched ? matched[1] : '' };
  }

  function sanitizeAnchorSegment(value: unknown, fallback: string): string {
    const text = String(value || '').replace(/[\\/:*?"<>|]+/g, '_').trim();
    // 纯 . / .. 是路径跳转（join 会规约、.. 能逃出 .memory 锚目录），空段同样非法——一律落占位 fallback，
    // 再由 isLegalEventVolumeLayout 当占位拦下报错（健壮性：畸形 agent/工作区不许穿透成目录跳转）。
    if (!text || text === '.' || text === '..') return fallback;
    return text;
  }

  interface WriteMemoryAnchorInput {
    docId?: unknown;
    agent?: unknown;
    sessionId?: unknown;
    hostAnchor?: unknown;
  }

  // 记忆卷库内实体锚（projectneed 15-10-4）：library/.memory/<身份>/<工作区>/<会话>.jsonl
  // 作 symlink 指向宿主原始记录（jsonl / agent.sqlite，允许悬空）；无可用目标则落真实占位文件，绝不留无锚。
  // 建链后写 source_documents；任何失败抛出，由调用方回滚删卷（无锚即拒，15-10-4）。
  function writeMemoryAnchor({ docId, agent, sessionId, hostAnchor }: WriteMemoryAnchorInput = {}): string {
    if (!docId) throw new Error('writeMemoryAnchor requires docId');
    const { targetPath, workspace } = memoryAnchorTargetWorkspace(hostAnchor);
    const tenant = sanitizeAnchorSegment(agent, PLACEHOLDER_TENANT);
    const ws = sanitizeAnchorSegment(workspace, PLACEHOLDER_WORKSPACE);
    const dir = eventVolumeAnchorDir(libraryRoot, tenant, ws);
    mkdirSync(dir, { recursive: true });
    const linkPath = join(dir, `${sanitizeAnchorSegment(sessionId, 'session')}.jsonl`);
    try {
      if (lstatSync(linkPath)) rmSync(linkPath, { force: true });
    } catch {
      // 锚位不存在即可，直接建
    }
    // 不空卷直接造（projectneed 15-10-4）：事件卷必须锚定真实 session 文件，去掉悬空占位兜底——
    // targetPath 的存在性由 deliverVolume 的 sessionVolumeNodes（existsSync）先行校验，这里是落库前的双保险。
    if (!targetPath || !existsSync(targetPath)) {
      throw new Error(`session 文件不存在、无法锚定：${targetPath || '(空)'}（不接受悬空锚，projectneed 15-10-4）`);
    }
    symlinkSync(targetPath, linkPath, 'file');
    (getDatabase().getStore() as { setMemoryAnchorSource: (docId: unknown, linkPath: string) => unknown }).setMemoryAnchorSource(docId, linkPath);
    // 多租户隔离校验（projectneed 15-10-4）：锚落占位目录（_local / unknown-agent）即结构非法。锚已写、
    // 卷已落库——抛 illegalMemoryLayout 让投递报错但不回滚（卷留下由用户迁移或清理），绝不静默接受游离 / 跨 agent 混放。
    if (!isLegalEventVolumeLayout(tenant, ws)) {
      const error = new Error(illegalEventVolumeMessage({ tenant, workspace: ws, linkPath })) as Error & { illegalMemoryLayout?: boolean };
      error.illegalMemoryLayout = true;
      throw error;
    }
    return linkPath;
  }

  // 事件卷投递的纯规则解析（projectneed 15-10）：读 hostAnchor 指向的真实 session 文件、启发式解析成
  // turn messages、转成卷节点——与内置 agent 落卷同一条 volumeNodesFromTurnMessages 路径，确定可重复。
  // 文件不存在/解析不出对话即抛（不空卷直接造）。memory 模块经此 ctx 拿节点、不直接碰 fs/llm。
  function sessionVolumeNodes(hostAnchor: unknown) {
    const { targetPath } = memoryAnchorTargetWorkspace(hostAnchor);
    if (!targetPath) throw new Error('事件卷必须提供 hostAnchor 指向真实 session 文件（不接受悬空锚，projectneed 15-10-4）');
    if (!existsSync(targetPath)) throw new Error(`session 文件不存在、无法导入：${targetPath}`);
    const nodes = volumeNodesFromTurnMessages(messagesFromClaudeTranscript(readFileSync(targetPath, 'utf8')) as never);
    if (!nodes.length) throw new Error(`session 文件解析不出任何对话回合、无法成卷：${targetPath}`);
    return nodes;
  }

  function databaseWriteContext() {
    return {
      refreshDoc,
      writeMemoryAnchor,
      sessionVolumeNodes,
      ...derivedIndexes.writeContext()
    };
  }

  function getAgentStore(): AgentStore {
    if (!agentStore) agentStore = new AgentStore(agentDbPath());
    return agentStore;
  }

  interface RefreshDocOptions {
    full?: boolean;
    maxTreeDepth?: number | null;
    includeSourceSpans?: boolean;
    includeSourceDocumentContent?: boolean;
    includeNodes?: boolean;
  }

  interface DocFetchResult {
    doc: Record<string, unknown>;
    nodes: Array<Record<string, unknown>>;
    tree: TreeNodeLike | null;
    axioms: Array<Record<string, unknown>>;
    refs: Array<Record<string, unknown>>;
    history: Array<Record<string, unknown>>;
    sourceDocument?: Record<string, unknown> | null;
    sourcePdfPages?: Array<Record<string, unknown>>;
    sourceSpans?: Array<Record<string, unknown>>;
    treeDepthStats?: Record<string, unknown> | null;
    idByAddress: Record<string, unknown>;
  }

  function refreshDoc(docId: unknown, options: RefreshDocOptions = {}): Record<string, unknown> | null {
    const data = (getDatabase().getStore() as {
      getDoc: (docId: unknown, options: Record<string, unknown>) => DocFetchResult | null;
    }).getDoc(docId, {
      maxTreeDepth: options.full === true ? null : (options.maxTreeDepth || DEFAULT_TREE_SLICE_DEPTH),
      includeSourceSpans: options.includeSourceSpans === true,
      includeSourceDocumentContent: options.includeSourceDocumentContent === true
    });
    if (!data) return null;
    return {
      doc: { ...data.doc },
      nodes: options.includeNodes === true ? data.nodes.map((node) => ({ ...node })) : [],
      tree: data.tree ? stripTree(data.tree) : null,
      axioms: data.axioms.map((item) => ({ ...item })),
      refs: data.refs.map((item) => ({ ...item })),
      history: data.history.map((item) => ({ ...item })),
      sourceDocument: data.sourceDocument ? { ...data.sourceDocument } : null,
      sourcePdfPages: (data.sourcePdfPages || []).map((item) => ({ ...item })),
      sourceSpans: options.includeSourceSpans === true ? (data.sourceSpans || []).map((item) => ({ ...item })) : [],
      treeDepthStats: data.treeDepthStats ? { ...data.treeDepthStats } : null,
      idByAddress: { ...data.idByAddress }
    };
  }

  function notifyLibraryChanged(): void {
    options.sendEvent?.({ type: 'library.changed' });
  }

  // 维护接线：scheduler 在主库（store）位置、只派发信号。这里注册向量模块的 handler（自给自足），注入
  // 单写队列做硬串行，并启动后台 tick。主库自己的 handler 已在 IftreeStore 构造时注册（互不内联）。
  function attachMaintenance(store: MaintenanceCapableStore): void {
    if (!store?.maintenance) return;
    if (enqueueWrite) store.maintenance.setSerialize?.(enqueueWrite);
    store.maintenance.register('derived', () => derivedIndexes.runMaintenance());
    store.maintenance.start();
  }

  function getDatabase(): DatabaseService {
    if (!database) {
      database = createDatabaseService({
        dbPath: dbPath(),
        libraryRoot,
        readContext: databaseReadContext,
        writeContext: databaseWriteContext,
        seed: (store: MaintenanceCapableStore) => attachMaintenance(store)
      } as Parameters<typeof createDatabaseService>[0]);
    }
    return database;
  }

  // 已导入库文档生命周期（导入 / 删除 / 库文件移动后源路径重写）已下沉到 import-service 的
  // createLibraryDocumentService（解耦第 1c 步）：host 只注入 store / 写信封 / 派生索引维护 / 刷新 /
  // library 通知 / 路径解析，落库仍直接走 store 整篇建库能力。解构出同名句柄，下方注入与注册表沿用。
  const libraryDocService = createLibraryDocumentService({
    getStore: () => getDatabase().getStore() as never,
    runWrite: (payload) => getDatabase().run({ operation: 'write', payload }, 'write') as Promise<{ ok?: boolean; changed?: unknown } | null | undefined>,
    maintainDerivedAfterWrite: derivedIndexes.maintainDerivedAfterWrite,
    refreshDoc: refreshDoc as (docId: string, options?: Record<string, unknown>) => Record<string, unknown>,
    notifyLibraryChanged,
    libraryPath,
    treeSliceDepth: DEFAULT_TREE_SLICE_DEPTH
  });
  const { importLibraryDocument, smartImportTask, deleteImportedDocument, updateImportedSourcePaths } = libraryDocService;

  // 记忆卷校验扫除（projectneed 15-10-4）：清除「实体锚已被人工删除」的卷。
  // 判据 = 锚的库内路径本身是否还在（lstatSync 不解引用 symlink）：
  //   · 人工删掉 .memory 下的锚文件 → 路径不存在 → 脱锚、清除（这是用户表达「删此卷」的动作）；
  //   · 合法卷的悬空 symlink（target 没了、链接还在，15-10-2 允许悬空）→ 链接本身在 → 保留；
  //   · 没带 hostAnchor 的占位文件 → 文件还在 → 保留（同属 15-10-2 允许的悬空锚）。
  // 删除走正规链路：先删 source 行解锚（deleteDoc 守卫据此放行），再 deleteImportedDocument
  // 连带清 SQLite（refs/nodes/source 行）；LanceDB 派生索引不在此碰，留给自检/reconcile 对齐。
  // 解锚与删卷非同一事务，但可重入：中途中断留下的「无 source 行」卷下轮扫描仍按脱锚清除。
  async function purgeOrphanedMemoryVolumes({ dryRun = false }: { dryRun?: boolean } = {}) {
    // 转发给 memory 模块，注入 host 的文件系统判断（lstat 不解引用）与正规删除入口。
    return purgeMemoryVolumes(getDatabase().getStore() as never, {
      anchorExists: anchorPathExists,
      deleteDoc: deleteImportedDocument,
      dryRun
    } as never);
  }

  // lstatSync 不解引用：路径本身（含悬空 symlink、空占位文件）存在即视为「锚还在」，
  // 仅当锚文件被真正删除（lstat 抛 ENOENT）才判脱锚。
  function anchorPathExists(anchorPath: string): boolean {
    try {
      return Boolean(lstatSync(anchorPath));
    } catch {
      return false;
    }
  }

  function sendAgentStream(requestId: unknown, event: Record<string, unknown>): void {
    const id = streamRequestIds.get(String(requestId));
    options.sendEvent?.({
      id,
      type: 'agent.stream',
      event: { requestId, ...event }
    } as Record<string, unknown>);
  }

  function getAgentRuntime(): AgentRuntime {
    if (!agentRuntime) {
      // host 实际签名（refreshDoc(docId: unknown, options?) → Record<string, unknown> | null；sdk.request body: Record<string, unknown>）
      // 与 AgentRuntimeDeps（refreshDoc(docId: string) → AgentDoc | null；body: AnyRecord）结构同质但 TS narrow 差异——
      // 单点 as unknown as 必要边界 cast，让对象字面量从 host 形态映射到 agent runtime 真签名。
      agentRuntime = createAgentRuntime({
        // in-process SDK 句柄：agent 框架经它发 request 信封访问后端（与外部 agent 经 MCP 同契约），
        // 不再直连 database 实例。封装 host 的 handleRequest、in-process 直调，保持流式回调与单进程。
        sdk: { request: (type: string, body: Record<string, unknown> = {}) => handleRequest({ type, ...body }) },
        getAgentStore,
        refreshDoc,
        readAgentSettings,
        agentApiFromPayload,
        systemPromptSection,
        isMemoryEnabled,
        sendAgentStream,
        fetchers: () => options.fetchers?.() || [],
        libraryPath,
        listLibraryChildren,
        normalizeAgentLibraryPath,
        libraryRelativePathForAgent,
        llmWorkspacePath: () => workspaceRoot,
        llmWorkspaceBinPath: () => workspaceBin,
        llmWorkspaceStatus: () => llmWorkspaceState || refreshLlmWorkspaceState(),
        notifyLibraryChanged,
        updateImportedSourcePaths,
        debugLog: agentDebugLog
      } as unknown as Parameters<typeof createAgentRuntime>[0]);
    }
    return agentRuntime;
  }

  async function runAgent(payload: Record<string, unknown> = {}, requestId: unknown = ''): Promise<unknown> {
    const agentRequestId = String(payload.requestId || requestId || `headless-${Date.now()}`).trim();
    streamRequestIds.set(agentRequestId, requestId);
    try {
      // ask_agent 的 docId 可传文档标题（与 find 对齐）：标题→docId，唯一即定位、重名抛候选 UUID、未找到报错；
      // 选填，空则不限定文档；合法 UUID 原样通过。MCP(agent.run) 与 CLI(askAgent) 都汇入此处，一处解析覆盖两路。
      let nextPayload = payload;
      if (payload.docId != null && String(payload.docId).trim() !== '') {
        nextPayload = { ...payload, docId: await resolveDocRef(getDatabase() as never, payload.docId) };
      }
      const runtime = getAgentRuntime() as unknown as { runAgent: (payload: Record<string, unknown>) => Promise<unknown> };
      return await runtime.runAgent({ ...nextPayload, requestId: agentRequestId });
    } finally {
      streamRequestIds.delete(agentRequestId);
    }
  }

  // 薄 dispatch 注册表（解耦第 10 步）：请求类型 → 处理函数。host 是编排层，每个 handler 接 request、
  // 调对应域模块（store / import / vector / summary / agent / memory），自身不含业务。加动词＝加一项、不接 if 链。
  const requestHandlers: Record<string, RequestHandler> = {
    ping: () => ({ ok: true, pid: process.pid }),
    'db.shell': (request) => runDbShellArgv(getDatabase() as never, ((request.argv as unknown[]) || []) as never, {
      currentDocId: request.currentDocId ?? request.docId,
      shellState: dbShellState,
      importLibraryDocument,
      deleteImportedDocument,
      ensureDocVectors: (payload: Record<string, unknown> = {}) => {
        const docId = normalizeStableId(payload.docId ?? payload.doc_id, null);
        if (!docId) throw new Error('db vectors requires docId');
        return derivedIndexes.ensureDocVectors(docId);
      },
      askAgent: (payload: Record<string, unknown> = {}) => runAgent(payload, request.id),
      agentTool: (payload: Record<string, unknown> = {}) => (getAgentRuntime() as unknown as { runTool: (p: Record<string, unknown>) => unknown }).runTool(payload)
    } as never),
    'database.run': (request) => getDatabase().run((request.databaseCommand || request.commandPayload || request.payload || {}) as never, (request.fallbackOperation || 'read') as 'read' | 'write'),
    'database.read': (request) => getDatabase().run({ operation: 'read', payload: request.payload || {} } as never, 'read'),
    'database.write': (request) => getDatabase().run({ operation: 'write', payload: request.payload || {} } as never, 'write'),
    // source 只读（路 B：前端去 native，PDF 原件/高亮也走后端 RPC，内部调既有 store 方法）。
    'source.readPdfData': (request) => {
      const docId = normalizeStableId((request.payload?.docId as unknown) ?? request.docId, null);
      if (!docId) return null;
      const store = getDatabase().getStore() as { db: { prepare: (sql: string) => { get: (...params: unknown[]) => { source_type?: string; original_path?: string | null } | undefined } } };
      const sourceDocument = store.db.prepare('SELECT * FROM source_documents WHERE doc_id = ?').get(docId);
      if (!sourceDocument || sourceDocument.source_type !== 'pdf' || !sourceDocument.original_path) return null;
      return {
        fileName: basename(sourceDocument.original_path),
        base64: readFileSync(sourceDocument.original_path).toString('base64')
      };
    },
    'source.readPdfHighlights': (request) => {
      const docId = normalizeStableId((request.payload?.docId as unknown) ?? request.docId, null);
      if (!docId) return [];
      const payload = (request.payload || {}) as { ranges?: Array<{ start: unknown; end: unknown }>; startOffset?: unknown; endOffset?: unknown };
      const ranges = Array.isArray(payload.ranges)
        ? payload.ranges
        : [{ start: payload.startOffset, end: payload.endOffset }];
      return (getDatabase().getStore() as { getPdfHighlightRects: (docId: string, ranges: unknown[]) => unknown[] }).getPdfHighlightRects(docId, ranges);
    },
    'source.readPdfSpanRects': (request) => {
      const docId = normalizeStableId((request.payload?.docId as unknown) ?? request.docId, null);
      if (!docId) return [];
      return (getDatabase().getStore() as { getPdfSpanHitRects: (docId: string) => unknown[] }).getPdfSpanHitRects(docId);
    },
    'import.libraryDocument': (request) => importLibraryDocument(request.payload || {}),
    'import.smartTask': (request) => smartImportTask(request.payload || {}),
    'import.deleteDocument': (request) => deleteImportedDocument(request.payload || {}),
    'memory.purgeOrphaned': (request) => purgeOrphanedMemoryVolumes({ dryRun: request.dryRun === true }),
    'database.updateSourceBinding': (request) => (getDatabase() as { updateSourceBinding: (payload: Record<string, unknown>) => unknown }).updateSourceBinding(request.payload || {}),
    'library.updateImportedSourcePaths': (request) => {
      const payload = (request.payload || {}) as { fromPath?: string; from?: string; toPath?: string; to?: string; isDirectory?: boolean };
      updateImportedSourcePaths(payload.fromPath ?? payload.from ?? '', payload.toPath ?? payload.to ?? '', payload.isDirectory === true);
      notifyLibraryChanged();
      return { ok: true };
    },
    'vector.resetStore': async (request) => {
      await derivedIndexes.resetVectorStoreTable(Number((request.payload as { dimensions?: unknown })?.dimensions) || getVectorConfig().dimensions);
      return { ok: true };
    },
    'vector.ensureDoc': (request) => {
      const payload = request.payload || {};
      const docId = normalizeStableId((payload as Record<string, unknown>).docId ?? (payload as Record<string, unknown>).doc_id ?? request.docId ?? (request as Record<string, unknown>).doc_id, null);
      if (!docId) throw new Error('vector.ensureDoc requires docId');
      return derivedIndexes.ensureDocVectors(docId, {
        onProgress: (event) => options.sendEvent?.({
          id: request.id,
          type: 'agent.stream',
          event: { type: 'vector.ensureDoc.progress', ...event }
        } as Record<string, unknown>)
      });
    },
    'summary.generateNode': (request) => summaryService.generateNodeSummary(request.payload || {}),
    'summary.cancelNode': (request) => summaryService.cancelNodeSummary(request.payload || {}),
    'agent.run': (request) => runAgent(request.payload || {}, request.id),
    'agent.tool': (request) => (getAgentRuntime() as unknown as { runTool: (p: Record<string, unknown>) => unknown }).runTool(request.payload || {}),
    'agent.cancel': (request) => (getAgentRuntime() as unknown as { cancelAgentRequest: (p: Record<string, unknown>) => unknown }).cancelAgentRequest(request.payload || {}),
    'agent.diffs': () => (getAgentRuntime() as unknown as { listAgentDiffs: () => unknown }).listAgentDiffs(),
    'agent.sessions': (request) => (getAgentRuntime() as unknown as { listAgentSessions: (p: Record<string, unknown>) => unknown }).listAgentSessions(request.payload || {}),
    'agent.session': (request) => (getAgentRuntime() as unknown as { getAgentSession: (p: Record<string, unknown>) => unknown }).getAgentSession(request.payload || {}),
    'agent.deleteSession': (request) => (getAgentRuntime() as unknown as { deleteAgentSession: (p: Record<string, unknown>) => unknown }).deleteAgentSession(request.payload || {}),
    'agent.applyDiff': (request) => (getAgentRuntime() as unknown as { applyAgentDiff: (p: unknown) => unknown }).applyAgentDiff((request.payload as { diffId?: unknown })?.diffId ?? request.payload),
    'agent.rejectDiff': (request) => (getAgentRuntime() as unknown as { rejectAgentDiff: (p: unknown) => unknown }).rejectAgentDiff((request.payload as { diffId?: unknown })?.diffId ?? request.payload),
    shutdown: () => {
      close();
      return { ok: true };
    }
  };

  async function handleRequest(request: RequestEnvelope = {}): Promise<unknown> {
    const type = String(request.type || request.method || request.command || '').trim();
    const handler = requestHandlers[type];
    if (!handler) throw new Error(`Unknown headless agent request: ${type || '(empty)'}`);
    return handler(request);
  }

  function close(): void {
    if (database) database.close();
    database = null;
    if (agentStore) agentStore.close();
    agentStore = null;
    derivedIndexes.close();
  }

  ensureLibraryRoot();
  llmWorkspace.cleanupExpiredWorkspaceEntries();
  refreshLlmWorkspaceState();

  return {
    handleRequest,
    close
  };
}
