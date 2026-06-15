# 操作指南

> [上手教程](getting-started.md) · **操作指南** · [参考手册](reference.md) · [概念与设计](concepts.md) · [记忆库使用](memory.md)

任务式的「怎么做 X」。每节独立成立，按需查阅。

## 配置 LLM 供应商

LLM 用在三处：节点 / 全文摘要、内置 agent 对话、智能导入。配置分两层：

1. **API Key**：复制 `.env.example` 为 `.env`，填入 Key。`.env` 在 `.gitignore` 中，不会被提交。
2. **供应商与模型**：设置页维护多供应商、多 API 配置（会写回 `.env` 与 `iftree.config.json`，Key 只进 `.env`）。

支持两种接口协议，按供应商选择：

- **OpenAI 兼容**：请求 `{baseUrl}/chat/completions`。DeepSeek、MiniMax、智谱 GLM、Kimi、Gemini、Grok 的 OpenAI 兼容端点都走这条。
- **Anthropic 兼容**：请求 `{baseUrl}/v1/messages`，用 `x-api-key` 与 `anthropic-version` 头，需在 API 配置中填最大输出 token。

本地模型用 Ollama 的 OpenAI 兼容端点接入即可（`http://localhost:11434/v1`）。

## 构建语义向量

语义检索按含义找句子，前提是先为文档建向量。

1. 设置页选择模型（默认 `Xenova/bge-m3`）与计算目标：GPU（WebGPU）或 CPU（wasm）。
2. 下载模型（设置页有当前模型的手动下载按钮；也可填本地 ONNX 模型目录路径）。
3. 对已导入文档补建向量：应用内触发，或命令行 `npm run vectors:ensure`。

调优项：worker 数（默认 2）、batch size（默认每批 16 条）。切换模型会丢弃旧的 LanceDB 表，避免不同模型的同维向量混用。

**远程 embedding 后端**：本机推理吃力时，可以把向量计算切到一个 HTTP embedding 服务——支持 ollama（`POST {baseUrl}/api/embed`）和 OpenAI 兼容（`POST {baseUrl}/v1/embeddings`，llama.cpp server 加 `--embedding` 即原生暴露）两类端点。向量在客户端统一做 L2 归一化，与本地推理路径的结果可比。

## 导入各格式文档

把源文件放进 `library/`，应用内从文档库面板发起导入。

| 格式 | 结构来源 | 注意 |
| --- | --- | --- |
| `.txt` | 标题行、段落、句子 | 无格式约定的纯文本按段落 / 句子切 |
| `.md` | heading、段落、句子 | 推荐格式，结构最稳 |
| `.docx` | OOXML 段落样式 `<w:pStyle>` | 标题靠样式识别；手动加粗当标题的文档识别不到层级 |
| `.pdf` | 文本层映射 | 需要有文本层；扫描件先 OCR |
| `.chm` | `.hhc` 目录 + HTML 正文 | 按目录层级生成结构树 |

Excel `.xlsx` 与 CSV `.csv` 是数据库导出的中继格式，不作为普通文档导入。

导入粒度在导入期锁定：入库后没有段落切分 / 合并的通道，重在导入前确认源文结构。结构不规则、规则解析不出来的源文，走下一节的智能导入。

## 用智能导入处理无规则结构的源文

智能导入的本质：让一个 LLM 观察源文样本、写一次性切割脚本产出 JSON，经 `db import-json` 逐字节校验后入库。LLM 只贡献结构，不贡献正文——正文必须是源文的逐字节切片，校验器逐字比对，改一个字都过不了。

两种用法：

- **应用内**：导入对话框选「智能导入」，入库后自动触发目录重整，结束时弹强制审批对话框（接受全部 / 拒绝全部）。
- **外部 agent**：任何能跑脚本的 agent（Claude Code、Codex 等）按 [`.iftree-llm-workspace/skills/smart-import/SKILL.md`](../.iftree-llm-workspace/skills/smart-import/SKILL.md) 的契约操作：观察样本 → 写切割脚本 → `db import-json <json> <源文> --dry-run` 预检 → 按报告修脚本 → 去掉 `--dry-run` 正式入库。

dry-run 报告怎么读：

- `missing`——正文在源文中找不到：九成是脚本动了内部空白 / 换行；
- `out_of_order`——顺序与源文不一致：检查脚本遍历顺序；
- `address_*`——地址不连续或父前缀错；
- `gaps`——源文有未覆盖区间：逐个确认是页眉页脚等无需入库的内容后，加 `--allow-gaps` 放行。

