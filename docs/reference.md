# 参考手册

> [上手教程](getting-started.md) · [操作指南](how-to.md) · **参考手册** · [概念与设计](concepts.md)

命令、工具、字段的查表式清单。工具与命令自带的 description / help 是最权威的版本，本文是它们的索引。

## MCP server

- 启动：`npm run mcp`（等价于 `ELECTRON_RUN_AS_NODE=1 electron scripts/mcp-server.mjs`），stdio 传输。
- 权限档由启动时的环境变量 `IFTREE_MCP_TIER` 决定，运行中不可切换：

| 取值 | 档位 | 可见工具 |
| --- | --- | --- |
| `read`（默认） | 问答 | 只读工具 |
| `edit` | 协作 | 只读 + 编辑分支写入 / 流式写入 / 导入 / 记忆投递 |
| `full` | 完全 | 协作 + 合并、回滚、删除等管理动作 |

后端为共享进程：同一数据库的应用、MCP、CLI 汇到同一个 headless 后端，先到者拉起，后来者按数据库路径派生的命名管道接入。

### 只读工具（所有档位）

| 工具 | 作用 |
| --- | --- |
| `library_index` | 按 library 文件夹层级列出已导入文档（ASCII 树，可附 docId、摘要） |
| `tree` | 查看文档结构：缩进 ASCII 树（地址、类型、标题、子树字数），可限子树与层深 |
| `read` | 读取某地址正文，默认整棵子树；`node` / `meta` / `source`（原文窗口）/ `blame`（原文出处溯源）可选 |
| `find` | 统一检索：默认多词 AND 字面检索；`semantic=true` 语义检索附 score；`tags=true` 实体同义 / 相关列表 |
| `article` | 读取导入文档的原文窗口（按 docId 从头读，或按 nodeId 读附近） |
| `log` | 列出文档保存 / commit 历史 |
| `diff` | 比较两条保存历史，或查看一个编辑分支的投影 diff |
| `sql` | 只读 SQL 调试查询（仅 SELECT / WITH，readonly 连接校验） |
| `memory_volumes` | 列记忆卷及状态（active → sealed → distillable → distilled，附时间元数据） |
| `ask_agent` | 问内置文档智能体（A2A）：自己检索、读证据、附地址回答；`sessionId` 多轮续接 |
| `restart_backend` | 重启 MCP 持有的后端子进程（更新代码 / 原生模块后用） |

### 写入工具（`edit` 与 `full` 档）

| 工具 | 作用 |
| --- | --- |
| `edit` | 写一条数据库编辑动作进编辑分支（默认 owner=llm，不直接改主库） |
| `branch` | 管理编辑分支：list / begin / diff / drop |
| `changes` | 列当前分支暂存变更；`detail=true` 返回 diffView |
| `switch` | 切换当前 MCP 的分支选择（后续分支动词的默认目标） |
| `undo` / `redo` | 分支内撤销 / 重做 |
| `commit` | 保存分支：生效 diff 写入主文档历史并删除分支；非快进时逐条前置验证，结构性失配返回 blocked、字段级冲突返回 conflicts 等人裁 |
| `merge` | 三方合并：默认只返回预览（fastForward / hasConflicts / 逐节点 resolution）；`yes=true` 执行，冲突与受阻时主干与分支均不动 |
| `discard` | 丢弃一条待审 diff，或丢弃整个分支（默认预览，`yes=true` 执行） |
| `list_diffs` / `reject_diff` | 列出 / 拒绝内置 agent 提议的待审改动 |
| `import` | 导入 library 内真实文件，mode 为 simple / complete / direct / smart / vector |
| `vectors` | 为已导入文档补建语义向量 |
| `set_mode` | 切换文档编辑模式：readonly / incremental（流式写入）/ full（分支与合并），增量与完整互斥 |
| `push` | 流式写入：把消息节点追加进增量编辑文档（首次 `title` 建档，之后 `docId` + `parentId`；每节点必填 `trust_level`） |
| `bulk` | 海量导入加速会话：begin 异步写 → 多次 push → end 恢复安全设置；共享后端上需独占 |
| `memory_deliver` | 投递事件记忆卷（外部 agent 唯一合法的记忆侧写入；节点一律不受控） |
| `memory_admin` | 记忆卷维护：seal_due 物理封卷到期卷；mark_distilled 标记已提炼 |

### 管理工具（仅 `full` 档）

| 工具 | 作用 |
| --- | --- |
| `apply_diff` | 接受一条待审改动并保存到分支 |
| `restore` | 按 history id、saved_at 时间戳或 summary tag 精确回滚文档历史 |
| `rebase` | 把当前分支的 lazy base 刷新到主干 HEAD（不是完整冲突裁决器） |
| `cherry-pick` | 从同一文档的保存历史或编辑分支摘取 edit entries 写入目标分支 |
| `export` | 导出已导入文档为 Markdown 文本（返回文本，不写文件） |
| `forget` | 删除已导入文档的 doc 数据（不删 library 真实文件） |

## db 命令契约

`db` 是给 LLM 用的统一命令面：内置 agent 的 bash 会话直接可用（由产品注入 LLM 工作区），MCP 工具底层走同一实现。动词分组：

