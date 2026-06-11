---
name: memory-deliver
description: 把当前会话"发生过什么"投递成 IFTree 库的事件记忆卷（MCP memory_deliver 或 db memory deliver）。会话收尾前投递一次；用户说"记一下""你记住了"时当场投递截至当下的快照卷。投的是自述日志原料而非结论，所有节点一律不受控。
---

# 事件卷投递 skill（projectneed `18-8-4`）

把你这个会话"发生过什么"投递进本产品的完整记忆。本文写给执行投递的外部 LLM——
Claude Code、Codex、或任何能调 MCP / 跑命令行的 agent 框架。投递是纯 agent 行为，
不依赖宿主钩子（底线档）；宿主有钩子机制时可自动补投，那是增强档，不改变本契约。

## 原则

1. **投的是原料，不是结论。** 事件卷回答"发生过什么"，不回答"现在长什么样"。
   你不得借投递把自己的判断固化成记忆条目——提炼成"当前事实"是库内另一条链
   （提炼+人工审批）的事，那也是你唯一不能碰的层（`18-8-3`）。
2. **一律不受控。** 所有节点 `trust_level: "不受控"`（`15-10-3`），写"受控"会被直接拒绝。
   自述日志和原始全量记录之间的保真度差异只是提炼时的材料质量差异，不构成可信度梯度，
   不用想办法"提高级别"。
3. **库内自足。** 自述日志必须独立可读：提炼只会回指库内卷节点，不会去读你宿主的
   原始记录。宿主原始记录锚（`hostAnchor`）只供人工深查，宿主清理日志后允许悬空——
   所以**别把关键内容只留在锚里**。
4. **投递语义就是新建一个文档。** 一次投递成一卷；同一会话"记一下"中途投一卷、
   收尾再投一卷是两个卷，重叠由提炼处理，你不用去重。卷落库后按 24h 节律
   自动封卷、进入可提炼（`15-11-5`），你不用管理生命周期。

## 投递时机

- **会话收尾**（主时机）：结束当前会话前投递一次。
- **用户说"记一下"/"你记住了"**：当场投递截至当下的快照卷，不等会话结束。

## 自述日志骨架

四段固定骨架 + 元信息。**用户原话段是日志中唯一逐字的部分**——它是提炼时最强的
出处材料，复制原文，不得复述改写；其余段落用你自己的话精炼写。

```json
{
  "agent": "claude-code",
  "sessionId": "宿主侧会话标识",
  "hostAnchor": "C:/Users/x/.claude/projects/.../transcript.jsonl#session=...",
  "startedAt": "2026-06-11T01:00:00Z",
  "endedAt": "2026-06-11T03:20:00Z",
  "nodes": [
    {
      "node_title": "用户原话", "text": "", "trust_level": "不受控",
      "children": [
        { "text": "先提交一下当前工作区内所有改动。然后准备写这一批需求的代码实现。", "trust_level": "不受控" }
      ]
    },
    {
      "node_title": "任务与结果", "text": "", "trust_level": "不受控",
      "children": [
        { "text": "提交工作区改动：成功（commit a28ee02）。", "trust_level": "不受控" },
        { "text": "WAL 切换：成功，全部测试通过。", "trust_level": "不受控" }
      ]
    },
    {
      "node_title": "失败与教训", "text": "", "trust_level": "不受控",
      "children": [
        { "text": "空库自带导航虚拟文档，按 COUNT(docs)=0 断言会误判。", "trust_level": "不受控" }
      ]
    },
    {
      "node_title": "可复用结论", "text": "", "trust_level": "不受控",
      "children": [
        { "text": "测试必须经 ELECTRON_RUN_AS_NODE 跑，纯 node 加载不了 better-sqlite3。", "trust_level": "不受控" }
      ]
    }
  ]
}
```

字段规则：

- `agent`、`sessionId`：必填（卷必带元信息，`15-10-1`）。`agent` 用稳定的框架标识
  （如 `claude-code`、`codex`），同一框架别换着写。
- `hostAnchor`：宿主原始记录的路径 + session 标识。给得出就给，给不出就省略。
- `startedAt` / `endedAt`：ISO 8601。中途快照不给 `endedAt`。
- 节点字段与流式写入同契约（`text`、`node_title`、`node_note`、`children`）；
  分组容器 `text` 留空、组名写 `node_title`，正文写进子节点。
- 没有内容的段可整段省略；有超出骨架的重要事件（用户纠错、未决问题）就加一段，
  骨架是底线不是上限。
- `idempotencyKey`：建议带（如 sessionId+时间戳）；网络重试不会长出第二个卷。

## 投递通道（二选一）

**MCP**（推荐，需 edit/full 档）：

```
memory_deliver { agent, sessionId, hostAnchor?, title?, startedAt?, endedAt?, nodes, idempotencyKey? }
```

**命令行 db 外壳**：把上面的 JSON 写进工作区文件，然后：

```
db memory deliver <payload.json>
```

投完可用 `memory_volumes`（或 `db memory list`）确认卷已落库、状态为 active。

## 常驻指令模板（贴进 CLAUDE.md / AGENTS.md / NOW.md）

底线档靠它生效——没有这段，你不会记得投递：

```markdown
## 记忆（IFTree 库）
- 你有跨会话记忆：开工先看最近发生过什么（memory_volumes 列卷，find/tree/read 下钻），
  再看长期核心记忆与工作区文件；采信前先看时间元数据，同主题冲突新者胜。
- 会话收尾把自述日志投递成事件卷（memory_deliver，契约见 .iftree-llm-workspace/skills/memory-deliver/SKILL.md）；
  用户说"记一下"时当场投递截至当下的快照卷。
- 不要直写记忆结论：事件卷投递是你唯一的记忆侧写入形态。
```

## 自检清单（投递前过一遍）

- [ ] 用户原话是逐字复制，其余段落是精炼自述
- [ ] 每个任务有成功/失败标记，失败的写了原因
- [ ] 日志离开宿主也能独立读懂（库内自足）
- [ ] 所有节点 `trust_level: "不受控"`
- [ ] `agent`、`sessionId` 给齐；`hostAnchor` 尽量给
- [ ] 带 `idempotencyKey`
