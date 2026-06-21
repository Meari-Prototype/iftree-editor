---
name: memory-deliver
description: 把当前会话投递成 IFTree 记忆库的事件卷（MCP memory_deliver / db memory deliver），并把值得长期记住的事起草进长期记忆待人审。会话收尾投递一次；用户说"记一下"时当场投递并起草。你不复述、不整理日志——系统读你的 session 文件规则解析成卷。
---

# 事件卷投递 + 长期记忆起草（projectneed `18-8-4` / `15-10` / `15-11`）

把你这个会话投进本产品的记忆。**记忆系统除路径外没有任何特殊机制**——事件卷、长期记忆都是普通条件树文档，全走主系统已有的导入 / 流式写入 / 编辑分支 / 引用 / 合并，只多几条规则让它像记忆。本文写给执行投递的外部 LLM（Claude Code、Codex、任何能调 MCP 的 agent）。

## 两件事

1. **投递事件卷（每会话）**：把这个 session 的宿主原始记录导入成卷——"确曾发生过什么"。**你不复述、不整理**：系统读 `hostAnchor` 指向的真实 session 文件、纯规则解析成卷（确定可重复）。你只给三个东西：`agent`、`sessionId`、`hostAnchor`。
2. **起草长期记忆（值得时）**：把"现在如此"的可复用结论，在长期记忆文档上**开 draft 提 diff、连到事件卷里那句出处原话**，人审落地。一个 session 常零产出、顶多一两条。

## 原则

- **事件卷是原料、不是结论。** 卷答"发生过什么"；一律 trust 不受控（`15-10-3`）。你不借它固化判断。
- **一 session 一卷。** 同 agent+sessionId 重投 = 旧卷全删 + 完整重导（session 只追加 + 解析确定 → 重导 ≡ 追加），不产生第二个卷、不留孤儿。你重复投递无害。
- **长期记忆经人审、不直写。** 你在记忆文档上开 draft 提 diff（`15-11`），人审落地——这就是"起草待审"，不是直写结论。每条回指事件卷出处（用户真说的那句话）。
- **除路径外无特殊机制。** 全走主系统现成动词（import / push / draft / edit / ref / commit / merge）；不必学新东西。

## 投递时机

- **会话收尾**（主）：结束前投一次事件卷。
- **用户说"记一下"/"你记住了"**：当场投事件卷 + 起草那条长期记忆。

## 1) 投递事件卷

```
memory_deliver { agent, sessionId, hostAnchor, title?, startedAt?, endedAt? }
```

- `agent`：稳定的框架标识（`claude-code` / `codex`），同框架别换写。
- `sessionId`：宿主侧 session id。
- `hostAnchor`：你这个 session 的真实 transcript 文件路径（`路径#sessionid`）。系统读它解析成卷；文件不存在 / 解析不出对话即拒（不空卷直接造）。
- **不传 nodes**：系统规则解析你的 session 文件，你不整理自述日志。

命令行：`db memory deliver <json>`（同契约）。投完用 `memory_volumes` / `db memory list` 确认卷已落库。

## 2) 起草长期记忆（值得时）

值得长期记住的（用户明确"记一下"、踩过的坑、可复用结论），在长期记忆文档上起草——不是直写，是开草稿待人审：

1. 找到你身份的长期记忆文档（`library/memory/<身份>.md`，每身份一篇；没有就先建一篇）。
2. `draft` 起草 → `edit` 写一条精炼的记忆节点（"现在如此"）→ `edit` 的 `ref.addNodeToNode` 把它连到刚投事件卷里**那句用户原话节点**（出处）。
3. `commit` 提交待人审（human 档 `merge` 落主干）。

每条记忆必须是用户真说过 / 真踩过、且能回指事件卷出处。一 session 常零产出、顶多一两条——一条都算多，宁缺毋滥。

## 自检

- [ ] 事件卷只给 agent / sessionId / hostAnchor，hostAnchor 指向真实 session 文件
- [ ] 长期记忆是起草待审（draft + 人审）、非直写；每条回指事件卷出处
- [ ] 长期记忆条目是用户真说 / 真踩过的，精炼成"现在如此"

## 常驻指令模板（贴进 CLAUDE.md / AGENTS.md / NOW.md）

底线档靠它生效——没有这段，你不会记得投递：

```markdown
## 记忆（IFTree 库）
- 跨会话记忆：开工先看最近发生过什么（memory_volumes 列卷，find/tree/read 下钻），
  再看长期核心记忆与工作区文件；采信前看时间元数据，同主题冲突新者胜。
- 会话收尾投事件卷（memory_deliver，只给 agent/sessionId/hostAnchor，系统读 session 文件导入，
  契约见 .iftree-llm-workspace/skills/memory-deliver/SKILL.md）；
  用户说"记一下"时当场投 + 起草那条长期记忆（draft 待人审）。
- 长期记忆经起草待审、不直写结论；每条回指事件卷出处。
```
