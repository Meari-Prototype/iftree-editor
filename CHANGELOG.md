# 更新日志

记录每个公开版本的主要变更。0.x 阶段次版本号之间可能包含不兼容变更。

## 0.4.1 — 2026-06-18

### 修复

- **关键词检索召回不再被截断**：keyword 命中召回从 FTS top-200 候选改为 Aho-Corasick 全量字面扫描——字面命中全量不漏，截断只发生在展示层；FTS / BM25 退为只对已召回结果排序，不再充当召回器。旧实现下单个常见词就可能命中数千节点、被 top-200 候选窗悄悄截断，多词 AND 因此漏召回。展示条数上限由 100 放宽到 1000，新增 `rankLimit` 调节参与 BM25 排序的候选规模（只影响长尾排序精度、不影响召回完整性）；`searchKeyword` 的 `matchMode` 契约对齐为 `doc` / `node` / `or`。
- **内置 agent 检索自污染修复**：内置问答 agent 此前把每轮对话自动落成无锚记忆卷、污染跨库检索空间，导致召回掺入自身历史。现内置 agent 不再逐轮自落卷（本地持久化仍在）；跨库 / 全库检索默认排除 `.` 开头隐藏路径（如 `.memory`），`includeHidden` / `kind=event` 显式纳回；内置 agent 默认只检索当前文档，非用户要求不跨库。
- **信任边界收口**：edit / full 档的分支 stage 与 commit 重放一律拒绝 `trust_level`，标受控只经 human `certify`，堵住 llm 经 MCP 直传受控绕过人审的路径。
- **`debug.sql` 截断判断去假阳性**：改用 `limit+1` 探针判断结果是否被截断。

### 新增

- **full / yolo 档动词层**：`certify`（human 按节点 / 子树标受控或撤销，作为 owner=human 提交进历史）、`revert`（反向提交撤销目标 commit 对节点的改动、保留其后历史，冲突交人裁）、`web_search`（full/human 联网只读检索）、`agent` 委托等按档位开放；写动词 `trust` 字段下线，流式写入恒落不受控。
- **记忆卷投递即建锚**：记忆卷落库即在 `library/.memory/<身份>/<工作区>/<会话>` 建实体锚，建不出即回滚删卷、拒绝无锚卷（非导航文档必有库内实体锚）。

### 工程

- 手写 Aho-Corasick 自动机从 `entities/shared.mjs` 提取为 `src/core/aho-corasick.mjs`（`buildAhoCorasickMatcher`），实体绑定与 keyword 召回共用一份实现；大小写归一化改由各调用方自理。
- `refs` 增建 source / target 索引。
- 文档跟进：`docs/reference.md` 补 `certify` / `revert` / `web_search` 动词与 `find` 的 `matchMode` / 隐藏路径默认排除说明。
- 顶层套件 / 类型闸 / lint 跟上已落契约：记忆卷测试 harness 补建锚能力、edit 分支拒 `trust_level` 用例随 18-3 更新、解构形参补 JSDoc（`check:types` 归零）、删 `IS_FULL_TIER` 死常量。

## 0.4.0 — 2026-06-17

### 新增

- **草稿模型动词与两轴 diff**：编辑动词重组为草稿模型——`draft new/list` 起草并列出草稿、`delete` 与 import 成对删档、`merge` 带 `strategy` / `resolutions` 直接落库或逐条裁冲突。`diff` 拆成两轴：详略轴 `--detail summary/full`（summary 只出改/增/删/移计数，full 出逐行 old→new 正文），版本轴 `--from` / `--to` 在正文（head）、历史 commit、草稿三种快照间任意比对。
- **检索入口统一到 db 契约**：内置 agent 的检索读取统一走 bash 的 `db` 命令——`db find --semantic` 语义检索（命中行自带证据节点地址）、`db read` 回正文、附证据节点；`system_prompt` 据此重写，清掉旧的 `content.*` 裸 action。进阶 / 底层入口工具 `database_read` 改名 `admin_override`，描述精简指向 `db help`。
- **本地 LLM 经 `.env` 直连**：对话模型可经 `.env` 直配（`IFTREE_AGENT_BASE_URL` / `IFTREE_AGENT_MODEL` / `IFTREE_AGENT_API_KEY` 直连覆盖云端 provider），嵌入后端可切 `IFTREE_EMBED_BACKEND=ollama`，请求超时 `IFTREE_AGENT_TIMEOUT_MS` 可调（小模型冷启动用）。缺 key 不崩（占位 `ollama`），key 不进日志。
- **diff 识别移动 + merge 预览折叠**：跨快照 diff 现在识别节点移动——换父、或同父调序记 `移`，兄弟增删带来的连带重排不误报。三方合并预览把未改节点折叠进计数行、只列有裁决 / 冲突的节点，避免大文档刷屏。
- **read 按节点身份定位 + 子树字数持久化**：`read` / `inspect` 可用 `--node-id <uuid>` 按稳定身份定位（认人不认位置）；子树字数持久化并支持分层早停，大库取数更省。
- 新增 `backfill-corpus-vectors` 离线补向量脚本：给已导入文档补建语义向量（嵌入后端由 `.env` 决定）。

