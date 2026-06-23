// 向量式导入：按字数定长切块的文件导入 mode（projectneed 第 4 章第五种文件导入模式）。
// 注意与「向量导入」（4-6，给已入库节点建 embedding）区分——两者不是一回事：
//   · 向量式导入 = 怎么把文件切成节点树（轴一），与 简单/完整/智能/直接 并列；
//   · 向量导入   = 给已入库节点建 embedding（轴二，由 embed 开关决定）。
// 向量式导入本身只负责「定长切块」；建不建 embedding 仍由 embed 开关决定，
// 只是它默认 embed=true（按字数切块的产物本就是为向量检索准备的，见 import-service）。
//
// 切法是纯机械定长滑窗：不识别结构、不造标题层级，每块一个节点平铺。
// 块文本是源文的逐字符切片（不 trim、不改任何字符），相邻块按「块长 × overlap」重叠，
// 保留跨块上下文以利向量检索召回。

export const DEFAULT_VECTOR_CHUNK_SIZE = 512; // 字符数（中文按字计；BMP 内 code unit == code point）
export const DEFAULT_VECTOR_CHUNK_OVERLAP = 0.1; // 相邻块重叠 = 块长的比例（块的 10%）

export function normalizeVectorChunkOptions(options = {}) {
  const chunkSize = Math.max(1, Math.floor(Number(options.chunkSize) || DEFAULT_VECTOR_CHUNK_SIZE));
  const ratio = Number(options.overlap);
  // 上限 0.9：重叠不能 ≥ 块长，否则步长 ≤ 0 切不动。
  const overlap = Number.isFinite(ratio) ? Math.min(0.9, Math.max(0, ratio)) : DEFAULT_VECTOR_CHUNK_OVERLAP;
  return { chunkSize, overlap };
}

// 定长滑窗切块：步长 = 块长 − 重叠长。
// 返回 [{ index, text, start, end }]——start/end 是相对 text 的字符（code unit）偏移，
// 可直接落源文档层 spans 做选区高亮 / 原文回溯（与句/段导入同等能力）。
// 重叠区会同时落入相邻两块（定长重叠的固有特性），对应源文位置因此映射到两个节点。
export function chunkTextByChars(text, options = {}) {
  const source = String(text ?? '');
  const { chunkSize, overlap } = normalizeVectorChunkOptions(options);
  const overlapChars = Math.min(chunkSize - 1, Math.round(chunkSize * overlap));
  const step = Math.max(1, chunkSize - overlapChars);
  const total = source.length;
  if (total === 0) return [{ index: 1, text: '', start: 0, end: 0 }];
  const chunks = [];
  for (let start = 0, index = 1; start < total; start += step, index += 1) {
    const end = Math.min(start + chunkSize, total);
    chunks.push({ index, text: source.slice(start, end), start, end });
    if (end >= total) break; // 末块已抵文末，重叠步长不再前进，停。
  }
  return chunks;
}
