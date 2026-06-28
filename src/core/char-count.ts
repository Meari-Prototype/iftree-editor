// 正文字数口径：忽略全部空白字符（JS \s 全集：空格 / 制表 / 换行 / 全角空格 　 等）。
//
// 为什么忽略空白：切分粒度只决定空白如何分布到各节点，不该改变正文总字数。
// simple（段落粒度）把整段 slice 进一个节点、句间空白（红楼梦里是 \n\n）都留在节点正文里；
// complete（句子粒度）每句独立 trim、句间空白不进任何节点。两者的 raw 原文完全相同，差异 100% 是
// 这些句间空白——把它从「字数」里排除，两种 mode 的字数即一致，且「字数」本就该计正文内容、不计排版空白。
// 后端所有对外展示的字数（library_index / tree 子树合计 / 历史快照树）统一走这一口径；SQL 侧由 store
// 注册同源 UDF body_char_count 调用本函数，保证 JS 与 SQL 计数一致。
export function bodyCharCount(value: unknown): number {
  return String(value ?? '').replace(/\s/g, '').length;
}
