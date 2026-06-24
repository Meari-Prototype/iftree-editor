# 更新日志

记录每个公开版本的主要变更。0.x 阶段次版本号之间可能包含不兼容变更。

## 0.6.3 — 2026-06-25

本版主线是运行时源码的 TypeScript 化：把 `src` / `scripts` / `electron` 下的运行时 `.mjs` 全量迁移到 `.ts`，并从 `core` 模块起补全类型标注。这是一轮内部代码质量 / 类型基建工作，对外功能与动词契约不变。

### 工程（TypeScript 化）

- **运行时源码 .mjs → .ts**：`src` / `scripts` / `electron` 的运行时源码全量迁移到 TypeScript，经 esbuild 产出 `dist/`（`build:runtime`），node / electron 两条运行路径与对外行为不变。
- **core 模块补全类型标注**：`core/*`（树 / merkle / 解析 / 导入格式 / markdown 等）摘除 `@ts-nocheck`、补齐函数签名与接口，新增 `core/source-types` 作为导入与源文档层的公共类型来源。
- **类型闸分阶段收口**：`tsconfig.check.json` 暂关 `strict`，`core` 先达标（`check:types` 0 错误）；`backend` / `frontend` / `vector` / `agent` 仍带 `@ts-nocheck` 被跳过，留后续版本逐模块摘除。
- **三方合并类型适配**：`merkle-merge` 字段合并结果改用属性判别（`'value' in r`）收窄 union，适配非 strict 下的控制流分析，运行时分支等价。

### 前端

- 一轮前端状态管理重构：写管线抽出 `hooks/useWritePipeline`、撤销栈抽 `session/history-stack`（带测试）、文档会话状态拆分（`session/` + `AppBody`），附带视图写入回环、preload 加载等修复。

### 测试

- 顶层套件 260 pass / 1 skip、`test:verbs` 46 pass、`check:types` / `lint` 全绿。

## 0.6.2 — 2026-06-23

继 0.6.0 的后端解耦，本轮把前后端彻底解开：后端可在纯 node runtime 下独立部署（headless，docker / VPS 只跑 stdio MCP、不带 Electron），桌面前端不再 in-process 用 better-sqlite3、改走后端 RPC，原生模块 ABI 从 electron 统一到 node。配套把文档解析层公共化（切句 / 坐标 / 富文本抽独立模块），新增 epub 与向量式导入。对外动词契约不变。

### 新增

- **epub 导入**：解析 epub 章节结构与正文，句子可定位回原文（`core/source-epub` + `import-formats/epub`）。
- **向量式导入**：按字符块切分导入（`import-formats/vector`），与按句 / 按结构导入并列，供检索优先的场景用。
- **docx 块锚点**：导入 word 时记录每个句子在原始排版中的块区间（`source_doc_blocks` 表），句子能定位回原 docx 段落。
- **智能导入可切到句子层**：照完整导入「切到句子」的形态产出（段落空容器 + 句子子节点、半步位置标边界），由 `splitSentences` 契约开关控制；导入契约的节点 `address` 改为可选，缺失按前序自动补全。
- **富视图按节点渲染**：富文本视图拆成 `RichMarkdown` / `RichNodeView` 按节点渲染；agent 面板消息按正文 / 推理 / 工具分段渲染。

### 工程（前后端解耦）

- **headless 后端可纯 node 部署**：better-sqlite3 统一 node ABI（`prebuild-install` 下载、无需编译工具链），新增 `mcp:node`（纯 node 起 stdio MCP）/ `rebuild:native:node` / `check:native`；`@lancedb/lancedb` 是 N-API 预编译、node 与 electron 通用，不参与 rebuild。
- **前端去 native**：electron 主进程不再 in-process 用 better-sqlite3，PDF 原件 / 高亮 / span 矩形改走后端 RPC（新增 `source.readPdfData` / `readPdfHighlights` / `readPdfSpanRects` 与 `import.smartTask` 请求口）；主进程显式拉起 node host，自身零 native rebuild。
- **嵌入 HTTP 首选**：`embedding-service` / `token-count` 改动态 import `@huggingface/transformers`（懒加载 + fallback），默认走 HTTP 嵌入（ollama / OpenAI 兼容），本地 onnxruntime 推理降为可选依赖。
- **依赖重分类**：前端构建链（react / react-dom / vite / @vitejs/plugin-react / @radix-ui / lucide-react / electron）移入 `devDependencies`，`@huggingface/transformers` 移入 `optionalDependencies`；`npm ci --omit=dev` 即不带前端全家桶与本地嵌入。
- **解析层公共化**：切句抽 `core/sentence-split`、字符坐标 / span 抽 `core/source-spans`、文本读取 / XML 解码抽 `core/source-text-utils`、富 markdown 抽 `core/rich-markdown`，markdown / docx / chm / epub / 智能导入共用一套、偏移基准统一。
- **建档存初始 commit**：建档 / 导入默认存一条「初始版本」commit 作历史起点，首个编辑可退回初始态。
- **运行时统一 node**：测试与原生重建从 electron 切到 node（`node --test`），退役 electron 专用的原生重建 / 自检脚本。

