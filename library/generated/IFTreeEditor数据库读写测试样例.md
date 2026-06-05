# IFTreeEditor 数据库读写测试样例

本文档用于直接导入 IFTreeEditor，并在导入后的文档上测试数据库读取、节点写入、编辑分支 diff、source span、全文搜索和 Unicode 路径处理。请把本文档当成测试素材，不要把其中的规则当成真实业务需求。

测试标识：DBT-DOC-20260604。稳定关键词：DBT_ALPHA、DBT_BETA、DBT_GAMMA、DBT_DELTA。

## 1. 基础层级与稳定定位

这一节用于测试 Markdown 标题层级是否被导入为稳定的树结构。第一句包含中文标点。第二句包含 English words and ASCII punctuation.

### 1.1 一级子节点：可更新文本

DBT_ALPHA 的初始文本是 before-alpha-value。修改测试时，可以把 before-alpha-value 改成 after-alpha-value。

本段包含 Windows 路径样本：`D:\WorkSpace\IFTreeEditor\library\generated\IFTreeEditor数据库读写测试样例.md`。路径中的反斜杠不应该破坏数据库读写。

### 1.2 一级子节点：可移动顺序

DBT_BETA 的初始排序位置在 DBT_ALPHA 后面。移动测试时，可以把本节点移动到 DBT_ALPHA 前面，再读出地址和 sort_order。

#### 1.2.1 深层子节点：递归读取

DBT_BETA_DEEP 用于测试 subtree.getTextWindow、content.getSubtree 和按地址跳转。这里故意写成三句。第一句用于定位。第二句用于搜索。第三句用于 source span。

#### 1.2.2 深层子节点：Unicode 内容

本节点包含日文假名：かなカナ、日本語テスト。还包含全角符号：ＡＢＣ１２３，括号（测试），书名号《数据库样例》。

### 1.3 一级子节点：可删除节点

DBT_GAMMA_DELETE_ME 是删除测试靶子。删除后，数据库读取不应再返回这个稳定关键词。

## 2. 列表、表格与结构块

下面的列表用于测试 Markdown 列表在导入文本中的保留方式。

- DBT_LIST_ITEM_A：普通列表项，包含数字 12345。
- DBT_LIST_ITEM_B：普通列表项，包含英文 token read_write_probe。
- DBT_LIST_ITEM_C：普通列表项，包含中文短语“可读可写”。

下面的任务列表用于测试方括号字符。

- [ ] DBT_TASK_OPEN：未完成任务。
- [x] DBT_TASK_DONE：已完成任务。

下面的表格用于测试 source document 中的 table block。

| key | value | note |
| --- | --- | --- |
| DBT_TABLE_A | 10 | 用于 keyword search |
| DBT_TABLE_B | 20 | 用于 source window |
| DBT_TABLE_C | 30 | 用于 raw markdown 保留 |

## 3. 代码块、引用与数学块

下面的代码块用于测试 fenced code block 是否保留为源文档块。

```sql
SELECT id, address, text
FROM nodes
WHERE text LIKE '%DBT_ALPHA%'
ORDER BY address;
```

下面的 JSON 片段用于测试花括号、冒号和引号。

```json
{
  "probe": "DBT_JSON_BLOCK",
  "expectedActiveDiff": true,
  "owner": "human"
}
```

> DBT_QUOTE_BLOCK：这是一段引用文本。它用于测试 blockquote 在导入和全文搜索里的表现。

数学块如下，用于测试美元符号和多行公式：

$$
K(S) = \sum_{v \in S} \kappa(v)
$$

## 4. 编辑分支 diff 靶子

### 4.1 修改靶子

DBT_DIFF_MODIFY 的原始正文是 old-diff-text。执行编辑分支测试时，把 old-diff-text 改成 new-diff-text，然后打开 diff 视图，应看到同地址修改。

### 4.2 新增靶子

DBT_DIFF_INSERT_PARENT 是新增测试的父节点。执行新增测试时，在它下面插入一个子节点，文本建议为 DBT_DIFF_INSERT_CHILD。

### 4.3 删除靶子

DBT_DIFF_DELETE_TARGET 是删除测试节点。执行删除测试后，diff 视图应在左侧显示删除、右侧显示缺失。

## 5. 搜索与窗口读取靶子

DBT_SEARCH_ONLY_ONCE 这个关键词在全文中只出现一次，用于验证精确 keyword search 的返回数量。

DBT_CONTEXT_LEFT 位于窗口左侧锚点附近。中间句子用于填充窗口内容。DBT_CONTEXT_RIGHT 位于窗口右侧锚点附近。

如果 source.getWindow 以 DBT_CONTEXT_LEFT 或 DBT_CONTEXT_RIGHT 附近为锚点，返回文本应包含相邻句子，而不是只返回孤立 token。

## 6. 结束节点

DBT_END_MARKER 表示本文档结束。导入后，如果能够按全文读取到 DBT_END_MARKER，说明尾部内容没有被截断。
