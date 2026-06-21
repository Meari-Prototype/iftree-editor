// 文档树 → markdown 序列化器，与导入侧 core/tree.mjs（markdown → 树）对称
// （后端解耦第 1 步：从主库存储类 exportDocMarkdown 下沉；store 侧保留查库 + 地址排序的薄门面，
// 故地址比较 compareNodeAddress 留在 backend，core 不反向依赖 backend）。
// 纯函数：接收文档行 doc 与「已按地址排序」的节点行数组 nodes，重建父子关系后 DFS 渲染。不碰 db。
export function renderDocMarkdown(doc, nodes) {
  const byParent = new Map();
  for (const row of nodes) {
    const key = row.parent_id === null || row.parent_id === undefined ? '' : String(row.parent_id);
    const siblings = byParent.get(key) || [];
    siblings.push(row);
    byParent.set(key, siblings);
  }
  const firstLine = (value = '') => String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  const headingText = (node = {}) => firstLine(node.node_title) || firstLine(node.text) || String(node.address || node.id || '').trim();
  const lines = [`# ${firstLine(doc.title) || `doc ${doc.id}`}`];
  // 库内节点类型统一是 TEXT，没有「标题/正文」标记位。markdown 导入时标题会成为带子节点的
  // 父节点，段落/列表/代码块/表格则是叶子。据此区分：有子节点的渲染为对应层级标题，叶子原样
  // 输出正文——避免旧实现把正文、代码块、表格行都按树深度套成标题（深层正文变 #####、代码块
  // 围栏行被当标题再重复输出一遍）的失真。
  const emitNode = (node) => {
    const children = byParent.get(String(node.id)) || [];
    const body = String(node.text || '').trim();
    const note = String(node.node_note || '').trim();
    if (children.length > 0) {
      const heading = headingText(node);
      const level = Math.max(2, Math.min(6, Number(node.depth) || 2));
      if (heading) lines.push('', `${'#'.repeat(level)} ${heading}`);
      if (body && body !== heading) lines.push('', body);
    } else if (body) {
      lines.push('', body);
    }
    if (note) lines.push('', note);
    for (const child of children) emitNode(child);
  };
  const roots = byParent.get('') || [];
  if (roots.length === 0) return `${lines.join('\n').trimEnd()}\n`;
  const primaryRoot = roots[0];
  const rootChildren = byParent.get(String(primaryRoot.id)) || [];
  const rootBody = String(primaryRoot.text || '').trim();
  const rootHeading = headingText(primaryRoot);
  if (rootBody && rootBody !== rootHeading) lines.push('', rootBody);
  const startNodes = rootChildren.length ? rootChildren : roots;
  for (const child of startNodes) emitNode(child);
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
