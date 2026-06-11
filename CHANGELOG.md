# 更新日志

记录每个公开版本的主要变更。0.x 阶段次版本号之间可能包含不兼容变更。

## 0.2.0 — 2026-06-12

### 新增

- **三方合并**：编辑分支合入主干升级为基于节点树 merkle 哈希的三方调和，按稳定节点 id 对账、不按地址。快进直接写回；非快进逐条前置验证（乐观并发，校验规模与改动数成正比）：结构性失配返回整体受阻，字段级冲突弹出冲突对话框由人逐条裁决，agent 不自动解冲突。
- **流式写入与文档编辑模式**：`push` 把消息节点直接追加进「增量编辑」文档，不走编辑分支，关键词与语义索引随写入增量维护；`set_mode` 在只读 / 增量编辑 / 完整编辑之间切换（增量与完整编辑互斥）；`bulk` 提供海量导入加速会话（异步写、结束恢复安全设置并 checkpoint）。
- **事件记忆卷**：外部 agent 会话收尾可把结构化自述日志投递成 session 卷（MCP `memory_deliver` / `db memory deliver`），按 24 小时节律自动封卷、进入可提炼；`memory_volumes` 列卷及状态。三层记忆模型（完整记忆 / 长期核心记忆 / 知识文档）写入 system_prompt。
- **共享后端**：同一数据库的应用、MCP、命令行客户端汇聚到同一个 headless 后端进程——先到者拉起，后来者按数据库路径派生的命名管道接入，避免 SQLite 多写者竞争。
- **智能导入契约**：`db import-json` 按与 `db push` 同构的 JSON 契约校验入库——正文逐字节比对、地址连续性、前序顺序、原文覆盖率检查；`--dry-run` 预检、`--allow-gaps` 放行确认过的未覆盖区间、`--vectors` 顺带建向量。三个面向 LLM 的 skill 文档（smart-import / intelligent-import / memory-deliver）随仓库分发于 `.iftree-llm-workspace/skills/`。
- **远程 embedding 后端**：语义向量除本地 transformers.js 推理外，可切换到 HTTP embedding 服务（ollama 与 OpenAI 兼容端点，含 llama.cpp），客户端统一 L2 归一化保证向量可比。
- **前端**：PDF 选区与悬停高亮双层；目录面板重写为嵌套原生 sticky 驻留；diff 对比补公理引用与片段级高亮。

### 修复

- 保存退出挂死（派生索引语义归位）。
- 保存闸门乐观并发：主干在分支期间前移后不再盲存。
- 编辑分支投影与重放语义对齐；引用生命周期统一。
- uuidv7 迁移残留清理；新增孤儿索引行与死引用清理脚本。

### 工程

- 导入解析按格式拆分为 `source-text` / `source-markdown` / `source-docx` / `source-chm` / `source-pdf`。
- ESLint 覆盖扩展到 `electron/`、`scripts/`、`tests/`；新增 TypeScript 类型检查管线（`npm run check:types`），MindMapView 等开始向 TS 迁移。
- 测试套件扩充至 191 项（三方合并、记忆卷、派生索引一致性、文本 diff 等）。

## 0.1.0 — 2026-06-05

首个公开快照：条件树编辑与双密度阅读、多视图（树 / 关系图谱 / IDE / 富文本）、关键词 + bge-m3 语义检索、CHM / TXT / Markdown / PDF / DOCX 导入、MCP 只读查询、内置 agent 基于证据的回答。
