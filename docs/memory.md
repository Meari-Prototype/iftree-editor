# 记忆库使用

> [上手教程](getting-started.md) · [操作指南](how-to.md) · [参考手册](reference.md) · [概念与设计](concepts.md) · **记忆库使用**

把这个库当作 agent 的跨会话记忆来用——怎么召回、怎么写入、怎么提炼，以及一串只有真上手才会撞到的操作要点。

读者是**接入本库当记忆用的 agent**（Claude Code、Codex、内置 agent 皆可），也供人对照。它是 MCP 服务说明（schema 自述，接入第一读物、约定级）的展开版：为什么这么设计看[概念与设计 · 记忆三层](concepts.md#记忆三层)，字段与工具的权威清单看[参考手册](reference.md#mcp-server)，这里只讲**怎么用顺手**。

## 三层，先记住各自答什么

| 层 | 答的问题 | 你对它的动作 |
| --- | --- | --- |
| 完整记忆（事件卷） | 确曾发生过什么 | 只读回看；会话收尾投递自述日志成卷 |
| 长期核心记忆 | 现在如此 | 开工必读；经提炼+人审产生，每条回指事件出处 |
| 知识文档 | 未来可用 | 检索取证据 |

结构同构（同一套树地址与检索动词），语义异质。两条铁律贯穿全程：

- **信任分级**：节点分受控（过了人审）/ 不受控（机器产物未审）。事件卷、agent 写入一律不受控；升级只经人审，没有"写得好就升级"。详见[信任分级](concepts.md#信任分级)。
- **时间纪律**：召回结果带时间元数据，**采信前先看时间**；同主题证据冲突**新者胜**，不得以"看起来更合理"推翻时间新旧；找不到更新的，旧证据就是最佳可用，知旧而用。

## 召回动线

**开工三步**，不要一上来就扎进手头任务：

1. `memory_volumes` —— 看最近发生过什么（默认列最新 5 卷及状态、时间元数据；要更早的显式调大 `limit`）。
2. 读长期核心记忆与工作区文件（`NOW.md` / `AGENTS.md` / `CLAUDE.md`）—— 知道"现在如此"。核心记忆按租户组织（租户根=通用、工作区下=项目），见[存储与定位](#存储与定位)。
3. 再做手头任务；完整记忆只在"查过往"时下钻。

**检索用 `find`，但别裸搜**：

- 匹配模式：`matchMode=doc`（默认，文档级 AND，高命中，词可分散在同文档不同节点）/ `node`（节点级 AND，精确共现）/ `or`（任一词）。字面检索多词按 AND；`semantic=true` 走语义（需目标文档已建向量）。高级过滤可加 `minScore`（语义按相似度下限、默认 0.51；字面按命中次数下限）。
- **查记忆务必收窄范围**，否则跨层串味（在知识文档里搜出一堆同字面的无关命中）。按需加：`kind=memory|event|knowledge`、`workspace=<工作区>`、`agent=<身份>`、`folder` / `excludeFolder`、`since` / `until`。例：只在自己的核心记忆里找 → `kind=memory`；只看某工作区的事件 → `kind=event` + `workspace=…`。
- 命中行给 `文档标签 / address / type / title`；`labels=true` 附分层与信任。

**命中只是探针，不是答案**：

- 命中只用于挑候选，**下结论前必须 `read` 取回正文证据**。
- **看地址，不看向量分**。命中聚在哪个父地址，第一反应就是"把那个父节点整棵读了"——`read` 默认就读整子树。命中过碎时读父地址或相邻地址（±1）补上下文。
- `read`：默认读整棵子树纯正文；`scope` 可选 `node`（只本节点）/ `siblings`（同父前中后三条，首/末缺位显式标〈previous/next 无〉）。元信息·出处·引用·公理·批注改用 `inspect`，原文窗口用 `article`；读历史版本传 `at`（默认按节点身份穿透，`atAddress=true` 退回按地址）。
- 懒得自己走这套，可 `ask_agent` —— 内置 A2A 智能体按检索纪律自己查、读证据、附地址回答；`sessionId` 多轮续接。

**命中未解决的 ERROR 节点：停下报告用户，不得绕过续跑。**

## 写入边界

记忆侧的写入是**受约束**的，不是随便写。

- **外部 agent 唯一合法的记忆写入是事件卷投递**：会话收尾（或用户说"记一下"）把结构化自述日志投成一卷（`memory_deliver`，协作档及以上）。投的是"发生过什么"的**原料**，不是结论；节点一律不受控。骨架与契约见[操作指南](how-to.md#让外部-agent-投递事件记忆卷)与 [`memory-deliver/SKILL.md`](../.iftree-llm-workspace/skills/memory-deliver/SKILL.md)。
- **不得直写当前事实层、不得绕过提炼把结论固化成记忆条目**。"现在如此"只能经提炼+人审产生。

### 提炼（事件卷 → 核心记忆）

把"发生过什么"复盘成"现在如此"的**提议**。完整契约见 [`memory-distill/SKILL.md`](../.iftree-llm-workspace/skills/memory-distill/SKILL.md)，要点：

1. 读目标卷——**只读发言部分**，非必要不读工具调用节点（省 token，要的是结论性内容）。读不动（卷+现有记忆超模型窗口）就停下问用户：分段还是缩范围。
2. **先检索会撞车的旧记忆，再提议**（硬步骤）——只有把相关旧条目摆面前，才谈得上"合并进已有"而非新增近重复。
3. 和人复盘，定增 / 改（删旧留最新）/ 跳；**可零产出**，一卷未必值得写；一卷多件事就拆多条、以引用互链；每条**回指来源卷节点**。
4. 据共识在核心记忆文档上开编辑分支提 diff，**人审落地**——门槛在审批、不在提炼。

### 编辑核心记忆文档

核心记忆是普通条件树文档，用标准编辑模型改（见[编辑模型：分支与三方合并](concepts.md#编辑模型分支与三方合并)）：

- 开 `draft new`（owner=llm 草稿，正文不动）→ `edit`（`node.insert`/`node.reparent`/…）逐条 stage → `commit`（快进直接写回）或人在前端 merge 审。
- `full` 档的 llm 可自己提 diff 并 `commit`（产出仍不受控）；标受控、批准他人待审是 `human` 档专属。大批结构改就**一条分支多动作 stage、一次 commit**，落成一个 diff。

## 存储与定位

记忆文档不进 library 文件目录树，靠 `.memory` 下的**实体锚**对人可见、可打开（agent 侧召回不依赖锚）：

| 记忆 | 锚位置 | 可见性 |
| --- | --- | --- |
| 长期核心记忆 | `library/memory/<租户>/[<工作区>/]CLAUDE.md\|AGENTS.md`（租户＝agent 身份；租户根=通用核心记忆、工作区下=项目核心记忆） | 可见——人要查阅、审批 |
| 事件卷 | `.memory/<租户>/<工作区>/<会话>.快捷方式` | 隐藏系统目录 |

锚改名或迁移后，用 `relink` 重绑 doc 的源路径（`full` 档；只改绑定不动正文），别 `delete` 重导（会丢库内已提炼内容）。

**删某卷**：在文件管理器删掉它在 `.memory` 下的锚文件，再跑 `scripts/purge-orphaned-volumes.bat`（或先 `--dry-run` 预览）——它只清「锚已被删」的脱锚卷，不误伤需求允许悬空的真卷。删锚这一步本身就是你的删除指令，无需二次确认。

## 操作要点（踩过的坑）

只有真用 MCP / CLI 动手才会撞到，schema 自述不会写：

- **CLI 要用 electron 跑，不是纯 node**。`db.mjs` / `query-db.mjs` 等加载 `better-sqlite3`，它按 Electron ABI 编译——`node scripts/db.mjs …` 会报 `NODE_MODULE_VERSION` 不匹配。正确：`ELECTRON_RUN_AS_NODE=1` 经 `.\node_modules\.bin\electron.cmd scripts/db.mjs …`（`npm run mcp` 就是这么起的）。
- **改动生效边界**：改后端代码（store/handlers/db-shell…）后端是 headless 子进程、惰性启动 → `restart_backend` 放掉旧子进程、下次调用才加载新代码；改 `scripts/mcp-server.mjs`（工具注册/schema）→ 须**重连 MCP**，`restart_backend` 不够；`db.mjs`/CLI 每次 spawn 新进程，改完即时生效。
- **`edit` 的两类 id 别混**：`baseDocId` 要 **doc id**，`parentId` / `nodeId` 要 **节点 id**。同篇文档这俩前缀常相同、尾号不同，混用直接 `FOREIGN KEY constraint failed`。
- **reparent / move 按 uuid，不按地址**：地址会随每次结构改动重投影漂移；用稳定节点 id 作 `nodeId` / `newParentId`，叠多少次都不错位。
- **草稿幂等复用**：同 owner 在同文档已有活跃草稿时，`draft new` / 后续 `edit` 复用它而非新建——连续动作自动叠在一份草稿上。
- **owner 缺省取档位默认**（不再是 human）：`draft` / `diff` / `discard` / `commit` / `edit` 等不传 owner 时落到档位默认（edit/full 档=llm、human 档=human），自动命中自己开的草稿；只有在 human 档去操作 llm 草稿时才需显式 `owner=llm`。非 human 档不接受 `owner=human`（运行中不升档）。

## 开关

整套记忆能力（事件卷落卷、核心记忆与提炼、待提炼提示与召回常驻指令）是一个可独立启用/禁用的模块，**默认关闭**，仅在作为 agent 记忆后端部署时开启。禁用时相关代码路径不激活，产品退化为纯知识 / 条件树工具，普通知识库部署不会被催提炼。
