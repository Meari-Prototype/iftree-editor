# IF-Tree Editor

[简体中文](README.md) · **English**

> A local-first document data management tool: it organizes multi-document corpora into address-stable if-trees so you can pinpoint the exact passage you need within large bodies of text (designed for up to tens of billions of characters). Search results trace back to their precise source, and the corpus can be handed to external agent frameworks for collaborative processing via MCP.

![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)
![Electron](https://img.shields.io/badge/Electron-39-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)
![platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![status](https://img.shields.io/badge/status-0.3.0%20alpha-orange)

> **Project status: 0.3.0, early development.** The project is under active development; treat it as an early release:
>
> - **Frontend**: still has a number of known, unfixed bugs.
> - **Backend write path**: lacks long-term real-world testing — the project is young, so there simply hasn't been enough accumulated runtime yet.
> - **Ready to use**: the core **MCP read-only query service** and **db command contract** are stable and usable; read-only retrieval is the most dependable part right now.
>
> See the [CHANGELOG](CHANGELOG.md) for version history.

---

## Table of Contents

- [Introduction](#introduction)
- [Documentation](#documentation)
- [Features](#features)
- [Screenshots](#screenshots)
- [Tech Stack](#tech-stack)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Data Storage](#data-storage)
- [Semantic Vectors](#semantic-vectors)
- [Import & Export](#import--export)
- [MCP & External Agents](#mcp--external-agents)
- [Project Structure](#project-structure)
- [Development & Testing](#development--testing)
- [License](#license)
- [Acknowledgments](#acknowledgments)

---

## Introduction

IF-Tree Editor is a local-first document data management tool aimed at large multi-document corpora (designed for up to tens of billions of characters). The problem it solves: accurately finding the passage you need within a large body of text, and making sure the result is verifiable and not replaced by a model's guesswork. To that end, it organizes source text into an address-stable condition tree:

- Each node has an address like `1`, `1-3`, `1-3-2`: `1` is the root, `1-3` is the third child of `1`, and the address prefix expresses the parent–child relationship. Addresses are recomputed dynamically from `parent_id + sort_order` and stay consistent after inserts, drags, and re-parenting, so every sentence has a stable, citable coordinate.
- Keyword search and local semantic search (based on `bge-m3`), combined with sentence-level offset mapping, narrow a hit down to specific sentences rather than a whole document.
- Data is stored locally (SQLite + LanceDB), with no cloud dependency. When answering factual questions, the built-in agent must first read textual evidence and cite the evidence node address rather than relying on the model's general knowledge — keeping answers verifiable.
- Via MCP, the document library is exposed to external agent frameworks under tiered permissions (Q&A / collaborate / full) for retrieval and collaborative processing.

The same content can switch between two reading densities: collapsed, it reads like a Markdown document; expanded, it becomes an operable condition tree. On import, the sentence-to-source offset mapping is preserved so both views correspond to the same original text.

## Documentation

In-depth documentation lives in `docs/` (currently in Chinese):

- [Getting started](docs/getting-started.md) — install to first search in 15 minutes.
- [How-to guides](docs/how-to.md) — LLM setup, vectors, imports, smart import, connecting external agents, memory volumes, streaming writes, backup.
- [Reference](docs/reference.md) — MCP tools, db commands, the import-json contract, config and environment variables.
- [Concepts & design](docs/concepts.md) — addresses, trust levels, three-way merge, the three memory layers, the shared backend.
- [Changelog](CHANGELOG.md)

## Features

- **Precise retrieval**: keyword search + local semantic search based on `bge-m3`, with sentence-level offset mapping, locating a hit to specific sentences; WebGPU/fp16 inference by default, switchable to CPU.
- **Evidence-based answers**: when answering factual questions, the built-in agent reads textual evidence and gives the evidence node address, rather than answering from the model's general knowledge or the wording of the question; results are verifiable.
- **Local-first storage**: documents, nodes, axioms, ERRORs, references, and history live in SQLite; node-level semantic vectors live in LanceDB — usable with no cloud service.
- **Agent collaboration & MCP**: the built-in agent and the MCP server share one permission tiering (Q&A / collaborate / full); external agent frameworks can search and read evidence, and any write from the collaborate tier up goes into an edit branch awaiting human review. The LLM layer supports both OpenAI-compatible and Anthropic-compatible APIs.
- **Address-stable condition tree**: node addresses look like `1-3-2`, recomputed dynamically from `parent_id + sort_order` and kept consistent across inserts and re-parenting, so every sentence can be cited precisely.
- **Dual-density reading**: collapsed it renders as a Markdown document, expanded as an operable condition tree; the tree view expands to the document's true maximum depth by default, with expand/collapse by level and expand-all / collapse-all.
- **Multiple views**: tree view, relationship graph, IDE view, rich text, keyword search, semantic search; the relationship graph generates directed edges in if-tree reading order and overlays explicit reference edges.
- **Structural editing**: read-only / edit lock; add empty nodes, drag a single node or `Ctrl`-multi-select to re-parent, drop onto a node to merge / juxtapose / attach; built-in undo / redo (`Ctrl+Z`, `Ctrl+Y`, `Ctrl+Shift+Z`).
- **Edit branches & three-way merge**: structural changes from agents go into a shadow branch awaiting review; merging into the mainline reconciles three ways by stable node id using merkle hashing — fast-forwards write through, structural mismatches block as a whole, and field-level conflicts are decided by a human one by one.
- **Streaming writes**: append-only data streams (chat logs, event logs) go straight into an "incremental edit" document without a branch, with keyword and semantic indexes maintained incrementally; bulk import has a dedicated acceleration session.
- **Event memory volumes**: an external agent can deliver a structured self-report log as a memory volume at the end of a session; volumes seal automatically on a 24-hour rhythm and become distillable. The distill-and-approve pipeline lands in a later release.
- **Shared backend**: one backend process per database — the app, MCP, and CLI share it over a named pipe and can stay online at the same time without conflict.
- **Multi-format import & export**: import CHM, TXT, Markdown, PDF, DOCX; irregular sources go through smart import (an LLM produces JSON that is validated byte-for-byte before ingestion); Excel / CSV are explicitly relay formats for database export, not ordinary document import; export to Markdown and JSON.
- **AI summary notes**: call an OpenAI- or Anthropic-compatible API to generate summary notes for a single node, a subtree, the current level, or the whole document.
- **Rich node metadata**: node type, trust level, manual tags, axioms, ERRORs, references, and save history.

## Screenshots

| | |
| --- | --- |
| **Tree view & dual-density reading**<br>![Tree view](docs/images/editor-tree.png) | **Keyword search**<br>![Keyword search](docs/images/keyword-search.png) |
| **IDE view & agent collaboration**<br>![IDE view with agent chat](docs/images/ide-agent.png) | **Launcher**<br>![Launcher](docs/images/launcher.png) |

## Tech Stack

| Area | Choice |
| --- | --- |
| Desktop framework | Electron 39 |
| UI | React 19 + Vite 7 |
| Local database | better-sqlite3 |
| Vector database | LanceDB |
| Semantic vectors | @huggingface/transformers (`bge-m3`, WebGPU/ONNX) |
| Agent / tool protocol | @modelcontextprotocol/sdk (MCP) |
| Others | pdfjs-dist, fflate, lucide-react, @radix-ui |

## Requirements

- **OS**: Windows 10 / 11 (development and verification are done on Windows; scripts are mainly PowerShell).
- **Node.js**: 20 LTS or newer recommended. Native modules are built for Electron's ABI and run inside Electron; they are rebuilt automatically when the app starts (see [Development & Testing](#development--testing) for the ABI note).
- **Package manager**: npm.
- **GPU (optional)**: a WebGPU-capable GPU accelerates semantic vectors; without WebGPU you can switch to CPU on the settings page.

## Quick Start

Install dependencies (first time):

```powershell
npm install
```

Build the frontend and launch the app:

```powershell
npm run build
npm run app
```

> `npm run app` first recompiles native modules (better-sqlite3, LanceDB, etc.) for Electron's ABI. After changing the main process or preload, restart the Electron window.

Development mode (start the Vite dev server first, then have Electron load it):

```powershell
npm run dev
$env:ELECTRON_START_URL = 'http://127.0.0.1:5173'
npm run app
```

On Windows you can also just double-click `start.bat`, which runs "install dependencies → build → launch" automatically.

## Configuration

### LLM API (`.env`)

Copy `.env.example` to `.env` and fill in your key. LLM summaries and the built-in agent support two API protocols, selectable per provider on the settings page:

- **OpenAI-compatible**: requests `{baseUrl}/chat/completions`.
- **Anthropic-compatible**: requests `{baseUrl}/v1/messages`, using the `x-api-key` and `anthropic-version` headers; a max output token value must be set in the API configuration.

Ollama local models and services such as DeepSeek can both be reached through these protocols (DeepSeek's Anthropic-compatible endpoint defaults to `https://api.deepseek.com/anthropic`). The common environment variables for the OpenAI-compatible path:

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-v4-pro
```

The multi-provider configuration maintained on the settings page is written back to `.env`; see the comments in that file. `.env` is in `.gitignore` and is not committed.

### Application config (`iftree.config.json`)

Controls summary strategies, agent tool parameters, and render mode — e.g. summary word-count bounds, compression ratio, number of search results, and whether to force hardware acceleration. Render mode, hardware acceleration, and debug logging map to toggles in the launcher; early releases ship with debug logging on by default (logs go to `.iftree-debug/`), which makes problem reports easier. Field details: [reference](docs/reference.md#配置与环境变量).

### Data directory (`IFTREE_HOME`)

Set the `IFTREE_HOME` environment variable to override the default data directory, which is handy for testing or isolating different datasets.

## Data Storage

The app involves three kinds of local data: the **document library** you manage, the **main database** parsed from it, and rebuildable **derived data** (vectors and attachments).

### Document library (`library/`)

`library/` lives at the project root and is the workspace that stores and organizes all source documents (`.chm` / `.txt` / `.md` / `.pdf` / `.docx`), which can be arranged into folders. It is this tool's most important data: the app browses and organizes the library as a folder tree, and the built-in agent can only read/write inside `library/` using relative paths, never exposing absolute paths.

`library/` is in `.gitignore` — it is your data and is not distributed with the repository. It is entirely separate from `docs/`: the former is the managed document corpus, the latter is just project documentation; do not merge `library/` into `docs/`.

### Main database (`database/store.sqlite`)

The structured data parsed on import — documents, nodes, axioms, ERRORs, references, history, memory volumes — lives in `database/store.sqlite` at the project root (gitignored). Use the `IFTREE_DB` environment variable to point at a different path.

### Derived data (`%USERPROFILE%\.iftree\`)

Vectors and attachments are written to the user data directory (overridable with `IFTREE_HOME`):

```text
%USERPROFILE%\.iftree\
  vectors\nodes.lance\  # node-level semantic vectors
  assets\doc-<id>\      # document attachments (images, etc.)
```

The original Markdown reading source is stored in SQLite's `source_documents` / `source_spans`; sentence splitting only stores the offset mapping and does not restructure the body text. A tree node can aggregate and display sentence-number ranges such as `23-25;27-28;32`.

## Semantic Vectors

- The default model is `Xenova/bge-m3` (Transformers.js ONNX weights of `BAAI/bge-m3`); the database dimension is derived from the current model and strictly validated.
- Inference runs in a module worker pool in the renderer process: the GPU config uses `device: 'webgpu'`, the CPU config uses `device: 'wasm'`, with 2 workers and batches of 16 texts by default.
- The settings page lets you switch the model, compute target (GPU/CPU), worker count, batch size, and local ONNX model path, and offers a manual download button for the current model.
- The local model path is served to the worker via a read-only `127.0.0.1` file service started by the main process; the directory can be the model root or a specific model directory containing `config.json`.
- Switching models drops the old LanceDB table to avoid mixing same-dimension vectors from different models.

## Import & Export

**Import**

| Format | Notes |
| --- | --- |
| CHM `.chm` | Builds the structure tree from the `.hhc` table of contents and HTML body |
| Text `.txt` | Builds the hierarchy from heading lines, paragraphs, and sentences |
| Markdown `.md` | Builds the hierarchy from headings, paragraphs, and sentences |
| PDF `.pdf` | PDF import with text-layer mapping |
| DOCX `.docx` | Detects heading levels from the OOXML paragraph style `<w:pStyle>` |

Excel `.xlsx` and CSV `.csv` are relay formats for database export, not ordinary document import.

Sources too irregular for rule-based parsing go through **smart import**: an LLM inspects the source, writes a one-off splitting script that produces JSON, and `db import-json` validates it byte-for-byte before ingestion — body text may only be sliced from the source, never rewritten (see the [how-to guide](docs/how-to.md#用智能导入处理无规则结构的源文)).

**Export**: Markdown document and JSON structure.

## MCP & External Agents

The MCP server exposes the library to external agent frameworks such as Claude Code and Codex over stdio. The permission tier is locked at launch by the `IFTREE_MCP_TIER` environment variable: `read` (search and read, default), `edit` (+ edit-branch writes, streaming writes, memory delivery), `full` (+ merge, rollback, and other administrative actions).

Client configuration example (with the project root as working directory):

```json
{
  "mcpServers": {
    "iftree-library": {
      "command": "npm",
      "args": ["run", "--silent", "mcp"],
      "env": { "ELECTRON_RUN_AS_NODE": "1", "IFTREE_MCP_TIER": "read" }
    }
  }
}
```

The app, MCP, and CLI share one backend process per database and can stay online together. The tool list and the `db` command contract are in the [reference](docs/reference.md); the smart-import and memory-delivery contracts for external agents ship with the repository under [`.iftree-llm-workspace/skills/`](.iftree-llm-workspace/skills/).

## Project Structure

```text
.
├── electron/
│   ├── main.mjs          # Main process: window, IPC, SQLite/LanceDB/file access, LLM dispatch
│   └── preload.cjs       # Secure bridge exposing the window.iftree API to the renderer
├── index.html            # Renderer entry HTML
├── src/
│   ├── renderer/
│   │   └── main.jsx      # React mount entry
│   ├── frontend/         # UI layer
│   │   ├── App.jsx
│   │   ├── components/   # Views and panels (tree view, relationship graph, rich text, settings, etc.)
│   │   ├── hooks/        # React hooks: document state, layout, selection, settings, etc.
│   │   ├── data/         # Repository / service wrappers calling window.iftree
│   │   ├── features/     # Feature actions: entities, library, settings, etc.
│   │   ├── lib/          # Frontend utilities
│   │   └── styles.css
│   ├── backend/          # Main-process business logic
│   │   ├── store.mjs     # SQLite schema and document/node write operations
│   │   ├── db/           # schema, ids, normalizers, snapshot history
│   │   ├── entities/     # Entity read/write and projection
│   │   ├── handlers/     # Read / write command handlers
│   │   └── llm/          # Agent runtime, shared backend (named pipe), headless agent, LLM settings
│   ├── core/             # Pure logic (no Electron dependency)
│   │   ├── tree.mjs      # Tree building, dynamic addresses, Markdown/JSON export
│   │   ├── mindmap.mjs   # Tree-view projection, depth control, layout
│   │   ├── merkle.mjs / merkle-diff.mjs / merkle-merge.mjs # Tree hashing, diff, three-way merge
│   │   ├── source-text.mjs / source-docx.mjs / source-chm.mjs # Works with import-formats/ to parse txt/md/csv/xlsx/docx/chm
│   │   ├── source-markdown.mjs # Source parsing and sentence offset mapping
│   │   └── ...           # viewport, hitbox, drag-drop, markdown, etc.
│   ├── vector/           # Semantic vectors: embeddings, vector-store, worker, model download
│   └── agent/            # Agent config and session storage
├── scripts/              # CLI tools: MCP server, db commands, native rebuild, verification scripts
├── tests/                # node:test unit tests
├── docs/                 # Project documentation: tutorial / how-to / reference / concepts
├── .iftree-llm-workspace/
│   └── skills/           # Import and memory-delivery contracts for LLMs (shipped with the repo)
├── library/              # Document library workspace: your source documents (created at runtime, gitignored)
├── database/             # Main database store.sqlite (created at runtime, gitignored)
├── iftree.config.json    # Summary strategy / agent tool / render mode config
└── .env.example          # Environment variable template (LLM API)
```

## Development & Testing

```powershell
npm run lint          # ESLint static checks (src / electron / scripts / tests)
npm run check:types   # TypeScript type check (TS files under migration)
npm run build         # production build
npm run check:native  # verify native modules match the Electron ABI
npm test              # run unit tests on the Electron runtime
```

> Some end-to-end / sample verification scripts (e.g. `verify:samples`, `verify:chm`) depend on local sample data; prepare the corresponding files before running them. Verification involving the database, import, LanceDB, or native modules should use the Electron ABI (e.g. `npm run check:native`).

> **Native module ABI**: native modules (better-sqlite3, LanceDB) are binaries compiled for a specific runtime ABI. This project is built and verified against **Electron 39 (ABI 140)**; `npm run app` first rebuilds them for Electron's ABI. **Paths that depend on native modules are currently not tested against system Node (Node 24, ABI 137)** — after rebuilding for the Electron ABI, running those tests directly with system `node` fails with a `NODE_MODULE_VERSION` mismatch.

## License

Released under the [Apache License 2.0](LICENSE), copyright Meari (see [NOTICE](NOTICE)).

## Acknowledgments

- The UI bundles the [Noto Sans CJK](src/frontend/assets/fonts/NOTICE.md) font (SIL Open Font License).
- Semantic vectors are based on the [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3) model.
- Built with open-source projects including Electron, React, Vite, LanceDB, and Transformers.js.
- Developed with the help of ChatGPT 5.5 xhigh, Claude Opus 4.8 max, Claude Fable 5, and DeepSeek V4.
