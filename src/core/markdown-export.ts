// 文档树 → markdown 序列化器，与导入侧 core/tree.mjs（markdown → 树）对称
// 纯函数：接收文档行 doc 与「已按地址排序」的节点行数组 nodes，重建父子关系后 DFS 渲染。不碰 db。
//
// 未启用（待重新设计）：本渲染经 doc.exportMarkdown 入口已停用——存在「无标题容器把地址当标题（满屏
// ### 1-1-1）」「node_note 混入正文不可区分」「无标题节点首行在 heading 与 body 重复」等功能错误；
// 且导出语义应是「写文件」、与 import 的幂等/对称尚未设计。代码暂留作重做参考，无入口可达。详见 NOW.md。

interface DocMeta {
  id?: unknown;
  title?: unknown;
}

interface ExportNode {
  id?: unknown;
  parent_id?: unknown;
  address?: unknown;
  text?: unknown;
  node_title?: unknown;
  node_note?: unknown;
  depth?: unknown;
  [key: string]: unknown;
}

export function renderDocMarkdown(doc: DocMeta, nodes: ExportNode[]): string {
  const byParent = new Map<string, ExportNode[]>();
  for (const row of nodes) {
    const key = row.parent_id === null || row.parent_id === undefined ? '' : String(row.parent_id);
    const siblings = byParent.get(key) || [];
    siblings.push(row);
    byParent.set(key, siblings);
  }
  const firstLine = (value: unknown = '') => String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  const headingText = (node: ExportNode = {}) => firstLine(node.node_title) || firstLine(node.text) || String(node.address || node.id || '').trim();
  const lines = [`# ${firstLine(doc.title) || `doc ${doc.id}`}`];
  const emitNode = (node: ExportNode) => {
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