- **检索与读取**：`find`、`keyword`、`query`、`index`、`tree`、`read`、`log`、`diff`、`sql`、`memory list`
- **写入**：`edit`、`push`、`import-json`、`set-mode`、`bulk`、`import`、`vectors`、`memory deliver`
- **分支**：`branch`、`changes`、`commit`、`merge`、`switch`、`undo`、`discard`、`rebase`、`cherry-pick`
- **管理**：`export`、`restore`、`forget`

`db help` 输出当前版本的权威用法。语义与上面的 MCP 工具一一对应。

## 只读查询 CLI

`scripts/query-db.mjs` 直接查 SQLite，适合脚本化检查（须以 Electron ABI 运行）：

```powershell
.\node_modules\.bin\electron.cmd scripts/query-db.mjs docs
.\node_modules\.bin\electron.cmd scripts/query-db.mjs index --docId 22 --depth 3
.\node_modules\.bin\electron.cmd scripts/query-db.mjs node-content --docId 22 --address 1-4-6 --include tags,source
.\node_modules\.bin\electron.cmd scripts/query-db.mjs search-all --query "keyword" --format ascii_tree
.\node_modules\.bin\electron.cmd scripts/query-db.mjs debug.sql --sql "SELECT COUNT(*) FROM nodes"
```

常用别名：`docs`、`library-index`、`library-navigation`、`index`、`depth`、`node-content`、`subtree`、`search`、`search-all`、`article`、`overview`、`sql`。`help` 列出全部 action。`--db <path>` 或环境变量 `IFTREE_DB` 指定库文件。

## import-json 契约

`db import-json <tree.json> <源文件> [--dry-run] [--allow-gaps] [--vectors]`

JSON 结构与 `db push` 同构：

```json
{
  "title": "文档标题",
  "nodes": [
    {
      "address": "1-1",
      "text": "源文逐字节切片",
      "nodeTitle": "（可选）你构造的标题",
      "nodeNote": "（可选）备注",
      "nodeType": "（可选）缺省 TEXT",
      "trustLevel": "不受控",
      "sourcePosition": 3.5,
      "children": []
    }
  ]
}
```

| 字段 | 规则 |
| --- | --- |
| `address` | 必填。顶层从 `1-1` 起，每个父节点下末位从 1 连续递增，不跳号；嵌套用 `children` |
| `text` | 源文的逐字节连续切片，允许去首尾空白，不得改动内部任何字符（含空格、标点、换行） |
| `trustLevel` | 智能导入产物一律 `"不受控"` |
| `nodeTitle` | 虚拟容器的章节名；原文真实标题行不用它（标题行本身就是一个 `text` 节点） |
| `sourcePosition` | 虚拟容器（`text` 为空）必填：取其后第一个带正文节点的句位序号减 0.5；带正文节点可省略，校验器自动回填 |

校验规则与报告字段：

- **顺序铁律**：树的前序遍历顺序必须与正文在源文中的出现顺序一致。
- `errors`：`missing`（正文在源文中不存在）、`out_of_order`（位置在已消费区间之前）、`address_*`（地址不连续 / 前缀错）、`virtual_source_position`（虚拟容器缺半步句位）。
- `gaps`：源文未被覆盖的区间，附 `preview`；默认拒绝导入，确认合理后 `--allow-gaps` 放行。
- 全部通过返回 `ok: true`；`--dry-run` 只出报告不入库。

## 配置与环境变量

### `iftree.config.json`（项目根）

| 字段 | 作用 |
| --- | --- |
| `llmSummary.*` | 摘要策略：字数上下限、压缩比例、文章级 / 节点级策略选择 |
| `llmSummary.shared.providers` | 设置页维护的多供应商 / 多 API 列表（Key 不在此文件，只进 `.env`） |
| `agentTools.*` | 内置 agent 工具参数（搜索结果条数等） |
| `renderMode` | `hardware` 或 `compatible`（JS Canvas 2D），对应启动器下拉框 |
| `forceHardwareAcceleration` | 强制启用硬件加速，对应启动器开关 |
| `debugLogging` | 运行日志写入 `.iftree-debug/`，对应启动器开关；早期版本默认开启 |

### `.env`（项目根，不入库）

| 变量 | 作用 |
| --- | --- |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | OpenAI 兼容接口的默认凭据 |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | 显式 DeepSeek 命名，与 OPENAI_* 同在时优先 |
| `OLLAMA_BASE_URL` | Ollama 本地服务地址 |
| `IFTREE_LLM_*` | 设置页自动维护的多供应商配置与各 API 的 Key，一般不手编 |

### 运行时环境变量

| 变量 | 作用 |
| --- | --- |
| `IFTREE_DB` | 主数据库路径，缺省 `<项目根>/database/store.sqlite` |
| `IFTREE_HOME` | 派生数据目录（向量 / 附件），缺省 `%USERPROFILE%\.iftree` |
| `IFTREE_MCP_TIER` | MCP 权限档：`read` / `edit` / `full` |
| `IFTREE_DEBUG_LOGGING` | `1` 强制开 debug 日志（等价于配置文件 `debugLogging: true`） |
| `ELECTRON_START_URL` | 开发模式让 Electron 加载 Vite dev server |
| `ELECTRON_RUN_AS_NODE` | 以 node 方式运行 Electron（MCP / CLI 脚本需要） |
