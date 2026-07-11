import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import {
  appendFileSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync
} from 'node:fs';
import { once } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenDialogOptions } from 'electron';

import {
  VECTOR_COMPUTE_OPTIONS,
  VECTOR_MODEL_OPTIONS
} from '../src/vector/embeddings.js';
import { normalizeDocMeta, resolveMarkdownImageUrl, workspaceSearchRoots } from '../src/core/image-paths.js';
import { createBackendClient } from '../src/backend/llm/backend-client.js';
import { resolveNodeExecutable } from '../src/backend/llm/backend-discovery.js';
import { normalizeAgentToolSettings } from '../src/backend/llm/defaults.js';
import {
  huggingFaceResolveUrl,
  huggingFaceTreeUrl,
  selectTransformerModelFiles
} from '../src/vector/model-download.js';


import { normalizeImportMode } from '../src/core/import-formats/shared.js';
import { normalizeStableId } from '../src/backend/db/ids.js';
import { debugValueSummary } from '../src/core/debug-summary.js';
import {
  activeLlmApiFromSettings,
  cleanupLegacyLlmEnvValues,
  createLlmSettingsReader,
  llmApiKeyEnvValues,
  stripLlmSecrets
} from '../src/backend/llm/settings.js';
import {
  createLibraryFs,
  createLlmWorkspace,
  normalizeLibraryRelativePath
} from '../src/backend/library/library-fs.js';
import { isSameOrChildPath, pathKey } from '../src/backend/path-utils.js';
import channels from './ipc-channels.js';
// §6-8 拆分：启动器/watchdog、E2E 截图分析、配置读写各自成件，main 只留窗口壳、业务编排与 IPC 装配。
import { createLauncher } from './launcher.js';
import { analyzeE2ECapture, captureZoomedE2EWindow } from './e2e-capture.js';
import { createSettingsIo } from './settings-io.js';
import type { DotEnvMap, ProjectConfig, VectorConfig } from './settings-io.js';

type RowObject = Record<string, unknown>;
type HeadlessAgentClient = ReturnType<typeof createBackendClient>;
type BackendDebugEvent = {
  type?: string;
  phase?: string;
  body?: { payload?: unknown; commandPayload?: unknown };
  ok?: boolean;
  ms?: number;
  result?: unknown;
  error?: unknown;
};
const createLlmSettingsReaderForMain = createLlmSettingsReader as unknown as (options: {
  envPath: string;
  configPath: string;
  readEnv: () => DotEnvMap;
  readProjectConfig: () => ProjectConfig;
}) => ReturnType<typeof createLlmSettingsReader>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const LIBRARY_ROOT = join(PROJECT_ROOT, 'library');
const LLM_WORKSPACE_ROOT = join(PROJECT_ROOT, '.iftree-llm-workspace');
const LLM_WORKSPACE_BIN = join(LLM_WORKSPACE_ROOT, '.bin');
const HEADLESS_AGENT_SCRIPT = join(PROJECT_ROOT, 'dist', 'scripts', 'agent-host.js');
const DATABASE_ROOT = join(PROJECT_ROOT, 'database');
const IS_MAIN_APP_PROCESS = process.env.IFTREE_MAIN_APP === '1';
const FORCE_HARDWARE_ACCELERATION = IS_MAIN_APP_PROCESS && process.env.IFTREE_FORCE_HARDWARE_ACCELERATION !== '0';
const ELECTRON_PROFILE_ROOT = join(PROJECT_ROOT, '.iftree-cache', IS_MAIN_APP_PROCESS ? 'electron-main-profile' : 'electron-launcher-profile');
const DIST_INDEX_PATH = resolve(PROJECT_ROOT, 'dist', 'index.html');
const EXTERNAL_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

mkdirSync(ELECTRON_PROFILE_ROOT, { recursive: true });
app.setPath('userData', ELECTRON_PROFILE_ROOT);
app.commandLine.appendSwitch('disk-cache-dir', join(ELECTRON_PROFILE_ROOT, 'Cache'));
app.commandLine.appendSwitch('gpu-disk-cache-dir', join(ELECTRON_PROFILE_ROOT, 'GPUCache'));

if (FORCE_HARDWARE_ACCELERATION) {
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-oop-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
  app.commandLine.appendSwitch('force_high_performance_gpu');
}

let mainWindow: BrowserWindow | null = null;
let entityMaintenanceWindow: BrowserWindow | null = null;
let mainStartupSucceeded = false;
let headlessAgentClient: HeadlessAgentClient | null = null;
let llmWorkspaceState: unknown = null;
const imageUrlCache = new Map<string, string>();
let libraryWatcher: FSWatcher | null = null;
let libraryWatchTimer: NodeJS.Timeout | null = null;
const VECTOR_MODULE_DISABLED_REASON = '向量模块已由用户禁用';
let cspConfigured = false;

function normalizedPathKey(targetPath: string) {
  return resolve(targetPath).toLowerCase();
}

function configuredStartUrlOrigin() {
  if (!process.env.ELECTRON_START_URL) return '';
  try {
    return new URL(process.env.ELECTRON_START_URL).origin;
  } catch {
    return '';
  }
}

function isDistIndexUrl(url: URL) {
  if (url.protocol !== 'file:') return false;
  try {
    return normalizedPathKey(fileURLToPath(url)) === normalizedPathKey(DIST_INDEX_PATH);
  } catch {
    return false;
  }
}

function isAllowedAppNavigationUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'about:' && url.href === 'about:blank') return true;
    if (isDistIndexUrl(url)) return true;
    const startOrigin = configuredStartUrlOrigin();
    return Boolean(startOrigin && url.origin === startOrigin);
  } catch {
    return false;
  }
}

function isExternalLinkUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return EXTERNAL_LINK_PROTOCOLS.has(url.protocol) && !isAllowedAppNavigationUrl(rawUrl);
  } catch {
    return false;
  }
}

function openExternalLink(rawUrl: string) {
  if (!isExternalLinkUrl(rawUrl)) return;
  shell.openExternal(rawUrl).catch((error) => {
    appendDebugLog('backend', {
      event: 'window.open_external_failed',
      message: (error as { message?: string } | null | undefined)?.message || String(error || ''),
      sourceId: rawUrl
    });
  });
}

function attachExternalNavigationGuards(win: BrowserWindow | null) {
  if (!win || win.isDestroyed()) return;
  const { webContents } = win;
  webContents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (isAllowedAppNavigationUrl(url)) return;
    event.preventDefault();
    openExternalLink(url);
  });
}

function rendererContentSecurityPolicy() {
  const scriptSrc = process.env.ELECTRON_START_URL
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self'";
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: file: http: https:",
    "font-src 'self' data: file:",
    "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'none'"
  ].join('; ');
}

