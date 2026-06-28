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
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NativeImage, OpenDialogOptions } from 'electron';

import {
  DEFAULT_VECTOR_CONFIG,
  VECTOR_COMPUTE_OPTIONS,
  VECTOR_MODEL_OPTIONS,
  normalizeVectorConfig
} from '../src/vector/embeddings.js';
import { normalizeDocMeta, resolveMarkdownImageUrl, workspaceSearchRoots } from '../src/core/image-paths.js';
import { createBackendClient } from '../src/backend/llm/backend-client.js';
import { resolveNodeExecutable } from '../src/backend/llm/backend-discovery.js';
import {
  clampNumber,
  normalizeAgentToolSettings
} from '../src/backend/llm/defaults.js';
import {
  huggingFaceResolveUrl,
  huggingFaceTreeUrl,
  selectTransformerModelFiles
} from '../src/vector/model-download.js';


import { normalizeImportMode } from '../src/core/import-formats/shared.js';
import { DEFAULT_NODE_LAYOUT, normalizeNodeLayout } from '../src/core/mindmap.js';
import { normalizeStableId } from '../src/backend/db/ids.js';
import { debugValueSummary } from '../src/core/debug-summary.js';
import {
  activeLlmApiFromSettings,
  cleanupLegacyLlmEnvValues,
  createLlmSettingsReader,
  llmApiKeyEnvValues,
  readDotEnv as readDotEnvFile,
  stripLlmSecrets
} from '../src/backend/llm/settings.js';
import {
  createLibraryFs,
  createLlmWorkspace,
  isSameOrChildPath,
  normalizeLibraryRelativePath,
  pathKey
} from '../src/backend/library-fs.js';
import channels from './ipc-channels.js';

type RowObject = Record<string, unknown>;
type HeadlessAgentClient = ReturnType<typeof createBackendClient>;
// 对齐 backend/llm/settings.ts 的 EnvMap：readDotEnv 内部实际只赋 string，但类型签名容
// undefined 值；这里也保持同一形状，下面 readDotEnvFile() 返回值直接接住、无需 cast。
type DotEnvMap = Record<string, string | undefined>;
type ProjectConfig = RowObject & {
  llm?: RowObject;
  renderMode?: string;
  forceHardwareAcceleration?: boolean;
  debugLogging?: boolean;
};
type SettingsFile = RowObject & {
  vector?: RowObject & { enabled?: boolean };
  memory?: RowObject & { enabled?: boolean };
  nodeLayout?: NodeLayoutByView;
  node_layout?: NodeLayoutByView;
};
type NodeLayoutByView = {
  tree: ReturnType<typeof normalizeNodeLayout>;
  flow: ReturnType<typeof normalizeNodeLayout>;
};
type VectorConfig = ReturnType<typeof normalizeVectorConfig>;
type RectLike = {
  x: number;
  y: number;
  width: number;
  height: number;
  imageHeight?: number;
};
type CaptureAnalysis = RowObject & {
  ok: boolean;
  width: number;
  height: number;
  hasDarkLoadingOverlay: boolean;
  overlayDarkPixels: number;
  overlaySamplePixels: number;
  mainCanvasDarkPixels: number;
  textProbeRectCount: number;
  textDarkPixels: number;
  textRectsWithDark: number;
  textInkPixels: number;
  textRectsWithInk: number;
  hasReadableTextPixels: boolean;
  edgeProbeRectCount: number;
  edgeColorPixels: number;
  edgeRectsWithColor: number;
  hasBezierCurvePixels: boolean;
  fontShot?: RowObject;
};
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
const STARTUP_TIMEOUT_MS = 60_000;
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
let launcherWindow: BrowserWindow | null = null;
let entityMaintenanceWindow: BrowserWindow | null = null;
let launchedMainProcess: ChildProcess | null = null;
let launcherPollTimer: NodeJS.Timeout | null = null;
let launcherLastFailure: RowObject | null = null;
let mainStartupSucceeded = false;
let headlessAgentClient: HeadlessAgentClient | null = null;
let llmWorkspaceState: unknown = null;
let vectorConfigCache: VectorConfig | null = null;
let nodeLayoutConfigCache: NodeLayoutByView | null = null;
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

