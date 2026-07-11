// 启动器与 watchdog（自 electron/main.ts 拆出，架构 §6-8；行为断言见 modules/app-shell.md 1 章）：
// 启动器窗口（文档列表 / 渲染模式 / 删除异常文档）+ 主服务拉起 + 启动超时与运行期心跳看门狗。
// 工厂注入 main 的设置读写 / 启动状态文件 / 后端读通道 / 窗口工具，自持全部启动器状态。
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

type RowObject = Record<string, unknown>;

export interface LauncherDeps {
  projectRoot: string;
  preloadPath: string;
  headlessDatabaseRead: (payload: RowObject) => Promise<unknown> | unknown;
  readProjectConfig: () => RowObject & { renderMode?: string; forceHardwareAcceleration?: boolean; debugLogging?: boolean };
  writeProjectConfig: (patch: RowObject) => unknown;
  readStartupStatus: () => RowObject & { success?: boolean; failed?: boolean; failure?: RowObject | null; stage?: string; progress?: { step?: unknown; total?: unknown } | null; startedAt?: unknown; heartbeatAt?: unknown };
  writeStartupStatus: (patch?: RowObject) => RowObject;
  startupStatusPath: () => string;
  appendDebugLog: (source: string, payload?: RowObject) => void;
  attachExternalNavigationGuards: (win: BrowserWindow | null) => void;
  showWindowForE2E: (win: BrowserWindow) => void;
}

export function createLauncher(deps: LauncherDeps) {
  const {
    headlessDatabaseRead,
    readProjectConfig,
    writeProjectConfig,
    readStartupStatus,
    writeStartupStatus,
    startupStatusPath,
    appendDebugLog,
    attachExternalNavigationGuards,
    showWindowForE2E
  } = deps;
  const PROJECT_ROOT = deps.projectRoot;
  const STARTUP_TIMEOUT_MS = 60_000;
  // 运行期心跳看门狗（需求 1414）：渲染层每 15s 打点 heartbeatAt；主线程卡死/停跳超过阈值
  // 连续 N 个 tick 即销毁主服务回启动器。
  const HEARTBEAT_STALE_MS = 120_000;
  const HEARTBEAT_STALE_TICKS = 5;

  let launcherWindow: BrowserWindow | null = null;
  let launchedMainProcess: ChildProcess | null = null;
  let launcherPollTimer: NodeJS.Timeout | null = null;
  let launcherLastFailure: RowObject | null = null;
  let heartbeatStaleTicks = 0;

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
      showFailure({ message: (error && error.message) || String(error) });
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
      preload: deps.preloadPath,
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
    // 需求 1414：运行期心跳停止（主线程卡死 / 渲染停跳）→ watchdog 销毁主服务进程并回到启动器。
    const heartbeatAt = Number(status.heartbeatAt || 0);
    if (heartbeatAt && Date.now() - heartbeatAt > HEARTBEAT_STALE_MS) {
      heartbeatStaleTicks += 1;
      if (heartbeatStaleTicks < HEARTBEAT_STALE_TICKS) return;
      heartbeatStaleTicks = 0;
      const failure = {
        message: `主服务心跳已停止超过 ${Math.round(HEARTBEAT_STALE_MS / 1000)} 秒，已自动销毁主服务并回到启动器。`,
        stage: status.stage || 'heartbeat-stopped'
      };
      // failure 落盘：进程被杀后 exit 回调读的是状态文件，不落盘会被「主服务已退出 code=…」覆盖。
      writeStartupStatus({ success: false, failed: true, failure });
      killLaunchedMainProcess();
      showLauncherFailure(failure);
      return;
    }
    heartbeatStaleTicks = 0;
    launcherLastFailure = null;
    if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.hide();
    return;
  }
  heartbeatStaleTicks = 0;
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
  const failure = {
    message: '启动超过 60 秒未完成，已自动回到启动器。',
    stage: status.stage || 'unknown',
    progress
  };
  writeStartupStatus({ failed: true, failure });
  killLaunchedMainProcess();
  showLauncherFailure(failure);
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
  heartbeatStaleTicks = 0;
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

  return {
    launcherState,
    createLauncherWindow,
    startMainAppFromLauncher,
    clearLastFailure() { launcherLastFailure = null; },
    dispose() {
      if (launcherPollTimer) clearInterval(launcherPollTimer);
      launcherPollTimer = null;
    }
  };
}