function configureContentSecurityPolicy() {
  if (cspConfigured) return;
  cspConfigured = true;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (String(details.url || '').startsWith('data:')) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const responseHeaders = { ...(details.responseHeaders || {}) };
    for (const key of Object.keys(responseHeaders)) {
      if (key.toLowerCase() === 'content-security-policy') delete responseHeaders[key];
    }
    responseHeaders['Content-Security-Policy'] = [rendererContentSecurityPolicy()];
    callback({ responseHeaders });
  });
}

function sendProgress(data: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channels.OP_PROGRESS, data);
  }
}

function sendAgentStream(requestId: unknown, event: RowObject) {
  if (!requestId || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channels.AGENT_STREAM, { requestId, ...event });
}

function showOpenDialogForMain(options: OpenDialogOptions) {
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showOpenDialog(mainWindow, options)
    : dialog.showOpenDialog(options);
}

// 配置文件读写域（./settings-io.ts，§6-8）：.env / iftree.config.json / settings.json 的读写
// 与 vector/memory/nodeLayout 形状规整都在工厂内；解构成同名函数，调用点不变。
// appHome 是 function 声明有提升，此处引用后文声明是安全的。
const settingsIo = createSettingsIo({ projectRoot: PROJECT_ROOT, appHome });
const {
  projectEnvPath,
  projectConfigPath,
  readDotEnv,
  writeDotEnvValues,
  readProjectConfig,
  writeProjectConfig,
  settingsPath,
  isVectorModuleEnabled,
  memorySettingsPayload,
  getVectorConfig,
  saveVectorSettings,
  saveMemoryConfig,
  nodeLayoutSettingsPayload,
  saveNodeLayoutConfig
} = settingsIo;

// LLM 三套设置读取统一走共享读取器（src/backend/llm/settings.mjs）。
// main 进程注入带缓存的 .env 读取（writeDotEnvValues 写入后置空缓存失效）。
const llmSettings = createLlmSettingsReaderForMain({
  envPath: projectEnvPath(),
  configPath: projectConfigPath(),
  readEnv: readDotEnv,
  readProjectConfig
});
const {
  normalizeLlmSummarySettings,
  readSharedLlmSettings,
  readLlmSummarySettings,
  readAgentSettings
} = llmSettings;

function debugLoggingEnabled() {
  return process.env.IFTREE_DEBUG_LOGGING === '1' || readProjectConfig().debugLogging === true;
}

