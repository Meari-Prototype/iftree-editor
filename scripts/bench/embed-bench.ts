#!/usr/bin/env node
// 嵌入引擎微基准：隔离 DB/lance，只测 transformers.js pipeline 的纯吞吐，
// 定位向量补建 46/s 的瓶颈来源（device / dtype / batchSize / 是否真用 GPU）。
//
// 用法（electron-as-node）：
//   electron scripts/bench/embed-bench.mjs [--file <.jsonl>] [--texts 128] [--configs dml:fp16,dml:q8,cpu:q8] [--batches 16,32,64]
// 模型与 localModelRoot 取自 IFTREE_HOME/settings.json（与 headless 运行时一致）。

import { readFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { env as transformersEnv, pipeline } from '@huggingface/transformers';
import { normalizeVectorConfig } from '../../src/vector/embeddings.js';

interface VectorBenchConfig {
  localModelRoot?: unknown;
  modelName: string;
  pooling?: unknown;
  dimensions?: unknown;
}

interface BenchArgs {
  file: string | null;
  texts: number;
  configs: string;
  batches: string;
}

type BenchRow = {
  batchSize: number;
  texts?: number;
  ms?: number;
  perSec?: number;
  msPerBatch?: number;
  error?: unknown;
};

interface BenchResult {
  device: string;
  dtype: string;
  rows: BenchRow[];
  error?: string;
  loadMs?: number;
}

function appHome() {
  return process.env.IFTREE_HOME || join(homedir(), '.iftree');
}

function readVectorConfig() {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(join(appHome(), 'settings.json'), 'utf8').replace(/^﻿/, '')) || {};
  } catch { /* defaults */ }
  return normalizeVectorConfig((raw.vector || {}) as Parameters<typeof normalizeVectorConfig>[0]) as VectorBenchConfig;
}

async function sampleTexts(filePath: string | null, count: number): Promise<string[]> {
  // 真实长度的语料更有代表性；无文件则退化为合成长文本。
  if (!filePath) {
    return Array.from({ length: count }, (_, i) => `synthetic segment ${i} ` + 'lorem ipsum dolor sit amet '.repeat(35));
  }
  const raw = createReadStream(filePath);
  const input = filePath.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
  const reader = createInterface({ input, crlfDelay: Infinity });
  const out: string[] = [];
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { segment?: unknown };
        if (o.segment) out.push(String(o.segment));
      } catch { continue; }
      if (out.length >= count) break;
    }
  } finally {
    reader.close();
    input.destroy?.();
    raw.destroy?.();
  }
  return out;
}

function avgLen(texts: string[]) {
  return Math.round(texts.reduce((s, t) => s + t.length, 0) / texts.length);
}

async function buildExtractor(config: VectorBenchConfig, device: string, dtype: string) {
  const localRoot = String(config.localModelRoot || '').trim();
  const hasLocal = Boolean(localRoot);
  transformersEnv.allowLocalModels = hasLocal;
  transformersEnv.localModelPath = hasLocal ? `${localRoot.replace(/\\/g, '/')}/` : '/models/';
  transformersEnv.allowRemoteModels = !hasLocal;
  const t0 = Date.now();
  const extractor = await pipeline('feature-extraction', config.modelName, { device, dtype });
  return { extractor, loadMs: Date.now() - t0 };
}

async function runConfig(
  config: VectorBenchConfig,
  device: string,
  dtype: string,
  texts: string[],
  batchSizes: number[]
): Promise<BenchResult> {
  const result: BenchResult = { device, dtype, rows: [] };
  let built;
  try {
    built = await buildExtractor(config, device, dtype);
  } catch (error: unknown) {
    result.error = `load failed: ${(error as { message?: string } | null | undefined)?.message || error}`;
    return result;
  }
  result.loadMs = built.loadMs;
  const extractor = built.extractor as ((input: string[], options?: Record<string, unknown>) => Promise<unknown>) & { dispose?: () => unknown };
  for (const batchSize of batchSizes) {
    try {
      // warmup（首批含 kernel 编译/显存分配，不计时）
      await extractor(texts.slice(0, batchSize), { pooling: config.pooling, normalize: true });
      const t0 = Date.now();
      let done = 0;
      for (let offset = 0; offset < texts.length; offset += batchSize) {
        const batch = texts.slice(offset, offset + batchSize);
        await extractor(batch, { pooling: config.pooling, normalize: true });
        done += batch.length;
      }
      const ms = Date.now() - t0;
      result.rows.push({ batchSize, texts: done, ms, perSec: Math.round((done / ms) * 1000), msPerBatch: Math.round(ms / Math.ceil(done / batchSize)) });
    } catch (error: unknown) {
      result.rows.push({ batchSize, error: (error as { message?: string } | null | undefined)?.message || String(error) });
    }
  }
  if (typeof extractor.dispose === 'function') {
    try { await extractor.dispose(); } catch { /* ignore */ }
  }
  return result;
}

function parseArgs(argv: string[]): BenchArgs {
  const args: BenchArgs = { file: process.env.IFTREE_BENCH_MSMARCO_FILE || null, texts: 128, configs: 'dml:fp16,dml:q8,cpu:q8', batches: '16,32,64' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--texts') args.texts = Number(argv[++i]);
    else if (a === '--configs') args.configs = argv[++i];
    else if (a === '--batches') args.batches = argv[++i];
  }
  return args;
}

async function exitProcess(code: number) {
  if (process.versions.electron) {
    try { const { app } = await import('electron'); app?.exit?.(code); return; } catch { /* */ }
  }
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readVectorConfig();
  const texts = await sampleTexts(args.file, args.texts);
  const batchSizes = args.batches.split(',').map((v) => Number(v.trim())).filter(Boolean);
  const configs = args.configs.split(',').map((c) => c.split(':'));

  console.log(JSON.stringify({
    model: config.modelName, dims: config.dimensions, pooling: config.pooling,
    localModelRoot: config.localModelRoot, textCount: texts.length, avgCharLen: avgLen(texts), batchSizes
  }, null, 2));

  for (const [device, dtype] of configs) {
    const r = await runConfig(config, device, dtype, texts, batchSizes);
    if (r.error) {
      console.log(`\n[${device}/${dtype}] ${r.error}`);
      continue;
    }
    console.log(`\n[${device}/${dtype}] modelLoad=${r.loadMs}ms`);
    for (const row of r.rows) {
      if (row.error) console.log(`   batch=${row.batchSize}: ERROR ${row.error}`);
      else console.log(`   batch=${String(row.batchSize).padStart(3)}: ${String(row.perSec).padStart(5)} texts/s  (${row.ms}ms total, ${row.msPerBatch}ms/batch)`);
    }
  }
  await exitProcess(0);
}

main().catch(async (error: unknown) => {
  console.error((error as { stack?: string } | null | undefined)?.stack || (error as { message?: string } | null | undefined)?.message || String(error));
  await exitProcess(1);
});