### 测试

- 顶层套件 228 pass / 1 skip、`test:verbs` 46 pass、`check:types` / `lint` 全绿。

## 0.6.1 — 2026-06-21

0.6.0 重构后的小修复：收紧事件卷投递的输入过滤与记忆锚路径校验，迁移脚本补备份，连接层重试避开非幂等动词重复执行。

### 修复

- **事件卷不再收录系统合成行**：纯规则解析 session 文件时，过滤 Claude Code 写成 user 行的系统合成内容（斜杠命令展开 `<command-*>`、本地命令输出 `<local-command-*>`、`<system-reminder>`、`<task-notification>`、compact 摘要、工具重试提示），只留用户原话——避免系统噪声污染事件卷与下游检索 / 蒸馏。
- **记忆锚路径段校验**：`agent` / 工作区值为 `.`、`..` 或含路径分隔符时落占位并判结构非法，不再让畸形值穿透成目录跳转、逃出 `.memory` 锚目录。
- **非幂等动词不在连接中断后自动重发**：`agent.run`、`import.*` 连接层失败时上抛、由调用方决定，避免从头重跑导致重复 LLM 调用与重复草稿 / 卷；幂等读写仍自动重连吸收抖动。

### 工程

- `migrate-memory-tenant` `--apply` 前 `db.backup()`（对齐 `migrate-tree-objects`），留回滚点。
- `migrate-tree-objects` verify 对象缺失记一条 failed 而非中断整轮，保住「verify 全过才删列」的安全闸。
- 对象库 `materializeTree` 缺 blob 时抛带 hash 的明确错误，替代无定位的 TypeError。
- 清理 summary 服务里一处永不可达的死代码。
- 顶层套件（228 pass / 1 skip）/ `test:verbs`（46 pass）/ `check:types` / `lint` 全绿；新增 `isLegalEventVolumeLayout` 路径段校验单测、扩充 `messagesFromClaudeTranscript` 合成行过滤用例（含负向保留真实用户话）。

## 0.6.0 — 2026-06-21

后端模块解耦重构：主进程通信收口到统一 backend-client SDK，巨石 `store.mjs` 拆成 `store/` 目录模块，host 的业务闭包下沉到独立服务，记忆区升级为多租户隔离；schema 演进改为库级导入式迁移，事件卷投递改纯规则解析。本轮以架构整理为主，对外动词契约不变（verb-bridge / db 契约套件全绿佐证）。

### 新增

- **启动版本闸 + 库级迁移**：数据库带 schema 版本号，启动只读校验，不再每次开机靠全表扫描兜底。schema 演进改为「按最新声明建空库、把旧库数据当素材导入」的一次性往复，配套 `scripts/export-db-to-json`（库 → json）、`import-db-from-json`（json → 新空库）、`migrate-tree-objects`、`migrate-memory-tenant` 四个运维脚本，取代原地改库。
- **记忆多租户隔离**：事件卷锚与长期核心记忆按 `.memory|memory/<租户>/<工作区>/<会话>` 分层——租户＝agent 身份、工作区＝真实工作区，二者都不许占位兜底；落到占位目录（`unknown-agent` / `_local`）即判结构非法、报错引导迁移或清理，不再让各 agent 记忆混放或游离。
- **事件卷投递改纯规则解析**：投递读 `hostAnchor` 指向的真实 session 文件、启发式解析成对话回合再成卷，与内置 agent 落卷走同一条路径；文件不存在 / 解析不出对话即拒，不造空卷、不留悬空锚。

### 修复

- **`restart_backend` 漏杀游离后端**：共享后端首次重启时按 pid 兜底强杀，避免旧后端进程残留占住管道。
- **edit-branch entity 提交**：修 `this` 误用，entity 提交改回经 `store` 落库。

### 工程（后端模块解耦）

