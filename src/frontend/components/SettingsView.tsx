// @ts-nocheck
import { ArrowLeft, Bot, Brain, Cpu, Database, ExternalLink, Gauge, HardDrive, Power, Settings, SlidersHorizontal, Upload, Zap } from 'lucide-react';
import { useState } from 'react';
import { normalizeNodeLayoutSettingsByView } from '../lib/doc-utils.js';
import { progressCountText } from '../lib/ui-utils.js';
import { IconButton } from './common.jsx';
import { AgentSettingsPanel } from './settings/AgentSettingsPanel.jsx';
import { NodeLayoutSettingsPanel } from './settings/NodeLayoutSettingsPanel.jsx';

export function SettingsView({
  vectorSettings,
  memorySettings,
  llmSummarySettings,
  agentSettings,
  nodeLayoutSettings,
  notice,
  clearNotice,
  onBack,
  onChange,
  onMemoryChange,
  onLlmSummaryChange,
  onAgentChange,
  onNodeLayoutChange,
  canEditNodeLayout,
  treeEditMode,
  onToggleTreeEditMode,
  onChooseLocalModelRoot,
  onDownloadVectorModel,
  progress,
  busy
}) {
  const [settingsSection, setSettingsSection] = useState('vector');
  const settings = vectorSettings || {};
  const vectorEnabled = settings.enabled !== false;
  const memoryEnabled = memorySettings?.enabled === true;
  const nodeLayouts = normalizeNodeLayoutSettingsByView(nodeLayoutSettings);
  const modelOptions = Array.isArray(settings.modelOptions) ? settings.modelOptions : [];
  const computeOptions = Array.isArray(settings.computeOptions) ? settings.computeOptions : [];
  const selectedModel = modelOptions.find((option) => option.id === settings.modelId);
  const selectedCompute = computeOptions.find((option) => option.id === settings.computeTarget);
  const save = (patch) => onChange?.(patch);
  const saveNodeLayout = (view, patch) => onNodeLayoutChange?.(view, patch);
  const saveNumber = (key, value) => {
    const next = Number(value);
    if (Number.isFinite(next) && next > 0) save({ [key]: next });
  };
  const saveNodeNumber = (view, key, value) => {
    const next = Number(value);
    if (Number.isFinite(next) && next > 0) saveNodeLayout(view, { [key]: next });
  };

  const infoRows = [
    {
      icon: <HardDrive size={17} />,
      label: '模型来源',
      value: settings.localModelRoot || settings.modelName || '加载中',
      detail: settings.localModelRoot ? `本地路径优先，远程 repo：${settings.modelPath}` : settings.modelPath || ''
    },
    {
      icon: <Zap size={17} />,
      label: '运行后端',
      value: settings.backend || selectedCompute?.label || '加载中',
      detail: settings.renderer ? `device=${settings.device} / dtype=${settings.dtype} / pooling=${settings.pooling}` : ''
    },
    {
      icon: <Database size={17} />,
      label: '数据库维度',
      value: settings.dimensions ? `${settings.dimensions} 维` : '等待模型',
      detail: settings.minDimensions ? `由当前模型决定，最低要求 ${settings.minDimensions} 维` : ''
    },
    {
      icon: <HardDrive size={17} />,
      label: '浏览器模型缓存',
      value: settings.modelCachePath || '加载中',
      detail: 'Transformers.js Cache API 缓存，不是可直接选择的 ONNX 模型目录'
    },
    {
      icon: <HardDrive size={17} />,
      label: '检测到的 Ollama bge-m3',
      value: settings.detectedOllamaBgeM3Path || '未检测到',
      detail: 'Ollama blob 不是 Transformers.js ONNX 模型，不能直接用于当前 WebGPU worker'
    },
    {
      icon: <HardDrive size={17} />,
      label: '向量库',
      value: settings.lanceDbPath || '加载中',
      detail: settings.vectorTable ? `LanceDB 表：${settings.vectorTable}` : ''
    }
  ];

  return (
    <main className="settings-shell">
      <aside className="settings-sidebar">
        <div className="settings-topbar">
          <IconButton title="返回编辑器" onClick={onBack}><ArrowLeft size={16} /></IconButton>
          <span>设置</span>
        </div>
        <nav className="settings-nav" aria-label="设置分类">
          <button
            className={`settings-nav-item ${settingsSection === 'vector' ? 'active' : ''}`}
            onClick={() => setSettingsSection('vector')}
          >
            <Settings size={16} />
            <span>向量模块</span>
          </button>
          <button
            className={`settings-nav-item ${settingsSection === 'memory' ? 'active' : ''}`}
            onClick={() => setSettingsSection('memory')}
          >
            <Brain size={16} />
            <span>记忆模块</span>
          </button>
          <button
            className={`settings-nav-item ${settingsSection === 'agent' ? 'active' : ''}`}
            onClick={() => setSettingsSection('agent')}
          >
            <Bot size={16} />
            <span>Agent 模块</span>
          </button>
          <button
            className={`settings-nav-item ${settingsSection === 'treeNodeLayout' ? 'active' : ''}`}
            onClick={() => setSettingsSection('treeNodeLayout')}
          >
            <SlidersHorizontal size={16} />
            <span>树视图调整</span>
          </button>
        </nav>
      </aside>

      <section className="settings-main">
        <div className="settings-content">
          {notice && (
            <div className="settings-warning settings-notice" onClick={clearNotice}>
              {notice}
            </div>
          )}
          {settingsSection === 'treeNodeLayout' ? (
            <NodeLayoutSettingsPanel
              title="树视图节点调整"
              description="树视图节点卡片尺寸、比例和正文留白写入数据库；只读模式下保持锁定。"
              settings={nodeLayouts.tree}
              disabled={!canEditNodeLayout}
              onChange={(patch) => saveNodeLayout('tree', patch)}
              onNumberChange={(key, value) => saveNodeNumber('tree', key, value)}
              treeEditMode={treeEditMode}
              onToggleTreeEditMode={onToggleTreeEditMode}
            />
          ) : settingsSection === 'agent' ? (
            agentSettings && llmSummarySettings ? (
              <AgentSettingsPanel
                agentSettings={agentSettings}
                onAgentChange={onAgentChange}
                llmSummarySettings={llmSummarySettings}
                onLlmSummaryChange={onLlmSummaryChange}
              />
            ) : (
              <header className="settings-header">
                <h1>Agent 模块</h1>
                <p>正在读取 API、摘要和个性提示词配置。</p>
              </header>
            )
          ) : settingsSection === 'memory' ? (
            <>
          <header className="settings-header settings-header-row">
            <div>
              <h1>记忆模块</h1>
              <p>开启后内置 agent 获得跨会话记忆常驻指令（开工先看最近发生什么、检索纪律、信任与时间纪律）。默认关闭；关闭时退化为纯知识 / 条件树工具，不落卷、不催提炼。</p>
            </div>
            <div className="vector-toggle-stack">
              <div className={`vector-status ${memoryEnabled ? 'enabled' : ''}`}>
                <span />
                {memoryEnabled ? '状态：已启用' : '状态：已禁用'}
              </div>
              <button
                type="button"
                className={`vector-toggle-button ${memoryEnabled ? 'enabled' : ''}`}
                onClick={() => onMemoryChange?.({ enabled: !memoryEnabled })}
                title={memoryEnabled ? '禁用记忆模块' : '启用记忆模块'}
                aria-pressed={memoryEnabled}
              >
                <Power size={16} />
                <span>{memoryEnabled ? '禁用记忆' : '启用记忆'}</span>
              </button>
            </div>
          </header>

          <section className="settings-group">
            <header>
              <h2>说明</h2>
            </header>
            <div className="settings-list">
              <div className="settings-row">
                <div className="settings-row-icon"><Brain size={17} /></div>
                <div className="settings-row-text">
                  <strong>记忆库使用</strong>
                  <span>三层时态、召回动线、写入边界与提炼、操作要点见 docs/memory.md。</span>
                </div>
              </div>
            </div>
          </section>
            </>
          ) : (
            <>
          <header className="settings-header settings-header-row">
            <div>
              <h1>向量模块</h1>
              <p>模型、计算目标和批处理参数会自动保存，并从下一次语义搜索或导入向量生成开始生效。</p>
            </div>
            <div className="vector-toggle-stack">
              <div className={`vector-status ${vectorEnabled ? 'enabled' : ''}`}>
                <span />
                {vectorEnabled ? '状态：已启用' : '状态：已禁用'}
              </div>
              <button
                type="button"
                className={`vector-toggle-button ${vectorEnabled ? 'enabled' : ''}`}
                onClick={() => save({ enabled: !vectorEnabled })}
                title={vectorEnabled ? '禁用向量模块' : '启用向量模块'}
                aria-pressed={vectorEnabled}
              >
                <Power size={16} />
                <span>{vectorEnabled ? '禁用向量' : '启用向量'}</span>
              </button>
            </div>
          </header>

          <section className="settings-group">
            <header>
              <h2>模型与计算</h2>
              <span>自动保存</span>
            </header>
            <div className="settings-list">
              <div className="settings-row">
                <div className="settings-row-icon"><Database size={17} /></div>
                <div className="settings-row-text">
                  <strong>向量模型</strong>
                  <span>{selectedModel?.baseModelName ? `基座模型：${selectedModel.baseModelName}` : '选择可用的 1024 维及以上模型'}</span>
                </div>
                <div className="settings-row-control">
                  <select
                    value={settings.modelId || ''}
                    disabled={!modelOptions.length}
                    onChange={(event) => save({ modelId: event.target.value })}
                  >
                    {modelOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label} / {option.dimensions} 维
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-icon"><Cpu size={17} /></div>
                <div className="settings-row-text">
                  <strong>计算目标</strong>
                  <span>{settings.computePolicy || '选择 GPU/WebGPU 或 CPU/wasm'}</span>
                </div>
                <div className="settings-row-control">
                  <select
                    value={settings.computeTarget || ''}
                    disabled={!computeOptions.length}
                    onChange={(event) => save({ computeTarget: event.target.value })}
                  >
                    {computeOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-icon"><HardDrive size={17} /></div>
                <div className="settings-row-text">
                  <strong>本地模型路径</strong>
                  <span>可选择已有目录，也可下载当前模型到本地 ONNX 目录</span>
                </div>
                <div className="settings-row-control settings-path-control">
                  <input
                    type="text"
                    value={settings.localModelRoot || ''}
                    readOnly
                    placeholder="未选择时使用 Hugging Face 下载与浏览器缓存"
                    onClick={onChooseLocalModelRoot}
                  />
                  <button type="button" onClick={onChooseLocalModelRoot}>选择</button>
                  <button type="button" disabled={busy} onClick={onDownloadVectorModel}>下载</button>
                  <button type="button" onClick={() => save({ localModelRoot: '' })}>清空</button>
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-icon"><ExternalLink size={17} /></div>
                <div className="settings-row-text">
                  <strong>Hugging Face 镜像地址</strong>
                  <span>国内可填 https://hf-mirror.com，留空使用官方地址（需 VPN）</span>
                </div>
                <div className="settings-row-control settings-path-control">
                  <input
                    type="text"
                    value={settings.remoteModelHost || ''}
                    placeholder="例：https://hf-mirror.com"
                    onChange={(event) => save({ remoteModelHost: event.target.value.trim() })}
                  />
                  <button type="button" onClick={() => save({ remoteModelHost: '' })}>清空</button>
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-icon"><Upload size={17} /></div>
                <div className="settings-row-text">
                  <strong>导入时生成向量</strong>
                  <span>关闭后导入更快，可在需要语义搜索时再手动触发</span>
                </div>
                <div className="settings-row-control">
                  <select
                    value={settings.importVectors === false ? 'off' : 'on'}
                    onChange={(event) => save({ importVectors: event.target.value !== 'off' })}
                  >
                    <option value="on">启用</option>
                    <option value="off">跳过</option>
                  </select>
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-icon"><Gauge size={17} /></div>
                <div className="settings-row-text">
                  <strong>worker 数</strong>
                  <span>并行 module worker 数，范围 1 到 8</span>
                </div>
                <div className="settings-row-control">
                  <input
                    type="number"
                    min="1"
                    max="8"
                    value={settings.workerCount || 1}
                    onChange={(event) => saveNumber('workerCount', event.target.value)}
                  />
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-icon"><Gauge size={17} /></div>
                <div className="settings-row-text">
                  <strong>批处理大小</strong>
                  <span>每个请求批次的文本条数，范围 1 到 128</span>
                </div>
                <div className="settings-row-control">
                  <input
                    type="number"
                    min="1"
                    max="128"
                    value={settings.batchSize || 1}
                    onChange={(event) => saveNumber('batchSize', event.target.value)}
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="settings-group">
            <header>
              <h2>当前生效值</h2>
              <span>由所选模型推导</span>
            </header>
            <div className="settings-list">
              {infoRows.map((row) => (
                <div key={row.label} className="settings-row">
                  <div className="settings-row-icon">{row.icon}</div>
                  <div className="settings-row-text">
                    <strong>{row.label}</strong>
                    <span>{row.detail}</span>
                  </div>
                  <code>{row.value}</code>
                </div>
              ))}
            </div>
          </section>
            </>
          )}
        </div>
      </section>

      {progress && (
        <div className="progress-overlay">
          <div className="progress-header">
            <span className="progress-label">{progress.label}</span>
            {progress.total > 0 && (
              <span className="progress-count">{progressCountText(progress)}</span>
            )}
          </div>
          <div className="progress-track">
            <div
              className={`progress-fill${progress.total === 0 ? ' progress-fill--indeterminate' : ''}`}
              style={progress.total > 0 ? { width: `${Math.round(progress.step / progress.total * 100)}%` } : undefined}
            />
          </div>
        </div>
      )}
    </main>
  );
}
