// 配置读写域（自 electron/main.ts 拆出，架构 §6-8）：.env / iftree.config.json / settings.json
// 三个配置文件的读写与形状规整（vector / memory / nodeLayout），带各自的进程内缓存。
// 工厂只依赖两个路径事实（projectRoot / appHome）；LLM 设置业务（writeLlmSummarySettings 等）、
// 向量库副作用（resetVectorStoreTable）与 GUI payload 组装留在 main，消费本件的读写函数。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  DEFAULT_VECTOR_CONFIG,
  normalizeVectorConfig
} from '../src/vector/embeddings.js';
import { DEFAULT_NODE_LAYOUT, normalizeNodeLayout } from '../src/core/mindmap.js';
import { readDotEnv as readDotEnvFile } from '../src/backend/llm/settings.js';

type RowObject = Record<string, unknown>;

// 对齐 backend/llm/settings.ts 的 EnvMap：readDotEnv 内部实际只赋 string，但类型签名容
// undefined 值；这里也保持同一形状，readDotEnvFile() 返回值直接接住、无需 cast。
export type DotEnvMap = Record<string, string | undefined>;
export type ProjectConfig = RowObject & {
  llm?: RowObject;
  renderMode?: string;
  forceHardwareAcceleration?: boolean;
  debugLogging?: boolean;
};
export type SettingsFile = RowObject & {
  vector?: RowObject & { enabled?: boolean };
  memory?: RowObject & { enabled?: boolean };
  nodeLayout?: NodeLayoutByView;
  node_layout?: NodeLayoutByView;
};
export type NodeLayoutByView = {
  tree: ReturnType<typeof normalizeNodeLayout>;
  flow: ReturnType<typeof normalizeNodeLayout>;
};
export type VectorConfig = ReturnType<typeof normalizeVectorConfig>;

export interface SettingsIoDeps {
  projectRoot: string;
  appHome: () => string;
}

export function createSettingsIo({ projectRoot, appHome }: SettingsIoDeps) {
  let dotEnvCache: DotEnvMap | null = null;
  let vectorConfigCache: VectorConfig | null = null;
  let nodeLayoutConfigCache: NodeLayoutByView | null = null;

  function projectEnvPath() {
    return join(projectRoot, '.env');
  }

  function projectConfigPath() {
    return join(projectRoot, 'iftree.config.json');
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

  function settingsPath() {
    return join(appHome(), 'settings.json');
  }

  function readSettingsFile(): SettingsFile {
    try {
      return JSON.parse(readFileSync(settingsPath(), 'utf8').replace(/^\\uFEFF/, ''));
    } catch {
      return {};
    }
  }

  function writeSettingsFile(settings: SettingsFile) {
    mkdirSync(dirname(settingsPath()), { recursive: true });
    writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
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

  function getVectorConfig() {
    if (!vectorConfigCache) {
      const settings = readSettingsFile();
      vectorConfigCache = normalizeVectorConfig(settings.vector || DEFAULT_VECTOR_CONFIG);
    }
    return vectorConfigCache;
  }

  // 向量设置的纯落盘部分：写 settings + 刷缓存，返回前后配置与开关，副作用编排
  //（模型/维度变化时的向量库重建）由 main 的 saveVectorConfig 决定。
  function saveVectorSettings(patch: RowObject = {}): { previous: VectorConfig; next: VectorConfig; enabled: boolean } {
    const previous = getVectorConfig();
    const next = normalizeVectorConfig({ ...previous, ...patch });
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
    return { previous, next, enabled };
  }

  function saveMemoryConfig(patch: RowObject = {}) {
    const settings = readSettingsFile();
    settings.memory = { ...(settings.memory || {}), enabled: patch?.enabled === true };
    writeSettingsFile(settings);
    return memorySettingsPayload(settings);
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

  function saveNodeLayoutConfig(patch: RowObject = {}) {
    const settings = readSettingsFile();
    const current = normalizeNodeLayoutSettingsByView(settings.nodeLayout || settings.node_layout);
    const next = normalizeNodeLayoutSettingsByView(
      patch && (patch.tree || patch.flow)
        ? patch as Partial<NodeLayoutByView>
        : {
          ...current,
          [patch?.view === 'flow' ? 'flow' : 'tree']: {
            ...(current[patch?.view === 'flow' ? 'flow' : 'tree'] || DEFAULT_NODE_LAYOUT),
            ...((patch && typeof patch.patch === 'object') ? patch.patch as RowObject : patch || {})
          }
        } as Partial<NodeLayoutByView>
    );
    settings.nodeLayout = next;
    delete settings.node_layout;
    writeSettingsFile(settings);
    nodeLayoutConfigCache = next;
    return nodeLayoutSettingsPayload(nodeLayoutConfigCache);
  }

  return {
    projectEnvPath,
    projectConfigPath,
    readDotEnv,
    writeDotEnvValues,
    readProjectConfig,
    writeProjectConfig,
    settingsPath,
    readSettingsFile,
    writeSettingsFile,
    isVectorModuleEnabled,
    isMemoryEnabled,
    memorySettingsPayload,
    getVectorConfig,
    saveVectorSettings,
    saveMemoryConfig,
    normalizeNodeLayoutSettingsByView,
    getNodeLayoutConfig,
    nodeLayoutSettingsPayload,
    saveNodeLayoutConfig
  };
}
