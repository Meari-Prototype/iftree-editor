# IF-Tree Editor · 条件树编辑器

> 本地优先的文档数据管理工具：把多文档语料整理成带稳定地址的 if-tree 条件树，便于在大规模原文（设计目标为百亿字级）中精确定位所需片段。检索结果可回溯到具体出处，也可通过 MCP 交由外部 agent 框架协作处理。

![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)
![Electron](https://img.shields.io/badge/Electron-39-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)
![platform](https://img.shields.io/badge/platform-Windows-lightgrey)

---

## 目录

- [简介](#简介)
- [功能特性](#功能特性)
- [界面预览](#界面预览)
- [技术栈](#技术栈)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [配置](#配置)
- [数据存储](#数据存储)
- [语义向量](#语义向量)
- [导入与导出](#导入与导出)
- [项目结构](#项目结构)
- [开发与测试](#开发与测试)
- [许可证](#许可证)
- [致谢](#致谢)

---

## 简介

IF-Tree Editor 是一个本地优先的文档数据管理工具，面向规模较大的多文档语料（设计目标为百亿字级）。它要解决的问题是：在大量原文中准确找到需要的片段，并保证结果可核对、不被模型臆测替代。为此，它把原文整理成带稳定地址的条件树：

- 每个节点有形如 `1`、`1-3`、`1-3-2` 的地址：`1` 为根节点，`1-3` 是 `1` 的第 3 个子节点，地址前缀表示父子关系。地址由 `parent_id + sort_order` 动态重算，增删、拖拽、重挂之后保持一致，使每个句子都有可引用的固定坐标。
- 关键词检索与基于 `bge-m3` 的本地语义检索配合句子级 offset 映射，可将命中定位到具体句子，而非整篇文档。
- 数据存于本地（SQLite + LanceDB），不依赖云服务。内置 Agent 回答事实问题时需先读取正文证据并给出证据节点地址，不以模型常识作答，便于核对。
- 通过 MCP 将文档库以分级权限（问答 / 协作 / 完全）开放给外部 agent 框架，用于检索与协同处理。

同一份内容可在两种阅读密度之间切换：折叠时呈现为 Markdown 文档，展开时呈现为条件树；导入时保留句子到原文的 offset 映射，使两种视图对应同一份原文。

## 功能特性

- **精确检索**：关键词检索 + 基于 `bge-m3` 的本地语义检索，配合句子级 offset 映射，把命中定位到具体几句；默认 WebGPU/fp16 推理，可切换 CPU。
- **基于证据的回答**：内置 Agent 回答事实问题时需读取正文证据并给出证据节点地址，不以模型常识或题目措辞作答，结果可核对。
- **本地优先存储**：文档、节点、事实前提、ERROR、引用关系与历史存于 SQLite，节点级语义向量存于 LanceDB，无需任何云服务即可使用。
- **Agent 协作与 MCP**：带权限分级（问答 / 协作 / 完全）的内置 Agent，并通过 MCP 把文档库暴露给外部 agent 框架协同处理；LLM 支持 OpenAI 兼容与 Anthropic 兼容接口。
- **稳定地址的条件树**：节点地址形如 `1-3-2`，由 `parent_id + sort_order` 动态重算，增删、重挂之后保持一致，使每个句子可被精确引用。
- **双密度阅读**：折叠呈现为 Markdown 文档，展开呈现为可操作条件树；树视图默认展开到真实最大深度，可逐层展开 / 收起 / 全部展开 / 全部折叠。
- **多视图**：树视图、关系图谱、IDE 视图、富文本、关键词搜索、语义搜索；关系图谱按 if-tree 阅读顺序生成有向边，并叠加显式引用边。
- **结构编辑**：只读 / 编辑锁；新增空节点、单选或 `Ctrl` 多选拖拽重挂，拖到节点上可选择合并 / 并列 / 挂载；内置撤销 / 重做（`Ctrl+Z`、`Ctrl+Y`、`Ctrl+Shift+Z`）。
- **多格式导入导出**：导入 CHM、TXT、Markdown、PDF、DOCX；Excel / CSV 明确作为数据库导出的中继格式，不作为普通文档导入；导出 Markdown 与 JSON。
- **AI 摘要备注**：调用 OpenAI / Anthropic 兼容接口，为单个节点、子树、当前层级或全文生成摘要备注。
- **丰富的节点元数据**：节点类型、信任级别、人工标签、事实前提、ERROR、引用关系与保存历史。

## 界面预览

<!-- 建议在此处放置 1~2 张应用截图，例如 docs/screenshot-tree.png 与 docs/screenshot-richtext.png -->

> 截图待补充。

## 技术栈

| 领域 | 选型 |
| --- | --- |
| 桌面框架 | Electron 39 |
| 界面 | React 19 + Vite 7 |
| 本地数据库 | better-sqlite3 |
| 向量数据库 | LanceDB |
| 语义向量 | @huggingface/transformers（`bge-m3`，WebGPU/ONNX） |
| Agent / 工具协议 | @modelcontextprotocol/sdk（MCP） |
| 其它 | pdfjs-dist、fflate、lucide-react、@radix-ui |

## 环境要求

- **操作系统**：Windows 10 / 11（开发与验证均在 Windows 上进行；脚本以 PowerShell 为主）。
- **Node.js**：建议 20 LTS 或更高。
- **包管理器**：npm。
- **GPU（可选）**：支持 WebGPU 的显卡可加速语义向量；无 WebGPU 时可在设置页切换到 CPU。

## 快速开始

首次安装依赖：

```powershell
npm install
```

构建前端并启动应用：

```powershell
npm run build
npm run app
```

> `npm run app` 会先按 Electron ABI 重新编译 native module（better-sqlite3、LanceDB 等）。修改主进程或 preload 后，需要重启 Electron 窗口。

开发模式（先起 Vite dev server，再让 Electron 加载它）：

```powershell
npm run dev
$env:ELECTRON_START_URL = 'http://127.0.0.1:5173'
npm run app
```

Windows 上也可以直接双击 `start.bat`，它会自动完成"安装依赖 → 构建 → 启动"。

## 配置

### LLM 接口（`.env`）

复制 `.env.example` 为 `.env` 并填入你的 Key。LLM 摘要与内置 Agent 支持两种接口协议，可在设置页按供应商选择：

- **OpenAI 兼容**：请求 `{baseUrl}/chat/completions`。
- **Anthropic 兼容**：请求 `{baseUrl}/v1/messages`，使用 `x-api-key` 与 `anthropic-version` 请求头，需要在 API 配置中填写最大输出 token。

Ollama 本地模型与 DeepSeek 等服务都可通过上述协议接入（DeepSeek 的 Anthropic 兼容端点默认为 `https://api.deepseek.com/anthropic`）。下面是 OpenAI 兼容方式的常用环境变量：

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-v4-pro
```

设置页中维护的多供应商配置会写回 `.env`，详见文件内注释。`.env` 已在 `.gitignore` 中，不会被提交。

### 应用配置（`iftree.config.json`）

控制摘要策略、Agent 工具参数与渲染模式，例如摘要的字数上下限、压缩比例、搜索结果条数、是否强制硬件加速等。

### 数据目录（`IFTREE_HOME`）

设置环境变量 `IFTREE_HOME` 可覆盖默认数据目录，便于测试或隔离不同数据集。

## 数据存储

默认写入用户目录：

```text
%USERPROFILE%\.iftree\
  store.sqlite          # 文档、节点、前提、ERROR、引用、历史
  vectors\nodes.lance\  # 节点级语义向量
  assets\doc-<id>\      # 文档附件（图片等）
```

原始 Markdown 阅读源保存在 SQLite 的 `source_documents` / `source_spans`，句子切分只保存 offset 映射，不重组正文结构；树节点可聚合显示 `23-25;27-28;32` 这类句子编号范围。

## 语义向量

- 默认模型为 `Xenova/bge-m3`（`BAAI/bge-m3` 的 Transformers.js ONNX 权重），数据库维度由当前模型推导并精确校验。
- 推理在渲染进程的 module worker 池中执行：GPU 配置使用 `device: 'webgpu'`，CPU 配置使用 `device: 'wasm'`，默认 2 个 worker、每批 16 条文本。
- 设置页可切换模型、计算目标（GPU/CPU）、worker 数、batch size 与本地 ONNX 模型路径，并提供当前模型的手动下载按钮。
- 本地模型路径会通过主进程启动一个只读的 `127.0.0.1` 文件服务映射给 worker；目录可以是模型根目录，也可以是包含 `config.json` 的具体模型目录。
- 切换模型会丢弃旧的 LanceDB 表，避免不同模型的同维向量混用。

## 导入与导出

**导入**

| 格式 | 说明 |
| --- | --- |
| CHM `.chm` | 以 `.hhc` 目录和 HTML 正文生成结构树 |
| 文本 `.txt` | 按标题行、段落和句子生成层级结构 |
| Markdown `.md` | 按 heading、段落和句子生成层级结构 |
| PDF `.pdf` | 带文本层映射的 PDF 导入 |
| DOCX `.docx` | 按 OOXML 段落样式 `<w:pStyle>` 识别标题层级 |

Excel `.xlsx` 与 CSV `.csv` 是数据库导出的中继格式，不作为普通文档导入。

**导出**：Markdown 文档 与 JSON 结构。

## 项目结构

```text
.
├── electron/
│   ├── main.mjs          # 主进程：窗口、IPC、SQLite/LanceDB/文件访问、LLM 调度
│   └── preload.cjs       # 安全桥接，向渲染进程暴露 window.iftree API
├── index.html            # 渲染进程入口 HTML
├── src/
│   ├── renderer/
│   │   └── main.jsx      # React 挂载入口
│   ├── frontend/         # 界面层
│   │   ├── App.jsx
│   │   ├── components/   # 视图与面板（树视图、关系图谱、富文本、设置等）
│   │   ├── hooks/        # 文档状态、布局、选择、设置等 React hooks
│   │   ├── data/         # 调用 window.iftree 的仓储 / 服务封装
│   │   ├── features/     # 实体、库、设置等功能动作
│   │   ├── lib/          # 前端工具函数
│   │   └── styles.css
│   ├── backend/          # 主进程业务逻辑
│   │   ├── store.mjs     # SQLite schema 与文档/节点写操作
│   │   ├── db/           # schema、id、归一化、快照历史
│   │   ├── entities/     # 实体读写与投影
│   │   ├── handlers/     # 读 / 写命令处理器
│   │   └── llm/          # Agent 运行时、对话客户端、headless agent
│   ├── core/             # 纯逻辑（无 Electron 依赖）
│   │   ├── tree.mjs      # 树构建、动态地址、Markdown/JSON 导出
│   │   ├── mindmap.mjs   # 树视图投影、深度控制、布局
│   │   ├── importers.mjs # 配合 import-formats/ 支持 md/txt/xlsx/py/chm/pdf
│   │   ├── source-doc.mjs# 原文解析与句子 offset 映射
│   │   └── ...           # viewport、hitbox、drag-drop、markdown 等
│   ├── vector/           # 语义向量：embeddings、vector-store、worker、模型下载
│   └── agent/            # Agent 配置与会话存储
├── scripts/              # CLI 工具：MCP 服务、db 命令、native 重编、验证脚本
├── tests/                # node:test 单元测试
├── iftree.config.json    # 摘要策略 / Agent 工具 / 渲染模式配置
└── .env.example          # 环境变量模板（LLM 接口）
```

## 开发与测试

```powershell
npm run lint          # ESLint 静态检查
npm run build         # 生产构建
npm run check:native  # 校验 native module 与 Electron ABI 匹配
node --test "tests/**/*.test.mjs"   # 运行单元测试
```

> 部分端到端 / 样例验证脚本（如 `verify:samples`、`verify:chm`）依赖本地样例数据，需自行准备对应文件后再运行。涉及数据库、导入、LanceDB 或 native module 的验证应使用 Electron ABI（例如 `npm run check:native`）。

## 许可证

本项目基于 [Apache License 2.0](LICENSE) 发布，版权归 Meari 所有（见 [NOTICE](NOTICE)）。

## 致谢

- 界面内置 [Noto Sans CJK](src/frontend/assets/fonts/NOTICE.md) 字体（SIL Open Font License）。
- 语义向量基于 [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3) 模型。
- 以及 Electron、React、Vite、LanceDB、Transformers.js 等开源项目。