### 修复

- **commit / merge 冲突诊断不再被返回收口裁掉**：MCP 写动词的精简收口此前把非快进 commit、`merge yes=true` 落库失败时的 `blocked` / `message` / `conflicts` / `resolutionErrors` 一并删掉，agent 只见 `applied:false`，既不知受阻原因也拿不到待裁清单；现在失败结果透传这些字段，冲突裁决工作流恢复可用。
- **检索指引与记忆 skill 跟上改名**：`system_prompt` 把「看结构」从 `db index` 纠正为 `db tree`（`db index` 只列库目录、给 doc_id 直接报错）；`memory-distill` skill 改用现行 `memory_distill` / `draft` / `diff`，不再指向已删的 `memory_admin` / `branch` / `changes`。
- **diff ref 边界**：`db diff` / MCP `diff` 只给一端（如 `--from <commit>`）时，另一端默认落正文 head，不再因默认指向草稿而在未选草稿时误报「草稿未找到」；`draft:<id>` 传非法 id 直接报错，不再 `Number('')→0` / `NaN` 静默退化。

### 工程

- 前端渲染进程 `.js` / `.jsx` → `.ts` / `.tsx` 迁移收尾（`src/frontend` + `src/renderer` 共 59 文件），import 后缀零改写，构建 / 类型检查 / 套件全绿。
- db 动词契约测试扩充：补 diff 移动识别（换父 / 调序 / 连带重排不误报）与 merge 预览折叠的单元测试；`read` / `inspect` 缺参报错文案更新跟上实现。
- **测试运行时守卫**：每个测试文件加载即检测运行时，用纯 node 直接跑（原生模块按 Electron ABI 编译、必然 `NODE_MODULE_VERSION` 不匹配）会立即报错退出，强制走 `npm test` / `npm run test:verbs`。
- **取数优化**：子树字数聚合从递归 CTE 改为 O(N) 后序 DP（大库取数不再随深度退化）；`read` 分层早停去掉对同一子树的重复全表扫描。

## 0.3.0 — 2026-06-16

### 新增

- **`inspect` 工具与 `read` 重构**：`read` 收敛为只回正文，新增 `scope=node/subtree/siblings`（同父前中后三条）与 `--at` 读历史快照（默认按节点身份穿透历史、认人不认位置）；元信息 / 出处 / 引用 / 公理 / 批注拆到新的 `inspect` 工具。
- **`human` / `yolo` 权限档**：在 `full` 之上新增人类身份档——以 human 身份批准（merge）llm 待审分支、写入可标受控（受控内容与人审批准的唯一合法来源）；`full` 档澄清为身份仍 llm、产出标不受控。
- **记忆提炼链路**：事件卷经 `memory-distill` skill 提炼成长期核心记忆的 diff 提议，由 `human` 档人审落地（门槛在审批、不在提炼）；新增 `docs/memory.md` 记忆库使用手册。
- **节点级历史**：`log` 可按子树 / 节点列出改动某地址的 commit 与作者，commit 带身份；跨 commit 字段级 diff 渲染。
- **检索过滤**：`find` 新增 `minScore`（语义按相似度下限、字面按命中次数下限）。

### 工程

- 前端拆分：`App.jsx` 抽出 `useStartup` / `useSummaryRun` / `useEntityTrace` hooks 与 `doc-utils` / `agent-utils`，组件层大幅瘦身。
- `test:verbs` 补 `pretest:verbs` native 重建前置钩子（与 `pretest` 对齐，避免旧 ABI 检出上 db 用例假失败）；`check:types` 清零。
- db 动词契约测试套件扩充（read-verbs / read-follow / node-history / snapshot-history / branch-status / diff-text 等）。

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