function isVectorModuleEnabled(settings: SettingsFile = readSettingsFile()) {
  const configured = settings?.vector?.enabled;
  return configured !== false;
}

// 记忆子系统开关（projectneed 15-10-5）：默认关闭，与向量模块并列。
function isMemoryEnabled(settings: SettingsFile = readSettingsFile()) {
  return settings?.memory?.enabled === true;
}

function memorySettingsPayload(settings: SettingsFile = readSettingsFile()) {
  return { enabled: isMemoryEnabled(settings) };
}

let dotEnvCache: DotEnvMap | null = null;

function projectEnvPath() {
  return join(PROJECT_ROOT, '.env');
}

function projectConfigPath() {
  return join(PROJECT_ROOT, 'iftree.config.json');
}

function readDotEnv(): DotEnvMap {
  if (dotEnvCache) return dotEnvCache;
  dotEnvCache = readDotEnvFile(projectEnvPath());
  return dotEnvCache;
}

function encodeDotEnvValue(value: unknown) {
  return String(value ?? '').replace(/\r?\n/g, '\\n');
}

function writeDotEnvValues(values: Record<string, string | null | undefined>) {
  const envPath = projectEnvPath();
  const keys = Object.keys(values || {});
  const removeKeys = new Set(keys.filter((key) => values[key] === null));
  const seen = new Set<string>();
  const raw = existsSync(envPath)
    ? readFileSync(envPath, 'utf8')
    : '# IFTreeEditor 环境配置\n';
  const lines = raw.split(/\r?\n/);
  const nextLines = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !keys.includes(match[1])) return line;
    seen.add(match[1]);
    if (removeKeys.has(match[1])) return null;
    return `${match[1]}=${encodeDotEnvValue(values[match[1]])}`;
  }).filter((line) => line !== null);
  const missing = keys.filter((key) => !seen.has(key) && !removeKeys.has(key));
  if (missing.length > 0) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1].trim()) nextLines.push('');
    nextLines.push('# IF-Tree LLM 摘要配置');
    for (const key of missing) {
      nextLines.push(`${key}=${encodeDotEnvValue(values[key])}`);
    }
  }
  mkdirSync(dirname(envPath), { recursive: true });
  writeFileSync(envPath, `${nextLines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
  dotEnvCache = null;
}

function readProjectConfig(): ProjectConfig {
  const configPath = projectConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeProjectConfig(patch: ProjectConfig = {}) {
  const current = readProjectConfig();
  const next = {
    ...current,
    ...patch,
    llm: {
      ...(current.llm || {}),
      ...(patch.llm || {})
    }
  };
  mkdirSync(dirname(projectConfigPath()), { recursive: true });
  writeFileSync(projectConfigPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return readProjectConfig();
}

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

function headlessDatabaseRead(payload: unknown = {}) {
  return getHeadlessAgentClient().databaseRead(payload);
}

function headlessDatabaseWrite(payload: unknown = {}) {
  return getHeadlessAgentClient().databaseWrite(payload);
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

function settingsPath() {
  return join(appHome(), 'settings.json');
}

function readSettingsFile(): SettingsFile {
  try {
    return JSON.parse(readFileSync(settingsPath(), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

function writeSettingsFile(settings: SettingsFile) {
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function getVectorConfig() {
  if (!vectorConfigCache) {
    const settings = readSettingsFile();
    vectorConfigCache = normalizeVectorConfig(settings.vector || DEFAULT_VECTOR_CONFIG);
  }
  return vectorConfigCache;
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

function normalizeNodeLayoutSettingsByView(value: Partial<NodeLayoutByView> = {}): NodeLayoutByView {
  return {
    tree: normalizeNodeLayout(value?.tree || DEFAULT_NODE_LAYOUT),
    flow: normalizeNodeLayout(value?.flow || value?.tree || DEFAULT_NODE_LAYOUT)
  };
}

function getNodeLayoutConfig() {
  if (!nodeLayoutConfigCache) {
    const settings = readSettingsFile();
    nodeLayoutConfigCache = normalizeNodeLayoutSettingsByView(settings.nodeLayout || settings.node_layout);
  }
  return nodeLayoutConfigCache;
}

function nodeLayoutSettingsPayload(config: NodeLayoutByView = getNodeLayoutConfig()) {
  return {
    tree: { ...(config.tree || {}) },
    flow: { ...(config.flow || {}) }
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

async function saveVectorConfig(patch: RowObject = {}) {
  const current = getVectorConfig();
  const next = normalizeVectorConfig({ ...current, ...patch });
  const modelChanged = current.modelId !== next.modelId;
  const dimensionsChanged = current.dimensions !== next.dimensions;
  const modelSourceChanged = current.localModelRoot !== next.localModelRoot;

  const settings = readSettingsFile();
  const enabled = Object.prototype.hasOwnProperty.call(patch, 'enabled')
    ? patch.enabled === true
    : isVectorModuleEnabled(settings);
  settings.vector = {
    enabled,
    modelId: next.modelId,
    computeTarget: next.computeTarget,
    batchSize: next.batchSize,
    workerCount: next.workerCount,
    localModelRoot: next.localModelRoot,
    remoteModelHost: next.remoteModelHost,
    importVectors: next.importVectors
  };
  writeSettingsFile(settings);
  vectorConfigCache = next;

  if (enabled && (modelChanged || dimensionsChanged || modelSourceChanged)) {
    await resetVectorStoreTable(next.dimensions);
  }

  return vectorSettingsPayload(next);
}

function saveMemoryConfig(patch: RowObject = {}) {
  const settings = readSettingsFile();
  settings.memory = { ...(settings.memory || {}), enabled: patch?.enabled === true };
  writeSettingsFile(settings);
  return memorySettingsPayload(settings);
}

function saveNodeLayoutConfig(patch: RowObject = {}) {
  const settings = readSettingsFile();
  const current = normalizeNodeLayoutSettingsByView(settings.nodeLayout || settings.node_layout);
  const next = normalizeNodeLayoutSettingsByView(
    patch && (patch.tree || patch.flow)
      ? patch
      : {
        ...current,
        [patch?.view === 'flow' ? 'flow' : 'tree']: {
          ...(current[patch?.view === 'flow' ? 'flow' : 'tree'] || DEFAULT_NODE_LAYOUT),
          ...((patch && typeof patch.patch === 'object') ? patch.patch : patch || {})
        }
      }
  );
  settings.nodeLayout = next;
  delete settings.node_layout;
  writeSettingsFile(settings);
  nodeLayoutConfigCache = next;
  return nodeLayoutSettingsPayload(nodeLayoutConfigCache);
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

function countDarkPixels(bitmap: Uint8Array, width: number, rect: RectLike, step = 1) {
  const left = Math.floor(clampNumber(rect.x, 0, width, 0));
  const top = Math.floor(clampNumber(rect.y, 0, rect.imageHeight || 0, 0));
  const right = Math.ceil(clampNumber(rect.x + rect.width, 0, width, 0));
  const bottom = Math.ceil(clampNumber(rect.y + rect.height, 0, rect.imageHeight || 0, 0));
  let dark = 0;
  let total = 0;
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const offset = (y * width + x) * 4;
      const b = bitmap[offset];
      const g = bitmap[offset + 1];
      const r = bitmap[offset + 2];
      const a = bitmap[offset + 3];
      if (a > 180 && r < 120 && g < 120 && b < 120) dark += 1;
      total += 1;
    }
  }
  return { dark, total, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function countTextInkPixels(bitmap: Uint8Array, width: number, rect: RectLike, step = 1) {
  const left = Math.floor(clampNumber(rect.x, 0, width, 0));
  const top = Math.floor(clampNumber(rect.y, 0, rect.imageHeight || 0, 0));
  const right = Math.ceil(clampNumber(rect.x + rect.width, 0, width, 0));
  const bottom = Math.ceil(clampNumber(rect.y + rect.height, 0, rect.imageHeight || 0, 0));
  let ink = 0;
  let total = 0;
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const offset = (y * width + x) * 4;
      const b = bitmap[offset];
      const g = bitmap[offset + 1];
      const r = bitmap[offset + 2];
      const a = bitmap[offset + 3];
      if (a > 180 && r < 225 && g < 225 && b < 225 && (r + g + b) < 650) ink += 1;
      total += 1;
    }
  }
  return { ink, total, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function countBezierPixels(bitmap: Uint8Array, width: number, rect: RectLike, step = 1) {
  const left = Math.floor(clampNumber(rect.x, 0, width, 0));
  const top = Math.floor(clampNumber(rect.y, 0, rect.imageHeight || 0, 0));
  const right = Math.ceil(clampNumber(rect.x + rect.width, 0, width, 0));
  const bottom = Math.ceil(clampNumber(rect.y + rect.height, 0, rect.imageHeight || 0, 0));
  let edge = 0;
  let total = 0;
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const offset = (y * width + x) * 4;
      const b = bitmap[offset];
      const g = bitmap[offset + 1];
      const r = bitmap[offset + 2];
      const a = bitmap[offset + 3];
      const treeEdge = a > 160 && r >= 160 && r <= 245 && g >= 155 && g <= 240 && b >= 145 && b <= 235;
      const flowEdge = a > 160 && r >= 70 && r <= 120 && g >= 95 && g <= 140 && b >= 80 && b <= 125;
      if (treeEdge || flowEdge) edge += 1;
      total += 1;
    }
  }
  return { edge, total, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function analyzeE2ECapture(image: NativeImage, textProbeRects: unknown[] = [], edgeProbeRects: unknown[] = [], contentSize: Partial<RectLike> = {}): CaptureAnalysis {
  const size = image.getSize();
  const width = Math.max(1, Number(size.width) || 1);
  const height = Math.max(1, Number(size.height) || 1);
  const bitmap = image.toBitmap();
  const overlayRegion = {
    x: Math.floor(width * 0.12),
    y: 0,
    width: Math.floor(width * 0.76),
    height: Math.min(height, Math.max(120, Math.floor(height * 0.22))),
    imageHeight: height
  };
  const overlay = countDarkPixels(bitmap, width, overlayRegion, 2);
  const hasDarkLoadingOverlay = overlay.dark > 1200 && overlay.dark / Math.max(1, overlay.total) > 0.035;
  const scaleX = width / Math.max(1, Number(contentSize.width) || width);
  const scaleY = height / Math.max(1, Number(contentSize.height) || height);
  const mainCanvasRegion = {
    x: Math.floor(width * 0.22),
    y: Math.floor(height * 0.16),
    width: Math.floor(width * 0.56),
    height: Math.floor(height * 0.76),
    imageHeight: height
  };
  const mainCanvasText = countDarkPixels(bitmap, width, mainCanvasRegion, 1);
  let textProbeRectCount = 0;
  let textDarkPixels = 0;
  let textRectsWithDark = 0;
  let textInkPixels = 0;
  let textRectsWithInk = 0;
  for (const rect of Array.isArray(textProbeRects) ? textProbeRects.slice(0, 30) as Array<Partial<RectLike>> : []) {
    const probe = {
      x: Number(rect?.x || 0) * scaleX,
      y: Number(rect?.y || 0) * scaleY,
      width: Number(rect?.width || 0) * scaleX,
      height: Number(rect?.height || 0) * scaleY,
      imageHeight: height
    };
    if (probe.width < 8 || probe.height < 6) continue;
    const sample = countTextInkPixels(bitmap, width, probe, 1);
    if (sample.width < 8 || sample.height < 6) continue;
    textProbeRectCount += 1;
    textInkPixels += sample.ink;
    textDarkPixels += sample.ink;
    if (sample.ink >= 5) {
      textRectsWithInk += 1;
      textRectsWithDark += 1;
    }
  }
  let edgeProbeRectCount = 0;
  let edgeColorPixels = 0;
  let edgeRectsWithColor = 0;
  for (const rect of Array.isArray(edgeProbeRects) ? edgeProbeRects.slice(0, 30) as Array<Partial<RectLike>> : []) {
    const probe = {
      x: Number(rect?.x || 0) * scaleX,
      y: Number(rect?.y || 0) * scaleY,
      width: Number(rect?.width || 0) * scaleX,
      height: Number(rect?.height || 0) * scaleY,
      imageHeight: height
    };
    if (probe.width < 12 || probe.height < 6) continue;
    const sample = countBezierPixels(bitmap, width, probe, 1);
    if (sample.width < 12 || sample.height < 6) continue;
    edgeProbeRectCount += 1;
    edgeColorPixels += sample.edge;
    if (sample.edge >= 6) edgeRectsWithColor += 1;
  }
  const hasReadableTextPixels = (
    textProbeRectCount >= 2 &&
    textInkPixels >= Math.max(10, textProbeRectCount * 4) &&
    textRectsWithInk >= 1
  ) || mainCanvasText.dark >= 180;
  const hasBezierCurvePixels = edgeProbeRectCount > 0 &&
    edgeColorPixels >= Math.max(12, edgeProbeRectCount * 4) &&
    edgeRectsWithColor >= 1;
  return {
    ok: !hasDarkLoadingOverlay && hasReadableTextPixels && hasBezierCurvePixels,
    width,
    height,
    hasDarkLoadingOverlay,
    overlayDarkPixels: overlay.dark,
    overlaySamplePixels: overlay.total,
    mainCanvasDarkPixels: mainCanvasText.dark,
    textProbeRectCount,
    textDarkPixels,
    textRectsWithDark,
    textInkPixels,
    textRectsWithInk,
    hasReadableTextPixels,
    edgeProbeRectCount,
    edgeColorPixels,
    edgeRectsWithColor,
    hasBezierCurvePixels
  };
}

async function captureZoomedE2EWindow(win: BrowserWindow) {
  const target = process.env.IFTREE_E2E_FONT_SCREENSHOT_PATH;
  if (!target) return null;
  const steps = Math.max(1, Number(process.env.IFTREE_E2E_FONT_ZOOM_STEPS) || 5);
  const configuredDelta = Number(process.env.IFTREE_E2E_FONT_ZOOM_DELTA);
  const deltaY = Number.isFinite(configuredDelta) && configuredDelta !== 0 ? configuredDelta : 720;
  const contentBounds = win.getContentBounds();
  const x = Math.floor(Math.max(1, contentBounds.width) * 0.5);
  const y = Math.floor(Math.max(1, contentBounds.height) * 0.5);
  for (let index = 0; index < steps; index += 1) {
    win.webContents.sendInputEvent({
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY,
      wheelTicksX: 0,
      wheelTicksY: deltaY > 0 ? 1 : -1
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  const dragX = Math.floor(Math.max(1, contentBounds.width) * 0.36);
  const dragY = Math.floor(Math.max(1, contentBounds.height) * 0.5);
  const dragDx = 96;
  const dragDy = 18;
  win.webContents.sendInputEvent({ type: 'mouseDown', x: dragX, y: dragY, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  win.webContents.sendInputEvent({
    type: 'mouseMove',
    x: dragX + dragDx,
    y: dragY + dragDy,
    button: 'left',
    movementX: dragDx,
    movementY: dragDy
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: dragX + dragDx,
    y: dragY + dragDy,
    button: 'left',
    clickCount: 1
  });
  await new Promise((resolve) => setTimeout(resolve, 240));
  const image = await win.webContents.capturePage();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, image.toPNG());
  return {
    path: target,
    zoomSteps: steps,
    deltaY
  };
}

async function launcherDocs() {
  const result = await headlessDatabaseRead({ action: 'doc.list' });
  const resultObject = (result && typeof result === 'object' ? result : {}) as RowObject;
  const docs = Array.isArray(result) ? result : (Array.isArray(resultObject.rows) ? resultObject.rows : (Array.isArray(resultObject.docs) ? resultObject.docs : []));
  return docs.map((doc: RowObject) => ({
    id: doc.id,
    title: doc.title || `Doc ${doc.id}`,
    node_count: doc.node_count ?? doc.nodeCount ?? 0,
    updated_at: doc.updated_at || doc.updatedAt || null
  }));
}

async function launcherState() {
  const config = readProjectConfig();
  return {
    renderMode: config.renderMode || 'hardware',
    forceHardwareAcceleration: config.forceHardwareAcceleration !== false,
    debugLogging: config.debugLogging === true,
    docs: await launcherDocs(),
    failure: launcherLastFailure || readStartupStatus().failure || null
  };
}

function launcherHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>条件树编辑器启动器</title>
  <style>
    :root { color-scheme: light; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f5f2; color: #25231f; }
    .shell { max-width: 920px; margin: 0 auto; padding: 56px 32px; }
    h1 { margin: 0 0 8px; font-size: 28px; font-weight: 700; }
    p { margin: 0; color: #686158; line-height: 1.6; }
    .bar { display: flex; gap: 12px; align-items: center; margin: 28px 0; }
    select, button { height: 36px; border: 1px solid #c9c2b8; background: #fff; border-radius: 6px; padding: 0 12px; font-size: 14px; }
    button { cursor: pointer; background: #2f6f5e; border-color: #2f6f5e; color: #fff; }
    button.secondary { background: #fff; color: #25231f; border-color: #c9c2b8; }
    button.danger { background: #9b3d3d; border-color: #9b3d3d; }
    .force-gpu { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 10px; border: 1px solid #c9c2b8; border-radius: 6px; background: #fff; font-size: 14px; }
    .force-gpu input { width: 16px; height: 16px; margin: 0; }
    .failure { display: none; margin: 24px 0; padding: 16px; border: 1px solid #c99191; border-radius: 6px; background: #fff4f4; color: #662d2d; white-space: pre-wrap; }
    .docs { margin-top: 32px; border-top: 1px solid #ddd6ca; }
    .doc { display: grid; grid-template-columns: 96px 1fr 120px 132px; gap: 12px; align-items: center; padding: 12px 0; border-bottom: 1px solid #e6dfd4; }
    .doc-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .muted { color: #736c62; font-size: 13px; }
    #status { min-height: 20px; color: #4e6b60; }
  </style>
</head>
<body>
  <main class="shell">
    <h1>条件树编辑器启动器</h1>
    <p>启动器只负责让主服务安全启动；主服务加载失败时，可在这里删除异常文档数据后重试。</p>
    <section class="bar">
      <select id="renderMode">
        <option value="hardware">硬件加速</option>
        <option value="compatible">兼容模式（JS Canvas 2D）</option>
      </select>
      <label class="force-gpu"><input id="forceHardwareAcceleration" type="checkbox">强制启用硬件加速</label>
      <label class="force-gpu"><input id="debugLogging" type="checkbox">debug 日志</label>
      <button id="start">启动</button>
      <button id="refresh" class="secondary">刷新</button>
      <span id="status"></span>
    </section>
    <section id="failure" class="failure"></section>
    <section class="docs">
      <h2>已导入文档</h2>
      <div id="docs"></div>
    </section>
  </main>
  <script>
    const renderMode = document.getElementById('renderMode');
    const forceHardwareAcceleration = document.getElementById('forceHardwareAcceleration');
    const debugLogging = document.getElementById('debugLogging');
    const docsEl = document.getElementById('docs');
    const failureEl = document.getElementById('failure');
    const statusEl = document.getElementById('status');

    function text(value) {
      return value == null ? '' : String(value);
    }

    function showFailure(failure) {
      if (!failure) {
        failureEl.style.display = 'none';
        failureEl.textContent = '';
        return;
      }
      const lines = [
        failure.message || '启动失败，请切换渲染模式、删除异常文档数据后重试。',
        failure.stage ? '卡点：' + failure.stage : '',
        failure.progress ? '进度：' + failure.progress : ''
      ].filter(Boolean);
      failureEl.textContent = lines.join('\\n');
      failureEl.style.display = 'block';
    }

    function renderDocs(docs) {
      docsEl.innerHTML = '';
      if (!docs.length) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = '暂无导入文档。';
        docsEl.appendChild(empty);
        return;
      }
      for (const doc of docs) {
        const row = document.createElement('div');
        row.className = 'doc';
        const id = document.createElement('div');
        id.className = 'muted';
        id.textContent = '#' + text(doc.id);
        const title = document.createElement('div');
        title.className = 'doc-title';
        title.title = text(doc.title);
        title.textContent = text(doc.title);
        const count = document.createElement('div');
        count.className = 'muted';
        count.textContent = text(doc.node_count) + ' 节点';
        const button = document.createElement('button');
        button.className = 'danger';
        button.textContent = '删除文档数据';
        row.append(id, title, count, button);
        button.addEventListener('click', async () => {
          if (!confirm('删除该文档数据？不会删除 library 中的真实文件。')) return;
          statusEl.textContent = '正在删除...';
          const state = await window.iftree.deleteLauncherDoc({ docId: doc.id });
          statusEl.textContent = '已删除';
          applyState(state);
        });
        docsEl.appendChild(row);
      }
    }

    function applyState(state) {
      renderMode.value = state.renderMode || 'hardware';
      forceHardwareAcceleration.checked = state.forceHardwareAcceleration !== false;
      debugLogging.checked = state.debugLogging === true;
      renderDocs(Array.isArray(state.docs) ? state.docs : []);
      showFailure(state.failure || null);
    }

    async function load() {
      statusEl.textContent = '正在读取...';
      applyState(await window.iftree.getLauncherState());
      statusEl.textContent = '';
    }

    document.getElementById('start').addEventListener('click', async () => {
      statusEl.textContent = '正在启动主服务...';
      showFailure(null);
      await window.iftree.startMainApp({
        renderMode: renderMode.value,
        forceHardwareAcceleration: forceHardwareAcceleration.checked,
        debugLogging: debugLogging.checked
      });
    });
    document.getElementById('refresh').addEventListener('click', load);
    load().catch((error) => {
      statusEl.textContent = '';
      showFailure({ message: (error as { message?: string }).message || String(error) });
    });
  </script>
</body>
</html>`;
}

