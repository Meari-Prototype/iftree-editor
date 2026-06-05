#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE_MODULE_PATH = join(
  PROJECT_ROOT,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node'
);
const ELECTRON_RUNTIME_PATH = join(
  PROJECT_ROOT,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
);
const ELECTRON_REBUILD_BIN = join(
  PROJECT_ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild'
);
const ELECTRON_REBUILD_ARGS = ['-f', '-w', 'better-sqlite3', '-w', 'onnxruntime-node'];

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runProcess(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || PROJECT_ROOT,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    if (!options.inherit) {
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    }
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function runShellCommand(commandLine, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandLine, {
      cwd: options.cwd || PROJECT_ROOT,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: true
    });
    let stdout = '';
    let stderr = '';
    if (!options.inherit) {
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    }
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function cmdQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function rebuildCommandLine() {
  if (process.platform !== 'win32') {
    return null;
  }
  return `${cmdQuote(ELECTRON_REBUILD_BIN)} ${ELECTRON_REBUILD_ARGS.join(' ')}`;
}

function parseJsonRows(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function listWindowsNativeModuleLockers() {
  if (!existsSync(NATIVE_MODULE_PATH)) return [];
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$target = ${psQuote(NATIVE_MODULE_PATH)}
$projectElectron = ${psQuote(ELECTRON_RUNTIME_PATH)}
$rows = @()
Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
  $proc = $_
  $loaded = $false
  try {
    foreach ($module in $proc.Modules) {
      if ($module.FileName -ieq $target) {
        $loaded = $true
        break
      }
    }
  } catch {}
  if ($loaded) {
    $procPath = ''
    try { $procPath = $proc.Path } catch {}
    $rows += [pscustomobject]@{
      pid = $proc.Id
      name = $proc.ProcessName
      path = $procPath
      owned = ($procPath -ieq $projectElectron)
    }
  }
}
$rows | ConvertTo-Json -Compress
`;
  const result = await runProcess('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ]);
  if (result.code !== 0 && !String(result.stdout || '').trim()) {
    throw new Error(`native lock scan failed: ${String(result.stderr || '').trim()}`);
  }
  return parseJsonRows(result.stdout)
    .map((row) => ({
      pid: Number(row.pid),
      name: String(row.name || ''),
      path: String(row.path || ''),
      owned: row.owned === true
    }))
    .filter((row) => Number.isInteger(row.pid) && row.pid > 0);
}

async function listNativeModuleLockers() {
  if (process.platform !== 'win32') return [];
  return listWindowsNativeModuleLockers();
}

function formatLockers(lockers = []) {
  return lockers
    .map((item) => `pid=${item.pid} name=${item.name || '(unknown)'} path=${item.path || '(unknown)'}`)
    .join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeProjectOwnedLockers(lockers = []) {
  const targets = [...new Map(
    lockers
      .filter((item) => item.owned && item.pid !== process.pid)
      .map((item) => [item.pid, item])
  ).values()];
  for (const locker of targets) {
    console.log(`[native-rebuild] closing project Electron process pid=${locker.pid}`);
    const result = await runProcess('taskkill', ['/PID', String(locker.pid), '/T', '/F']);
    if (result.stdout.trim()) console.log(result.stdout.trim());
    if (result.stderr.trim()) console.error(result.stderr.trim());
  }
}

async function waitForNativeModuleRelease(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let remaining = await listNativeModuleLockers();
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(250);
    remaining = await listNativeModuleLockers();
  }
  return remaining;
}

async function releaseNativeModuleLocks() {
  const lockers = await listNativeModuleLockers();
  if (lockers.length === 0) return;

  const external = lockers.filter((item) => !item.owned);
  if (external.length > 0) {
    throw new Error([
      'better_sqlite3.node is locked by a non-project process.',
      `module=${NATIVE_MODULE_PATH}`,
      formatLockers(external)
    ].join('\n'));
  }

  await closeProjectOwnedLockers(lockers);

  const remaining = await waitForNativeModuleRelease();
  if (remaining.length > 0) {
    throw new Error([
      'better_sqlite3.node is still locked after closing project Electron processes.',
      `module=${NATIVE_MODULE_PATH}`,
      formatLockers(remaining)
    ].join('\n'));
  }
}

async function main() {
  if (process.argv.includes('--list-locks')) {
    const lockers = await listNativeModuleLockers();
    console.log(lockers.length > 0 ? formatLockers(lockers) : 'no native module lockers found');
    return;
  }

  await releaseNativeModuleLocks();
  const rebuild = rebuildCommandLine();
  const result = rebuild
    ? await runShellCommand(rebuild, { inherit: true })
    : await runProcess(ELECTRON_REBUILD_BIN, ELECTRON_REBUILD_ARGS, { inherit: true });
  if (result.signal) {
    console.error(`[native-rebuild] electron-rebuild stopped by signal ${result.signal}`);
    process.exit(1);
  }
  process.exit(result.code ?? 1);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