// 本机时间的 ISO 8601 带时区偏移格式：例 "2026-05-28T15:30:45.123+08:00"
// 既能直观看出本地时间，又保留时区信息可还原 UTC。
function localIsoTimestamp(date = new Date()) {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const offsetTotalMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetTotalMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetTotalMinutes);
  const offsetHours = pad(Math.floor(absOffset / 60));
  const offsetMinutes = pad(absOffset % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${pad(date.getMilliseconds(), 3)}${offsetSign}${offsetHours}:${offsetMinutes}`;
}

// 文件名安全的本地时间戳，用于 .iftree-debug 下的 session 文件名（精度到秒，不含时区后缀）。
// 冒号在 Windows 文件名里非法，统一用 - 替代。
function localFileSafeTimestamp(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}
const DEBUG_SESSION_ID = localFileSafeTimestamp();

function debugLogPath() {
  return join(PROJECT_ROOT, '.iftree-debug', `${DEBUG_SESSION_ID}.jsonl`);
}

function appendDebugLog(source: string, payload: RowObject = {}) {
  if (!debugLoggingEnabled()) return false;
  try {
    const target = debugLogPath();
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${JSON.stringify({
      ts: localIsoTimestamp(),
      pid: process.pid,
      source,
      ...(debugValueSummary(payload) as RowObject)
    })}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function debugErrorSummary(error: unknown) {
  return String((error as { message?: string } | null | undefined)?.message || error || '').slice(0, 240);
}

function normalizeMainDocId(value: unknown, fallback: string | null = null) {
  return normalizeStableId(value, fallback);
}

const DEFAULT_TREE_SLICE_DEPTH = 1;


function writeLlmSummarySettings(payload: RowObject = {}) {
  const current = readLlmSummarySettings();
  const next = normalizeLlmSummarySettings({
    ...current,
    ...payload,
    providers: Array.isArray(payload.providers) ? payload.providers : current.providers
  });
  const config = readProjectConfig();
  const llm = config.llm || {};
  if (next.independent !== true) {
    writeProjectConfig({
      llm: {
        ...llm,
        shared: llm.shared || stripLlmSecrets({
          activeProviderId: next.activeProviderId,
          activeApiId: next.activeApiId,
          providers: next.providers
        }),
        summary: {
          ...(llm.summary || {}),
          independent: false,
          activeArticleSummaryStrategyId: next.activeArticleSummaryStrategyId,
          activeNodeSummaryStrategyId: next.activeNodeSummaryStrategyId,
          summaryConcurrency: next.summaryConcurrency,
          summaryStrategies: next.summaryStrategies
        }
      }
    });
    writeDotEnvValues(cleanupLegacyLlmEnvValues(llmApiKeyEnvValues(next)));
    return readLlmSummarySettings();
  }
  writeProjectConfig({
    llm: {
      ...llm,
      summary: {
        ...stripLlmSecrets({
          activeProviderId: next.activeProviderId,
          activeApiId: next.activeApiId,
          independent: next.independent,
          providers: next.providers,
          summaryStrategies: next.summaryStrategies,
          activeArticleSummaryStrategyId: next.activeArticleSummaryStrategyId,
          activeNodeSummaryStrategyId: next.activeNodeSummaryStrategyId,
          summaryConcurrency: next.summaryConcurrency
        })
      }
    }
  });
  writeDotEnvValues(cleanupLegacyLlmEnvValues(llmApiKeyEnvValues(next)));
  return readLlmSummarySettings();
}

function writeAgentSettings(payload: RowObject = {}) {
  const currentAgent = readAgentSettings();
  const current = readSharedLlmSettings();
  const next = normalizeLlmSummarySettings({
    ...current,
    ...payload,
    providers: Array.isArray(payload.providers) ? payload.providers : current.providers
  });
  const active = activeLlmApiFromSettings(next);
  const config = readProjectConfig();
  writeProjectConfig({
    llm: {
      ...(config.llm || {}),
      shared: stripLlmSecrets({
        activeProviderId: next.activeProviderId,
        activeApiId: next.activeApiId,
        providers: next.providers
      }),
      agent: {
        ...((config.llm || {}).agent || {}),
        personalPrompt: String(payload.personalPrompt ?? currentAgent.personalPrompt ?? ''),
        toolSettings: normalizeAgentToolSettings(payload.toolSettings || currentAgent.toolSettings || {})
      }
    }
  });
  writeDotEnvValues(cleanupLegacyLlmEnvValues({
    ...llmApiKeyEnvValues(next),
    OPENAI_API_KEY: active?.apiKey || ''
  }));
  return readAgentSettings();
}

function appHome() {
  // 默认锚工作区内（与 SQLite 的 DATABASE_ROOT 同根），不再回落用户主目录 ~/.iftree——
  // 否则 IFTREE_HOME 未设时向量/settings 会与 SQLite 分家（SQLite 在工作区、向量回落 C 盘空库）。
  // 显式 IFTREE_HOME 仍可 override（压测等场景）。
  return process.env.IFTREE_HOME || DATABASE_ROOT;
}

function ensureLibraryRoot() {
  mkdirSync(LIBRARY_ROOT, { recursive: true });
  return LIBRARY_ROOT;
}

const llmWorkspace = createLlmWorkspace({
  workspaceRoot: LLM_WORKSPACE_ROOT,
  workspaceBin: LLM_WORKSPACE_BIN,
  projectRoot: PROJECT_ROOT,
  readProjectConfig
});

function refreshLlmWorkspaceState() {
  llmWorkspaceState = llmWorkspace.refreshLlmWorkspaceState();
  return llmWorkspaceState;
}

const libraryFs = createLibraryFs({ ensureRoot: ensureLibraryRoot });
const { libraryPath, listLibraryChildren, libraryRelativePathForAgent } = libraryFs;

function listLibraryTree() {
  const root = ensureLibraryRoot();
  return {
    type: 'folder',
    name: '主文件夹',
    relativePath: '',
    fullPath: root,
    children: listLibraryChildren('')
  };
}

async function moveLibraryEntry(payload: RowObject = {}) {
  const sourceRel = normalizeLibraryRelativePath(String(payload.sourceRelativePath || ''));
  if (!sourceRel) throw new Error('Cannot move the library root');
  const targetFolderRel = normalizeLibraryRelativePath(String(payload.targetFolderRelativePath || ''));
  const source = libraryPath(sourceRel);
  const targetFolder = libraryPath(targetFolderRel);
  const sourceStat = statSync(source);
  if (!statSync(targetFolder).isDirectory()) throw new Error('Move target is not a folder');
  if (sourceStat.isDirectory() && isSameOrChildPath(targetFolder, source)) {
    throw new Error('Cannot move a folder into itself');
  }
  const target = join(targetFolder, parse(source).base);
  if (pathKey(source) === pathKey(target)) return listLibraryTree();
  if (existsSync(target)) throw new Error(`Target already exists: ${parse(source).base}`);
  renameSync(source, target);
  await getHeadlessAgentClient().updateImportedSourcePaths({ fromPath: source, toPath: target, isDirectory: sourceStat.isDirectory() });
  return listLibraryTree();
}

function notifyLibraryChanged() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (libraryWatchTimer) clearTimeout(libraryWatchTimer);
  libraryWatchTimer = setTimeout(() => {
    libraryWatchTimer = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channels.LIBRARY_CHANGED);
    }
  }, 160);
}

function startLibraryWatcher() {
  if (libraryWatcher) return;
  try {
    libraryWatcher = watch(ensureLibraryRoot(), { recursive: true }, notifyLibraryChanged);
  } catch {
    libraryWatcher = null;
  }
}

function stopLibraryWatcher() {
  if (libraryWatchTimer) {
    clearTimeout(libraryWatchTimer);
    libraryWatchTimer = null;
  }
  if (libraryWatcher) {
    libraryWatcher.close();
    libraryWatcher = null;
  }
}

// 数据库三口的请求观测：旧实现在每个 IPC handler 里各抄一套 try/catch + 计时 + start/end；现下沉到
// 统一 SDK 的 onDebug 回调（SDK 出站点统一触发），这里只决定「记什么」——保持只观测数据库读 / 写 /
// 跑三口、沿用既有 event 名（run 记作 database.command）与 debugValueSummary 截断，行为不变。
/** @param {{ type?: string, phase?: string, body?: { payload?: unknown, commandPayload?: unknown }, ok?: boolean, ms?: number, result?: unknown, error?: unknown }} arg */
function backendDebugLogger({ type, phase, body = {}, ok, ms, result, error }: BackendDebugEvent) {
  const spec = {
    'database.read': { event: 'database.read', payload: body.payload },
    'database.write': { event: 'database.write', payload: body.payload },
    'database.run': { event: 'database.command', payload: body.commandPayload }
  }[String(type || '') as 'database.read' | 'database.write' | 'database.run'];
  if (!spec) return;
  if (phase === 'start') {
    appendDebugLog('backend', { event: `${spec.event}.start`, payload: debugValueSummary(spec.payload || {}) });
    return;
  }
  appendDebugLog('backend', {
    event: `${spec.event}.end`,
    ok,
    ms,
    payload: debugValueSummary(spec.payload || {}),
    ...(ok ? { result: debugValueSummary(result || {}) } : { error: debugErrorSummary(error) })
  });
}

// resolveNodeExecutable 已下沉到 backend-discovery，作 createBackendClient 的默认（host 恒 node runtime，
// 与「谁拉起它」解耦）。下方仍显式传 processPath，保留「主进程拉起 host 必须 node ABI」的意图可读。
function getHeadlessAgentClient() {
  if (!headlessAgentClient) {
    // 解耦第 10 步：主进程经统一 backend-client SDK 连共享管道后端（与 mcp-server 写档同一个 host
    // 实例）——发现→连接→连不上自拉起→单机离线回退私有 stdio。主进程从此只调 SDK 的语义方法、
    // 内部不再写连接 / 请求信封 / 日志这些通信处理；退出时 close 在管道模式只断连接、不杀共享后端。
    // 路 B：显式传真 node 作 host runtime（node ABI），主进程自身不再 in-process 用 better-sqlite3。
    headlessAgentClient = createBackendClient({
      projectRoot: PROJECT_ROOT,
      hostScriptPath: HEADLESS_AGENT_SCRIPT,
      processPath: resolveNodeExecutable(),
      mode: 'shared',
      onStderr: (text) => console.error(`[headless-agent] ${String(text || '').trimEnd()}`),
      onStatus: (text) => console.error(`[backend] ${String(text || '').trimEnd()}`),
      onDebug: backendDebugLogger
    });
  }
  return headlessAgentClient;
}

function headlessDatabaseRead<Request extends import('../src/backend/query-api.js').TypedDatabaseReadRequest>(payload: Request): Promise<import('../src/backend/query-api.js').TypedDatabaseReadResult<Request>>;
function headlessDatabaseRead(payload?: unknown): Promise<unknown>;
function headlessDatabaseRead(payload: unknown = {}): Promise<unknown> {
  return getHeadlessAgentClient().databaseRead(payload);
}

function headlessDatabaseWrite(payload: import('../src/backend/mutation-api.js').MutationPayload = {}): Promise<import('../src/backend/mutation-api.js').MutationResult> {
  return getHeadlessAgentClient().databaseWrite(payload) as Promise<import('../src/backend/mutation-api.js').MutationResult>;
}

function headlessDatabaseRun(command: unknown = {}, fallbackOperation = 'read') {
  return getHeadlessAgentClient().databaseRun(command, fallbackOperation);
}

async function ensureHeadlessAgentStarted() {
  const result = await getHeadlessAgentClient().ping() as RowObject;
  console.log(`[headless-agent] started pid=${result?.pid || getHeadlessAgentClient().pid || ''}`);
  return result;
}

function stopHeadlessAgent() {
  if (!headlessAgentClient) return;
  headlessAgentClient.close();
  headlessAgentClient = null;
}

function lanceDbPath() {
  return join(appHome(), 'vectors', 'nodes.lance');
}

function browserModelCachePath() {
  return join(app.getPath('userData'), 'Service Worker', 'CacheStorage');
}

function detectedOllamaBgeM3Path() {
  const path = join(homedir(), '.ollama', 'models', 'manifests', 'registry.ollama.ai', 'library', 'bge-m3');
  return existsSync(path) ? path : '';
}

function vectorSettingsPayload(config: VectorConfig = getVectorConfig(), runtime: RowObject = {}) {
  return {
    ...config,
    enabled: isVectorModuleEnabled(),
    disabledReason: isVectorModuleEnabled() ? '' : VECTOR_MODULE_DISABLED_REASON,
    modelOptions: VECTOR_MODEL_OPTIONS.map((option) => ({ ...option })),
    computeOptions: VECTOR_COMPUTE_OPTIONS.map((option) => ({ ...option })),
    modelCachePath: browserModelCachePath(),
    detectedOllamaBgeM3Path: detectedOllamaBgeM3Path(),
    appHome: appHome(),
    settingsPath: settingsPath(),
    lanceDbPath: lanceDbPath(),
    vectorTable: 'nodes_vec',
    localModelBaseUrl: runtime.localModelBaseUrl || ''
  };
}

async function fetchModelFileList(config: VectorConfig) {
  const response = await fetch(huggingFaceTreeUrl(config.modelName));
  if (!response.ok) {
    throw new Error(`读取 Hugging Face 模型文件列表失败：${response.status} ${response.statusText}`);
  }
  const entries = await response.json();
  const files = selectTransformerModelFiles(entries, config.dtype);
  if (files.length === 0) {
    throw new Error(`未找到 ${config.modelName} 的 ${config.dtype} ONNX 文件`);
  }
  return files;
}

async function downloadFile(url: string, targetPath: string, progress?: (bytes: number) => void) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`下载失败：${response.status} ${response.statusText} ${url}`);
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.download`;
  rmSync(tempPath, { force: true });
  const stream = createWriteStream(tempPath);

  try {
    for await (const chunk of response.body) {
      progress?.(chunk.length || 0);
      if (!stream.write(chunk)) await once(stream, 'drain');
    }
    stream.end();
    await once(stream, 'finish');
    rmSync(targetPath, { force: true });
    renameSync(tempPath, targetPath);
  } catch (error) {
    stream.destroy();
    rmSync(tempPath, { force: true });
    throw error;
  }
}

