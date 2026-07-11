# 导入压测（MS MARCO v2.1 segmented）

流式写入（projectneed 4-16）的导入吞吐压测。建树策略：**headings 当嵌套链**
（`doc → headings[0] → … → headings[k] → 各 segment 叶子`）。heading 节点标题入
`node_title`（进 FTS、不进向量），segment 正文入 `text`（进 FTS + 向量）。

所有脚本需在 **electron-as-node** 下跑（匹配 better-sqlite3 / onnxruntime 的 ABI）。
数据与报告都在 `/benchmark/`（已被 .gitignore 忽略，不进版本库）。

## 目标库（env）

| 变量 | 说明 |
|---|---|
| `IFTREE_DB` | sqlite 文件路径，如 `F:/Fworkspace/IFTreeEditorDB/store.sqlite` |
| `IFTREE_HOME` | settings/vectors/models 根，如 `F:/Fworkspace/IFTreeEditorDB` |

## 嵌入后端（env，仅 headless 路径；GUI 仍走 WebGPU worker）

默认 `transformers`（本地 onnxruntime，GPU=DirectML）。N 卡上 DirectML 远慢于 CUDA，
建议切到 ollama / llama.cpp：

| 变量 | 取值 / 示例 |
|---|---|
| `IFTREE_EMBED_BACKEND` | `transformers`(默认) / `ollama` / `openai`(=llama.cpp server) |
| `IFTREE_EMBED_BASE_URL` | ollama `http://localhost:11434`；llama.cpp `http://localhost:8080` |
| `IFTREE_EMBED_MODEL` | `bge-m3`（须与库现有向量同维 1024） |
| `IFTREE_EMBED_API_KEY` | 可选（openai 兼容端点鉴权） |
| `IFTREE_EMBED_BATCH` | 批大小，建议 64 |
| `IFTREE_EMBED_FALLBACK` | `0` 关闭「远程不可用回落本地」（默认开） |

- **ollama**：`ollama pull bge-m3`，确认 `ollama ps` 显示 `100% GPU`。
- **手写 llama.cpp**：`llama-server -m bge-m3.gguf --embedding`，设
  `IFTREE_EMBED_BACKEND=openai IFTREE_EMBED_BASE_URL=http://localhost:8080`。
  切后端前会做一次健康检查 + 维度校验，不匹配直接报错（不污染向量表）。

## 命令

导入吞吐（向量关），多量级一把过，结果追加 CSV：

```
electron scripts/bench/msmarco-import.mjs --file <分片.json.gz|.jsonl> --limit 20000,100000,all --label sweep
```

导入 + 向量离线补建（先用 ollama 把 env 设好）：

```
electron scripts/bench/msmarco-import.mjs --file <分片.jsonl> --limit all --vector-backfill --label full-shard
```

- `--limit all` 整片；也可给具体行数或逗号分隔多档。
- `--embed` 改为「推一点算一点」内联向量（小流用；海量用 `--vector-backfill` 离线补）。
- 向量补建**断点续传**：按 id 游标扫描、只 embed 缺失、upsert 幂等。中断后**重跑同命令**即续。
- 报告默认 `benchmark/reports/msmarco-import.csv`（`--report` 可改）。

## 对比向量必要性（关键字 vs 语义）

导出 docId 后，对同一查询分别跑关键字与语义检索比较召回：

```
electron scripts/db.mjs shell -- db find --scope <docId> ""  <关键字>      # 关键字
electron scripts/db.mjs shell -- db find --semantic <docId> "<自然语言>"   # 语义（需向量已补建）
```

## 嵌入引擎微基准（定位吞吐瓶颈）

隔离 DB，只测 transformers.js pipeline 在不同 device/dtype/batch 的纯吞吐：

```
electron scripts/bench/embed-bench.mjs --file <分片.jsonl> --texts 96 --configs dml:fp16,cpu:q8 --batches 16,32,64
```

## 测试套件

`tests/msmarco-import.bench.test.mjs`：纯转换逻辑单测恒跑；集成压测在设置
`IFTREE_BENCH_MSMARCO_FILE`（指向 .json.gz/.jsonl）后才运行，否则 skip。
可选 `IFTREE_BENCH_LIMIT` / `IFTREE_BENCH_BATCH` / `IFTREE_BENCH_VECTORS` /
`IFTREE_BENCH_VECTOR_BACKFILL`。