async function loadLauncherPage() {
  if (!launcherWindow || launcherWindow.isDestroyed()) return;
  await launcherWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(launcherHtml())}`);
  showWindowForE2E(launcherWindow);
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

async function createLauncherWindow() {
  launcherWindow = new BrowserWindow({
    title: '条件树编辑器启动器',
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    autoHideMenuBar: true,
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
  launcherWindow.on('closed', () => {
    launcherWindow = null;
  });
  await loadLauncherPage();
  attachExternalNavigationGuards(launcherWindow);
  if (process.env.IFTREE_LAUNCHER_AUTOSTART === '1') {
    setTimeout(() => {
      const config = readProjectConfig();
      startMainAppFromLauncher({
        renderMode: config.renderMode || 'hardware',
        forceHardwareAcceleration: config.forceHardwareAcceleration !== false,
        debugLogging: config.debugLogging === true
      });
    }, 200);
  }
}

function mainAppSpawnArgs() {
  return app.isPackaged ? [] : [PROJECT_ROOT];
}

function killLaunchedMainProcess() {
  const child = launchedMainProcess;
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  child.kill('SIGKILL');
}

function showLauncherFailure(failure: RowObject) {
  launcherLastFailure = failure;
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.show();
    loadLauncherPage().catch((error) => console.error(`[launcher] failed to load: ${(error as { stack?: string }).stack || (error as { message?: string }).message}`));
  }
}

function pollLauncherStartup() {
  if (!launchedMainProcess || launchedMainProcess.exitCode !== null || launchedMainProcess.signalCode) return;
  const status = readStartupStatus();
  if (status.success === true) {
    launcherLastFailure = null;
    if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.hide();
    return;
  }
  if (status.failed === true) {
    killLaunchedMainProcess();
    showLauncherFailure(status.failure || { message: '启动失败，请切换渲染模式、删除异常文档数据后重试。' });
    return;
  }
  const startedAt = Number(status.startedAt || 0) || Date.now();
  if (Date.now() - startedAt <= STARTUP_TIMEOUT_MS) return;
  const progress = status.progress
    ? `${status.progress.step ?? 0} / ${status.progress.total ?? 0}`
    : '';
  killLaunchedMainProcess();
  showLauncherFailure({
    message: '启动超过 60 秒未完成，已自动回到启动器。',
    stage: status.stage || 'unknown',
    progress
  });
}

function startLauncherPoll() {
  if (launcherPollTimer) clearInterval(launcherPollTimer);
  launcherPollTimer = setInterval(pollLauncherStartup, 1000);
}

function startMainAppFromLauncher(payload: RowObject = {}) {
  if (launchedMainProcess && launchedMainProcess.exitCode === null && !launchedMainProcess.signalCode) {
    return { ok: true, alreadyRunning: true };
  }
  const renderMode = payload.renderMode === 'compatible' ? 'compatible' : 'hardware';
  const forceHardwareAcceleration = payload.forceHardwareAcceleration !== false;
  const debugLogging = payload.debugLogging === true;
  writeProjectConfig({ renderMode, forceHardwareAcceleration, debugLogging });
  appendDebugLog('backend', {
    event: 'launcher.start',
    renderMode,
    forceHardwareAcceleration,
    debugLogging
  });
  const statusPath = startupStatusPath();
  launcherLastFailure = null;
  writeStartupStatus({
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
    success: false,
    failed: false,
    stage: 'launcher-started-main-app',
    progress: null,
    failure: null
  });
  const env = {
    ...process.env,
    IFTREE_MAIN_APP: '1',
    IFTREE_RENDER_MODE: renderMode,
    IFTREE_FORCE_HARDWARE_ACCELERATION: forceHardwareAcceleration ? '1' : '0',
    IFTREE_DEBUG_LOGGING: debugLogging ? '1' : '0',
    IFTREE_STARTUP_STATUS_PATH: statusPath
  };
  launchedMainProcess = spawn(process.execPath, mainAppSpawnArgs(), {
    cwd: PROJECT_ROOT,
    env,
    stdio: 'inherit',
    windowsHide: false
  });
  launchedMainProcess.on('exit', (code, signal) => {
    if (launcherPollTimer) {
      clearInterval(launcherPollTimer);
      launcherPollTimer = null;
    }
    launchedMainProcess = null;
    const status = readStartupStatus();
    if (status.success === true && code === 0) {
      showLauncherFailure({
        message: '主服务已关闭，可重新启动。',
        stage: 'main-service-closed'
      });
      return;
    }
    showLauncherFailure(status.failure || {
      message: `主服务已退出：code=${code ?? ''} signal=${signal ?? ''}`,
      stage: status.stage || 'process-exit'
    });
  });
  startLauncherPoll();
  return { ok: true, pid: launchedMainProcess.pid };
}

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
  const dataObject = data as RowObject;
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
  ipcMain.handle(channels.LAUNCHER_STATE, async () => await launcherState());
  ipcMain.handle(channels.LAUNCHER_START, (_event, payload) => startMainAppFromLauncher(payload || {}));
  ipcMain.handle(channels.LAUNCHER_DELETE_DOC, async (_event, payload) => {
    const docId = normalizeMainDocId(payload?.docId ?? payload?.doc_id, null);
    if (!docId) throw new Error('deleteDoc requires docId');
    const result = await headlessDatabaseWrite({ action: 'doc.delete', docId });
    launcherLastFailure = null;
    return {
      ...(await launcherState()),
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
  await createLauncherWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // 关停清理集中一处（原先 before-quit 注册了两次、stopHeadlessAgent 跑两遍）：停文件监听 +
  // 清启动器轮询 + 断后端连接（共享管道模式只断连、不杀别的客户端在用的后端）。
  stopLibraryWatcher();
  if (launcherPollTimer) clearInterval(launcherPollTimer);
  stopHeadlessAgent();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length > 0) return;
  if (IS_MAIN_APP_PROCESS) await createWindow();
  else await createLauncherWindow();
});