- **统一 backend-client SDK**：主进程、MCP、CLI 的后端通信收口到一套 backend-client SDK，主进程只调 SDK；共享后端请求分发改薄注册表，关停清理集中一处。
- **`store` 巨石拆分**：`store.mjs` 拆成 `store/` 目录——`index.mjs`（存储底座）＋ `history.mjs`（历史子系统）＋ `edit-branch.mjs`（编辑分支子系统），门面保留同名转调，对外调用不变。
- **host 闭包下沉**：嵌入 / 摘要 / 导入 / 快照树等业务从 host 闭包下沉到独立模块（`import-service`、`library-document-service`、`summary`、`snapshot-tree`、`diff-view` 等），host 只做依赖注入与编排。
- **内容寻址对象库**：commit 快照拆进对象库（blob / tree 按 hash 去重、source 对象去重），新增 `objects.gc` 回收无引用对象。
- **清理**：删渲染进程 WebGPU 嵌入旧桥（功能并入 `vector/embedding-service.mjs`）、`src/core/search.mjs` 检索逻辑并入 `query-api` / `keyword-index`、provider 选择下沉 settings、语言提示词集中到 `lang/` 模块、entity 落库 SQL 去重。
- 顶层套件（227 pass / 1 skip）/ `test:verbs`（46 pass）/ `check:types` / `lint` 全绿；新增 object-store 历史 GC、edit-branch entity 提交、库导出导入往复、token 计数、迁移往复、backend restart pid 兜底等单测。

## 0.5.0 — 2026-06-19

动词形态完整定型：编辑/流式/管理动词的参数面收口，向量维护改为 pull 自对账架构，新增记忆卷孤儿清理工具。

### 新增

- **记忆卷孤儿清理工具**：`memory.purgeOrphaned` 与运维脚本 `scripts/purge-orphaned-volumes.{mjs,bat}`——在文件管理器删掉某卷在 `.memory` 下的实体锚后跑此工具，把「锚已被删除」的脱锚卷连带清干净（`lstat` 不解引用、只清真删的、不误伤需求允许悬空的真卷、带 `--dry-run` 预览、复用共享后端不抢锁）。
- **edit 动词定位增强**：补 `node.moveBefore`（移到目标节点之前）与 `node.mergePrevious`；`targetNodeId` 具名字段统一 `moveAfter` / `moveBefore` / `mergeInto` 的目标（`afterNodeId` 兜底映射）；`node.insert` 给 `afterNodeId` 即自足推断父节点；`branchId` 精确路由多草稿并存。
- **建向量开关统一为 `embed`**：`import` / `push` / `import-json` 同步建向量统一用 `embed`（与切分方式 `mode` 正交）；旧 `vectors` 参数退役，传了直接报错、不静默不建。

### 修复

- **restore 走 git reset 语义**：按 commit 恢复时在事务内把 head 移到目标 commit，不再只重写 nodes 致 head 与正文脱节；`log` / 历史只列 head 祖先链（被跳过的「未来」commit 仍可凭 id 直接访问，充当 reflog）。
- **向量库与 SQLite 不再分家**：派生数据目录（`IFTREE_HOME`）缺省锚工作区 `database`（与主库同根），不再回落 `%USERPROFILE%\.iftree`——修 `IFTREE_HOME` 未设时向量库连错空库（`find --semantic` 全空的真因）。
- **检索就绪一致性**：completeness 闸改走对账实时校验；陈旧向量（正文已变的旧 embedding）即使在保存路径也删成「缺失」（安全降级），不再让跨库语义检索按旧正文打分。
- **分支计数口径**：diff 把纯位置变更（`sort_order` / `parent_id`）从 modified 拆出单列「移」；`node.split` 按实际拆出子节点数计「增」。
- **revert 撤销节点移动**：反向提交对 `sort_order` 做三方调和，撤掉目标 commit 改过的位置、保留其后又改的。
- **MCP 稳定性**：`restart_backend` 优雅关停后按 pid 强杀兜底；共享后端被多客户端复用时单个 MCP 退出不再误关全局后端；agent 委托长任务周期发 progress 防客户端超时；`memory_deliver` 复活。

### 工程

- **向量索引重构为 pull 自对账**：主进程写完 SQL 只发 `reconcile(docId, {fillNow})` 信号、不传变更集，向量库自查 SQL 对账；写入恒 `mergeInsert` 按 id upsert（物理一 id 一行，消除重复行 / 计数虚高 / 补建死循环）；`content_hash` + `subtree_hash` 双列随行落库，top-down subtree 剪枝让流式百万节点也只对账变化子树；旧表 `addColumns` 原地迁移。
- **MCP 写返回渲染收口**：写动词返回从裸 JSON 改为紧凑 ASCII 文本（`write-result-text`），截断预算统一到 `text-budget`，语义状态读 `docs.meta` 持久化列（`semantic-status`，启动后台回填存量）。
- **运维工具归位**：`purge-orphaned-volumes` 从内部 `scripts/ops/` 移到发布的 `scripts/` 顶层，与 `prune-orphan-index-rows` 等并列。
- 文档跟进：`reference` / `how-to` 修正流式写入不再接受 `trust_level`、派生数据目录默认路径，`.env` 表补 `IFTREE_AGENT_*` / `IFTREE_EMBED_*`；`.env.example` 补全直连与嵌入后端配置。
- 顶层套件 / `test:verbs` / `check:types` / `lint` 全绿；新增 reconcile subtree 剪枝、非 fillNow 删陈旧、记忆卷孤儿清理等单测。

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