async function downloadVectorModelToRoot(config: VectorConfig, downloadRoot: string) {
  const root = resolve(downloadRoot);
  mkdirSync(root, { recursive: true });
  const files = await fetchModelFileList(config);
  const total = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  let loaded = 0;
  let currentFile = 0;

  sendProgress({ label: `准备下载 ${config.label}`, step: 0, total: total || files.length });

  for (const file of files) {
    currentFile += 1;
    const targetPath = resolve(root, ...config.modelName.split('/'), ...file.path.split('/'));
    const targetInside = targetPath.startsWith(`${root}${sep}`);
    if (!targetInside) throw new Error(`模型文件路径越界：${file.path}`);

    if (existsSync(targetPath) && (!file.size || statSync(targetPath).size === file.size)) {
      loaded += Number(file.size) || 0;
      sendProgress({
        label: `下载 ${config.label}：${file.path}`,
        step: total ? loaded : currentFile,
        total: total || files.length
      });
      continue;
    }

    await downloadFile(huggingFaceResolveUrl(config.modelName, file.path), targetPath, (bytes: number) => {
      loaded += bytes;
      sendProgress({
        label: `下载 ${config.label}：${file.path}`,
        step: total ? loaded : currentFile,
        total: total || files.length
      });
    });
  }

  sendProgress({ label: `下载 ${config.label}`, step: total || files.length, total: total || files.length, done: true });
  return root;
}

async function resetVectorStoreTable(dimensions: unknown) {
  await getHeadlessAgentClient().resetVectorStore({ dimensions });
}

// 设置落盘走 settings-io（saveVectorSettings）；这里只保留副作用编排——模型/维度/来源变化时
// 重建向量库表（吃后端），设置文件本身怎么写不归 main 管。
async function saveVectorConfig(patch: RowObject = {}) {
  const { previous, next, enabled } = saveVectorSettings(patch);
  const needsReset = previous.modelId !== next.modelId
    || previous.dimensions !== next.dimensions
    || previous.localModelRoot !== next.localModelRoot;
  if (enabled && needsReset) {
    await resetVectorStoreTable(next.dimensions);
  }
  return vectorSettingsPayload(next);
}

function assetsDir(docId: unknown) {
  return join(appHome(), 'assets', `doc-${docId}`);
}

function startupStatusPath() {
  return process.env.IFTREE_STARTUP_STATUS_PATH || join(app.getPath('userData'), 'startup-status.json');
}