JSON 契约的完整字段表见[参考手册](reference.md#import-json-契约)。

## 把库开放给外部 agent

MCP server 以 stdio 方式运行，权限档在启动时由环境变量 `IFTREE_MCP_TIER` 决定：

| 档位 | 取值 | 能做什么 |
| --- | --- | --- |
| 问答 | `read`（默认） | 检索、读正文、查历史、列记忆卷、问内置 agent |
| 协作 | `edit` | 问答档全部 + 写编辑分支待审、流式写入、导入、投递记忆卷 |
| 完全 | `full` | 协作档全部 + 合并、回滚、删除等管理动作（身份仍 llm、产出标不受控） |
| 人类 | `human`（别名 `yolo`） | 完全档全部 + 以 human 身份批准 llm 待审、写入可标受控（受控内容与人审批准的唯一来源） |

客户端配置（以 Claude Code 的 `.mcp.json` 为例，放在本项目根目录）：

```json
{
  "mcpServers": {
    "iftree-library": {
      "command": "npm",
      "args": ["run", "--silent", "mcp"],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "IFTREE_MCP_TIER": "read"
      }
    }
  }
}
```

外部 agent 的常用动线：`find`（关键词 / 语义检索挑候选）→ `read`（取回正文证据，带地址）→ 回答引用地址。命中过碎时读父地址或相邻地址补上下文。

注意事项：

- 协作档及以上，agent 的结构性修改先进 **编辑分支**（owner=llm 影子分支）待审，不直接改主库；待审 diff 在应用内逐条或整批裁决。
- 更新代码或原生模块后，调 `restart_backend` 工具让 MCP 重新拉起后端子进程。
- 应用、MCP、命令行共享同一个后端进程（一库一后端），可以同时开着应用和 agent，互不冲突。

## 让外部 agent 投递事件记忆卷

事件记忆卷回答「这个库上确曾发生过什么」。外部 agent 在会话收尾把结构化自述日志投递成一卷（协作档及以上）：MCP 工具 `memory_deliver`，或 agent bash 里 `db memory deliver`。

要点（完整契约见 [`memory-deliver/SKILL.md`](../.iftree-llm-workspace/skills/memory-deliver/SKILL.md)）：

- 投的是「发生过什么」的**原料**，不是结论——提炼成当前事实是库内另一条链（提炼 + 人工审批）的事。
- 自述日志四段骨架：用户原话（唯一逐字段）、任务与结果、失败与教训、可复用结论。
- 所有节点一律 `trust_level: "不受控"`，写「受控」会被拒绝。
- 一次投递成一卷；落库后按 24 小时节律自动封卷、进入可提炼，agent 不管理生命周期。

查看已有卷：MCP `memory_volumes` 或 `db memory list`，按 docId 用 `tree` / `read` 下钻卷正文。

## 流式写入与海量导入

把外部数据流（聊天记录、日志、抓取结果）持续追加进库，不走「导入一个完整文件」的路径：

1. 目标文档切到增量编辑模式：`set_mode` → `incremental`（增量编辑与完整编辑互斥；要回头修订就切回 `full`）。
2. 用 `push` 追加：首次给 `title` 新建文档；之后给 `docId` + 挂载点 `parentId`（uuid，可用 `tree` / `read` 查到）。每个节点必须显式给 `trust_level`；更深结构放 `children` 递归。
3. 去重是调用方的责任，系统只按 `idempotencyKey` 做请求级防抖。

**海量导入**（一次灌几十万句）再加一层 `bulk` 加速会话：`begin` 开异步写 → 多次 `push` → `end` 恢复安全设置并 checkpoint。注意：

- 共享后端上 `begin` 需要独占——有其他客户端在线会被拒，会话期间其他客户端的写请求被拒（读不受影响）。
- 崩溃最多丢最近一批，靠地址校验 + 幂等重推兜底。
- 只在专门的导入阶段用，日常库不要开。

## 数据备份、迁移与多库隔离

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 源文档 | `<项目根>/library/` | 你自己组织的源文件，自行备份 |
| 主数据库 | `<项目根>/database/store.sqlite` | 文档、节点、历史、记忆卷等全部结构化数据 |
| 向量 / 附件 | `%USERPROFILE%\.iftree\` | `vectors\nodes.lance`、`assets\doc-<id>\` |

- 备份：`library/` + `database/store.sqlite` 即可恢复全部内容；向量可随时重建。
- 换库 / 隔离测试：`IFTREE_DB` 指定另一个 SQLite 路径，`IFTREE_HOME` 指定另一个派生数据目录（也可把向量库挪到大盘）。