function readStartupStatus() {
  try {
    const target = startupStatusPath();
    if (!existsSync(target)) return {};
    return JSON.parse(readFileSync(target, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeStartupStatus(patch = {}) {
  const target = startupStatusPath();
  mkdirSync(dirname(target), { recursive: true });
  const next = {
    ...readStartupStatus(),
    ...patch,
    updatedAt: Date.now()
  };
  writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

function e2eScreenshotPath() {
  if (process.env.IFTREE_E2E_SCREENSHOT_PATH) return process.env.IFTREE_E2E_SCREENSHOT_PATH;
  const parsed = parse(startupStatusPath());
  return join(parsed.dir, `${parsed.name}.png`);
}

function showWindowForE2E(win: BrowserWindow) {
  if (!win || win.isDestroyed()) return;
  if (process.env.IFTREE_E2E_NO_FOCUS === '1' && typeof win.showInactive === 'function') {
    win.showInactive();
    return;
  }
  if (!win.isVisible()) win.show();
  win.focus();
}

// 启动器/watchdog 工厂（./launcher.ts，§6-8）：状态自持，main 只注入设置读写、启动状态文件、
// 后端读通道与窗口工具。function 声明有提升，此处引用后文声明的函数是安全的。
const launcher = createLauncher({
  projectRoot: PROJECT_ROOT,
  preloadPath: join(__dirname, 'preload.cjs'),
  headlessDatabaseRead,
  readProjectConfig,
  writeProjectConfig,
  readStartupStatus,
  writeStartupStatus,
  startupStatusPath,
  appendDebugLog,
  attachExternalNavigationGuards,
  showWindowForE2E
});

async function createWindow() {
  writeStartupStatus({
    startedAt: Number(readStartupStatus().startedAt || Date.now()),
    heartbeatAt: Date.now(),
    success: false,
    failed: false,
    stage: 'main-window-create'
  });
  mainWindow = new BrowserWindow({
    title: '条件树编辑器',
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    frame: false,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#f6f5f2',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox 关：preload.cjs 要 require 本地 ipc-channels.cjs；sandboxed preload 只能
      // require electron 内置模块，会崩在 exposeInMainWorld 之前导致 window.iftree 整个丢失。
      sandbox: false,
      backgroundThrottling: false
    }
  });
  attachExternalNavigationGuards(mainWindow);

  // Electron 32+ 的 console-message：详情字段在 event 对象上，后续位置参数是 deprecated 的旧形态。
  mainWindow.webContents.on('console-message', (event) => {
    appendDebugLog('renderer', {
      event: 'renderer.console',
      level: event.level,
      message: event.message,
      sourceId: event.sourceId,
      lineNumber: event.lineNumber
    });
    if (process.env.IFTREE_DEBUG === '1') {
      console.log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    appendDebugLog('renderer', {
      event: 'renderer.preload_error',
      message: (error as { message?: string } | null | undefined)?.message || String(error || ''),
      sourceId: preloadPath
    });
    console.error(`[preload-error] ${preloadPath}: ${(error as { stack?: string }).stack || (error as { message?: string }).message}`);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    appendDebugLog('renderer', {
      event: 'renderer.did_fail_load',
      errorCode,
      message: errorDescription,
      sourceId: validatedURL
    });
    console.error(`[did-fail-load] ${errorCode} ${errorDescription}: ${validatedURL}`);
    writeStartupStatus({
      failed: true,
      stage: 'did-fail-load',
      failure: {
        message: `${errorCode} ${errorDescription}`,
        stage: validatedURL
      }
    });
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    appendDebugLog('renderer', {
      event: 'renderer.process_gone',
      reason: details?.reason || '',
      exitCode: details?.exitCode ?? null
    });
    console.error(`[render-process-gone] ${JSON.stringify(details)}`);
    if (!mainStartupSucceeded) {
      writeStartupStatus({
        failed: true,
        stage: 'render-process-gone',
        failure: {
          message: '主服务渲染进程崩溃。',
          stage: details?.reason || 'render-process-gone'
        }
      });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  startLibraryWatcher();

  mainWindow.once('ready-to-show', () => {
    console.log('[window] ready-to-show');
    if (mainWindow) showWindowForE2E(mainWindow);
  });

  if (process.env.ELECTRON_START_URL) {
    writeStartupStatus({ heartbeatAt: Date.now(), stage: 'main-window-load-url' });
    await mainWindow.loadURL(process.env.ELECTRON_START_URL);
  } else {
    writeStartupStatus({ heartbeatAt: Date.now(), stage: 'main-window-load-file' });
    await mainWindow.loadFile(DIST_INDEX_PATH);
  }

  if (!mainWindow.isVisible()) {
    console.log('[window] forcing show after load');
    showWindowForE2E(mainWindow);
  }

  console.log(`[window] loaded ${mainWindow.webContents.getURL()}`);
}

async function openEntityMaintenanceWindow(payload: RowObject = {}) {
  const docId = normalizeMainDocId(payload?.docId ?? payload?.doc_id, null);
  if (entityMaintenanceWindow && !entityMaintenanceWindow.isDestroyed()) {
    entityMaintenanceWindow.show();
    entityMaintenanceWindow.focus();
    entityMaintenanceWindow.webContents.send(channels.MENU_ACTION, {
      type: 'entity-maintenance:focus',
      docId
    });
    return { ok: true, reused: true };
  }

  const baseBounds = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow.getBounds()
    : { width: 1440, height: 920 };
  entityMaintenanceWindow = new BrowserWindow({
    title: '实体库维护',
    width: baseBounds.width,
    height: baseBounds.height,
    minWidth: 1100,
    minHeight: 720,
    frame: false,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#f6f5f2',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox 关：preload.cjs 要 require 本地 ipc-channels.cjs；sandboxed preload 只能
      // require electron 内置模块，会崩在 exposeInMainWorld 之前导致 window.iftree 整个丢失。
      sandbox: false,
      backgroundThrottling: false
    }
  });
  attachExternalNavigationGuards(entityMaintenanceWindow);

  entityMaintenanceWindow.on('closed', () => {
    entityMaintenanceWindow = null;
  });

  entityMaintenanceWindow.once('ready-to-show', () => {
    entityMaintenanceWindow?.show();
  });

  if (process.env.ELECTRON_START_URL) {
    const url = new URL(process.env.ELECTRON_START_URL);
    url.searchParams.set('screen', 'entity-maintenance');
    if (docId) url.searchParams.set('docId', String(docId));
    await entityMaintenanceWindow.loadURL(url.toString());
  } else {
    await entityMaintenanceWindow.loadFile(DIST_INDEX_PATH, {
      query: {
        screen: 'entity-maintenance',
        ...(docId ? { docId: String(docId) } : {})
      }
    });
  }

  if (!entityMaintenanceWindow.isVisible()) entityMaintenanceWindow.show();
  return { ok: true, reused: false };
}

async function refreshDoc(docId: unknown, options: RowObject = {}) {
  const data = await headlessDatabaseRead({
    action: 'doc.get',
    docId,
    maxTreeDepth: options.full === true ? null : (options.maxTreeDepth || DEFAULT_TREE_SLICE_DEPTH),
    includeNodes: options.includeNodes === true,
    includeSourceSpans: options.includeSourceSpans === true,
    includeSourceDocumentContent: options.includeSourceDocumentContent === true
  });
  if (!data || typeof data !== 'object') return null;
  const dataObject: RowObject = { ...data };
  const includeNodes = options.includeNodes === true;
  const includeSourceSpans = options.includeSourceSpans === true;
  // Ensure plain JSON-compatible return for IPC
  return {
    doc: { ...((dataObject.doc && typeof dataObject.doc === 'object' ? dataObject.doc : {}) as RowObject) },
    nodes: includeNodes ? ((Array.isArray(dataObject.nodes) ? dataObject.nodes : []) as RowObject[]).map((n) => ({ ...n })) : [],
    tree: dataObject.tree ? stripTree(dataObject.tree as RowObject) : null,
    axioms: ((Array.isArray(dataObject.axioms) ? dataObject.axioms : []) as RowObject[]).map((a) => ({ ...a })),
    refs: ((Array.isArray(dataObject.refs) ? dataObject.refs : []) as RowObject[]).map((r) => ({ ...r })),
    history: ((Array.isArray(dataObject.history) ? dataObject.history : []) as RowObject[]).map((h) => ({ ...h })),
    sourceDocument: dataObject.sourceDocument && typeof dataObject.sourceDocument === 'object' ? { ...(dataObject.sourceDocument as RowObject) } : null,
    sourcePdfPages: ((Array.isArray(dataObject.sourcePdfPages) ? dataObject.sourcePdfPages : []) as RowObject[]).map((p) => ({ ...p })),
    sourceSpans: includeSourceSpans ? ((Array.isArray(dataObject.sourceSpans) ? dataObject.sourceSpans : []) as RowObject[]).map((s) => ({ ...s })) : [],
    treeDepthStats: dataObject.treeDepthStats && typeof dataObject.treeDepthStats === 'object' ? { ...(dataObject.treeDepthStats as RowObject) } : null,
    idByAddress: { ...((dataObject.idByAddress && typeof dataObject.idByAddress === 'object' ? dataObject.idByAddress : {}) as RowObject) }
  };
}

async function importFilePaths(filePaths: unknown[] = [], options: RowObject = {}) {
  const imported: RowObject[] = [];
  const paths = Array.isArray(filePaths) ? filePaths : [];
  for (const filePath of paths) {
    const relativePath = libraryRelativePathForAgent(String(filePath || ''));
    if (!relativePath) throw new Error('请选择 library 文件夹内的文件');
    const result = await getHeadlessAgentClient().importLibraryDocument({
      relativePath,
      mode: options.mode,
      chunkSize: options.chunkSize,
      overlap: options.overlap,
      embed: options.embed
    });
    const resultObject = (result && typeof result === 'object' ? result : {}) as RowObject;
    const docs = Array.isArray(resultObject.imported)
      ? resultObject.imported as RowObject[]
      : [{ docId: resultObject.docId, title: resultObject.title, nodeCount: resultObject.nodeCount }];
    for (const doc of docs) {
      if (!doc?.docId) continue;
      imported.push({
        doc: {
          id: doc.docId,
          title: doc.title || '',
          node_count: doc.nodeCount || 0
        }
      });
    }
  }
  notifyLibraryChanged();
  return imported;
}

function stripTree(node: RowObject | null): RowObject | null {
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
    children: (Array.isArray(node.children) ? node.children as RowObject[] : []).map(stripTree)
  };
}

function registerLauncherIpc() {
  ipcMain.handle(channels.LAUNCHER_STATE, async () => await launcher.launcherState());
  ipcMain.handle(channels.LAUNCHER_START, (_event, payload) => launcher.startMainAppFromLauncher(payload || {}));
  ipcMain.handle(channels.LAUNCHER_DELETE_DOC, async (_event, payload) => {
    const docId = normalizeMainDocId(payload?.docId ?? payload?.doc_id, null);
    if (!docId) throw new Error('deleteDoc requires docId');
    const result = await headlessDatabaseWrite({ action: 'doc.delete', docId });
    launcher.clearLastFailure();
    return {
      ...(await launcher.launcherState()),
      deleteResult: result
    };
  });
}

function registerIpc() {
  ipcMain.handle(channels.WINDOW_MINIMIZE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
    return true;
  });

  ipcMain.handle(channels.WINDOW_TOGGLE_MAXIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });

  ipcMain.handle(channels.WINDOW_CLOSE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
    return true;
  });

  ipcMain.handle(channels.ENTITY_OPEN_MAINTENANCE_WINDOW, (_event, payload) => openEntityMaintenanceWindow(payload || {}));

  ipcMain.on(channels.STARTUP_HEARTBEAT, (_event, payload = {}) => {
    const stage = String(payload?.stage || 'renderer-heartbeat');
    if (stage !== 'renderer-alive') {
      appendDebugLog('renderer', {
        event: 'renderer.startup.heartbeat',
        stage,
        renderMode: process.env.IFTREE_RENDER_MODE || readProjectConfig().renderMode || 'hardware',
        docId: payload?.docId ?? null,
        nodeCount: payload?.nodeCount ?? null,
        renderBackend: payload?.renderBackend || null,
        progress: payload?.progress || null,
        e2e: payload?.e2e || null
      });
    }
    const current = readStartupStatus();
    if (current.success === true) {
      writeStartupStatus({ heartbeatAt: Date.now() });
      return;
    }
    if (current.failed === true) {
      writeStartupStatus({ heartbeatAt: Date.now() });
      return;
    }
    if (stage === 'renderer-alive') {
      writeStartupStatus({ heartbeatAt: Date.now() });
      return;
    }
    writeStartupStatus({
      heartbeatAt: Date.now(),
      stage,
      progress: Object.prototype.hasOwnProperty.call(payload, 'progress') ? (payload.progress || null) : (current.progress || null),
      docId: payload?.docId ?? current.docId ?? null,
      nodeCount: payload?.nodeCount ?? current.nodeCount ?? null,
      renderBackend: payload?.renderBackend || current.renderBackend || null,
      e2e: payload?.e2e || current.e2e || null
    });
  });

  ipcMain.handle(channels.STARTUP_OPTIONS, () => {
    const options = {
      startupDocId: process.env.IFTREE_STARTUP_DOC_ID || null,
      renderMode: process.env.IFTREE_RENDER_MODE || readProjectConfig().renderMode || 'hardware',
      forceHardwareAcceleration: process.env.IFTREE_FORCE_HARDWARE_ACCELERATION !== '0',
      e2eChm: process.env.IFTREE_E2E_CHM === '1',
      debugLogging: debugLoggingEnabled()
    };
    appendDebugLog('backend', {
      event: 'startup.options.read',
      ...options
    });
    return options;
  });

  ipcMain.handle(channels.DEBUG_LOG, (_event, payload = {}) => appendDebugLog('renderer', payload || {}));

  ipcMain.handle(channels.E2E_CAPTURE_WINDOW, async (event, payload = {}) => {
    if (process.env.IFTREE_E2E_CHM !== '1') {
      throw new Error('E2E capture is only available during CHM verification.');
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) throw new Error('E2E capture failed: window is unavailable.');
    const image = await win.webContents.capturePage();
    const target = e2eScreenshotPath();
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, image.toPNG());
    const contentBounds = win.getContentBounds();
    const result = /** @type {Record<string, unknown>} */ ({
      ...analyzeE2ECapture(image, payload?.textProbeRects || [], payload?.edgeProbeRects || [], {
        width: contentBounds.width,
        height: contentBounds.height
      }),
      path: target
    });
    const fontShot = await captureZoomedE2EWindow(win);
    if (fontShot) result.fontShot = fontShot;
    return result;
  });

  ipcMain.handle(channels.STARTUP_SUCCESS, (_event, payload = {}) => {
    mainStartupSucceeded = true;
    appendDebugLog('renderer', {
      event: 'renderer.startup.success',
      stage: String(payload?.stage || 'startup-success'),
      docId: payload?.docId ?? null,
      nodeCount: payload?.nodeCount ?? null,
      renderBackend: payload?.renderBackend || null,
      progress: payload?.progress || null,
      e2e: payload?.e2e || null
    });
    writeStartupStatus({
      heartbeatAt: Date.now(),
      success: true,
      failed: false,
      stage: String(payload?.stage || 'startup-success'),
      progress: payload?.progress || null,
      docId: payload?.docId ?? null,
      nodeCount: payload?.nodeCount ?? null,
      renderBackend: payload?.renderBackend || null,
      e2e: payload?.e2e || null,
      successAt: Date.now(),
      failure: null
    });
    return true;
  });

  ipcMain.handle(channels.STARTUP_FAILURE, (_event, payload = {}) => {
    const failure = {
      message: String(payload?.message || '启动失败，请切换渲染模式、删除异常文档数据后重试。'),
      stage: String(payload?.stage || 'startup-failure'),
      progress: payload?.progress || null
    };
    appendDebugLog('renderer', {
      event: 'renderer.startup.failure',
      stage: failure.stage,
      message: failure.message,
      docId: payload?.docId ?? null,
      nodeCount: payload?.nodeCount ?? null,
      progress: payload?.progress || null
    });
    writeStartupStatus({
      heartbeatAt: Date.now(),
      success: false,
      failed: true,
      stage: failure.stage,
      progress: payload?.progress || null,
      docId: payload?.docId ?? null,
      nodeCount: payload?.nodeCount ?? null,
      failure
    });
    setTimeout(() => app.quit(), 30);
    return true;
  });

  ipcMain.handle(channels.SETTINGS_READ_VECTOR, () => vectorSettingsPayload());
  ipcMain.handle(channels.SETTINGS_READ_MEMORY, () => memorySettingsPayload());
  ipcMain.handle(channels.SETTINGS_SAVE_MEMORY, (_event, patch) => saveMemoryConfig(patch || {}));

  ipcMain.handle(channels.SETTINGS_SAVE_VECTOR, async (_event, payload) => saveVectorConfig(payload || {}));

  ipcMain.handle(channels.SETTINGS_READ_LLM_SUMMARY, () => readLlmSummarySettings());

  ipcMain.handle(channels.SETTINGS_SAVE_LLM_SUMMARY, (_event, payload) => writeLlmSummarySettings(payload || {}));

  ipcMain.handle(channels.SETTINGS_READ_AGENT, () => readAgentSettings());

  ipcMain.handle(channels.SETTINGS_SAVE_AGENT, (_event, payload) => writeAgentSettings(payload || {}));

  ipcMain.handle(channels.SETTINGS_READ_NODE_LAYOUT, () => nodeLayoutSettingsPayload());

  ipcMain.handle(channels.SETTINGS_SAVE_NODE_LAYOUT, (_event, payload) => saveNodeLayoutConfig(payload || {}));

  ipcMain.handle(channels.SETTINGS_CHOOSE_LOCAL_MODEL_ROOT, async () => {
    const result = await showOpenDialogForMain({
      title: '选择本地 ONNX 模型目录',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths?.[0]) return vectorSettingsPayload();
    return saveVectorConfig({ localModelRoot: result.filePaths[0] });
  });

  ipcMain.handle(channels.SETTINGS_DOWNLOAD_VECTOR_MODEL, async () => {
    const config = getVectorConfig();
    const defaultPath = join(appHome(), 'models');
    mkdirSync(defaultPath, { recursive: true });
    const result = await showOpenDialogForMain({
      title: `下载 ${config.label} 模型到本地目录`,
      defaultPath,
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths?.[0]) return vectorSettingsPayload();

    const root = await downloadVectorModelToRoot(config, result.filePaths[0]);
    const nextSettings = await saveVectorConfig({ localModelRoot: root });
    return {
      ...nextSettings,
      downloadedModelPath: join(root, ...config.modelName.split('/'))
    };
  });

  ipcMain.handle(channels.LIBRARY_READ_TREE, () => listLibraryTree());

  ipcMain.handle(channels.LIBRARY_MOVE, (_event, payload) => moveLibraryEntry(payload || {}));

  // 数据库三口：观测（计时 + start/end）已下沉统一 SDK 的 onDebug（backendDebugLogger），handler 只转发。
  ipcMain.handle(channels.DATABASE_READ, (_event, payload) => headlessDatabaseRead(payload || {}));
  ipcMain.handle(channels.DATABASE_RUN, (_event, command) => headlessDatabaseRun(command || {}));
  ipcMain.handle(channels.DATABASE_WRITE, (_event, payload) => headlessDatabaseWrite(payload || {}));

  ipcMain.handle(channels.SOURCE_READ_PDF_DATA, (_event, docId) => {
    const normalizedDocId = normalizeMainDocId(docId, null);
    if (!normalizedDocId) return null;
    return getHeadlessAgentClient().readPdfData(normalizedDocId);
  });

  ipcMain.handle(channels.SOURCE_READ_PDF_HIGHLIGHTS, (_event, payload) => {
    const payloadObject = (payload && typeof payload === 'object' ? payload : {}) as RowObject;
    const docId = normalizeMainDocId(payloadObject.docId, null);
    if (!docId) return [];
    const ranges = Array.isArray(payloadObject.ranges)
      ? payloadObject.ranges
      : [{ start: payloadObject.startOffset, end: payloadObject.endOffset }];
    return getHeadlessAgentClient().readPdfHighlights({ docId, ranges });
  });

  ipcMain.handle(channels.SOURCE_READ_PDF_SPAN_RECTS, (_event, docId) => {
    const normalizedDocId = normalizeMainDocId(docId, null);
    if (!normalizedDocId) return [];
    return getHeadlessAgentClient().readPdfSpanRects(normalizedDocId);
  });

  ipcMain.handle(channels.SUMMARY_GENERATE_NODE, async (_event, payload) => {
    const payloadObject = (payload && typeof payload === 'object' ? payload : {}) as RowObject;
    const requestId = String(payloadObject.requestId || '').trim();
    const reportProgress = !requestId;
    if (reportProgress) sendProgress({ label: '生成摘要...', step: 0, total: 0 });
    try {
      return await getHeadlessAgentClient().generateNodeSummary(payloadObject);
    } finally {
      if (reportProgress) sendProgress({ done: true });
    }
  });
  ipcMain.handle(channels.SUMMARY_CANCEL_NODE, (_event, payload) => {
    const payloadObject = (payload && typeof payload === 'object' ? payload : {}) as RowObject;
    const requestId = String(payloadObject.requestId || '').trim();
    if (!requestId) return { ok: false, canceled: false, reason: 'missing requestId' };
    return getHeadlessAgentClient().cancelNodeSummary({ requestId });
  });

  ipcMain.handle(channels.AGENT_RUN, async (_event, payload) => getHeadlessAgentClient().runAgent(payload || {}, {
    onEvent: (event: RowObject) => sendAgentStream(event.requestId, event)
  }));
  ipcMain.handle(channels.AGENT_CANCEL, (_event, payload) => getHeadlessAgentClient().cancelAgent(payload || {}));

  ipcMain.handle(channels.AGENT_DIFFS, () => getHeadlessAgentClient().listAgentDiffs());
  ipcMain.handle(channels.AGENT_SESSIONS, (_event, payload) => getHeadlessAgentClient().listAgentSessions(payload || {}));
  ipcMain.handle(channels.AGENT_SESSION, (_event, payload) => getHeadlessAgentClient().getAgentSession(payload || {}));
  ipcMain.handle(channels.AGENT_DELETE_SESSION, (_event, payload) => getHeadlessAgentClient().deleteAgentSession(payload || {}));

  ipcMain.handle(channels.AGENT_APPLY_DIFF, (_event, payload) => getHeadlessAgentClient().applyAgentDiff(payload || {}));

  ipcMain.handle(channels.AGENT_REJECT_DIFF, (_event, payload) => getHeadlessAgentClient().rejectAgentDiff(payload || {}));

  ipcMain.handle(channels.ASSET_CREATE_IMAGE, async (_event, payload) => {
    const payloadObject = (payload && typeof payload === 'object' ? payload : {}) as RowObject;
    const result = await showOpenDialogForMain({
      title: '添加图片附件',
      properties: ['openFile'],
      filters: [
        { name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths[0]) return await refreshDoc(payloadObject.docId);

    const source = result.filePaths[0];
    const parsed = parse(source);
    const targetDir = assetsDir(payloadObject.docId);
    mkdirSync(targetDir, { recursive: true });
    const safeName = `${Date.now()}-${parsed.base.replace(/[<>:"/\\|?*]/g, '_')}`;
    const target = join(targetDir, safeName);
    copyFileSync(source, target);

    const node = await headlessDatabaseRead({
      action: 'node.get',
      docId: payloadObject.docId,
      nodeId: payloadObject.nodeId
    });
    const nodeObject = (node && typeof node === 'object' ? node : {}) as RowObject;
    if (!node) throw new Error(`Node not found: ${payloadObject.nodeId}`);
    const relative = `assets/doc-${payloadObject.docId}/${safeName}`;
    const nextText = `${nodeObject.text || ''}\n\n![${parsed.name}](${relative})`.trim();
    await headlessDatabaseWrite({
      action: 'node.update',
      docId: payloadObject.docId,
      nodeId: payloadObject.nodeId,
      text: nextText
    });
    return await refreshDoc(payloadObject.docId);
  });

  ipcMain.handle(channels.ASSET_RESOLVE_IMAGE_SOURCES, async (_event, payload) => {
    const payloadObject = (payload && typeof payload === 'object' ? payload : {}) as RowObject;
    const docId = normalizeMainDocId(payloadObject.docId, null);
    const sources = Array.isArray(payloadObject.sources) ? payloadObject.sources.map((source) => String(source || '')) : [];
    if (!docId || sources.length === 0) return {};

    const info = await headlessDatabaseRead({ action: 'doc.getInfo', docId });
    const infoObject = (info && typeof info === 'object' ? info : {}) as RowObject;
    const infoDoc = (infoObject.doc && typeof infoObject.doc === 'object' ? infoObject.doc : {}) as RowObject;
    const docMeta = normalizeDocMeta(infoDoc.meta as Parameters<typeof normalizeDocMeta>[0]);
    const searchRoots = workspaceSearchRoots(docMeta.sourcePath);
    const resolved: Record<string, string | undefined> = {};

    for (const source of sources) {
      const key = `${docId}\n${source}`;
      if (!imageUrlCache.has(key)) {
        imageUrlCache.set(key, resolveMarkdownImageUrl({
          src: source,
          docMeta,
          appHome: appHome(),
          searchRoots
        }));
      }
      resolved[source] = imageUrlCache.get(key);
    }

    return resolved;
  });

  ipcMain.handle(channels.IMPORT_CHOOSE_FILE, async (_event, payload) => {
    const payloadObject = (payload && typeof payload === 'object' ? payload : {}) as RowObject;
    const mode = normalizeImportMode(payloadObject.mode);
    const result = await showOpenDialogForMain({
      title: '导入 chm、txt、md、pdf 或 docx',
      defaultPath: ensureLibraryRoot(),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '条件树导入文件', extensions: ['chm', 'txt', 'md', 'pdf', 'docx'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (result.canceled) return null;
    return importFilePaths(result.filePaths || [], { mode, chunkSize: payload?.chunkSize, overlap: payload?.overlap, embed: payload?.embed });
  });

  ipcMain.handle(channels.IMPORT_LIBRARY_DOCUMENT, async (_event, payload) => {
    const relativePath = normalizeLibraryRelativePath(payload?.relativePath);
    if (!relativePath) throw new Error('请选择要导入的 library 文件');
    const filePath = libraryPath(relativePath);
    if (!statSync(filePath).isFile()) throw new Error('请选择要导入的文件');
    return importFilePaths([filePath], { mode: payload?.mode, chunkSize: payload?.chunkSize, overlap: payload?.overlap, embed: payload?.embed });
  });

  // 智能导入：后端只构造「发给 agent 的任务」（prompt + 建议档位），由渲染层据此发起 agent 会话。
  ipcMain.handle(channels.IMPORT_SMART_TASK, (_event, payload) => getHeadlessAgentClient().smartImportTask(payload || {}));

}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  configureContentSecurityPolicy();
  if (IS_MAIN_APP_PROCESS) {
    llmWorkspace.cleanupExpiredWorkspaceEntries();
    refreshLlmWorkspaceState();
    await ensureHeadlessAgentStarted();
    registerIpc();
    await createWindow();
    return;
  }
  registerLauncherIpc();
  await launcher.createLauncherWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // 关停清理集中一处（原先 before-quit 注册了两次、stopHeadlessAgent 跑两遍）：停文件监听 +
  // 清启动器轮询 + 断后端连接（共享管道模式只断连、不杀别的客户端在用的后端）。
  stopLibraryWatcher();
  launcher.dispose();
  stopHeadlessAgent();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length > 0) return;
  if (IS_MAIN_APP_PROCESS) await createWindow();
  else await launcher.createLauncherWindow();
});
