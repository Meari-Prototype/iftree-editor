// 坐标层公共模块——把「句子段内偏移」叠加成「源文 / 载体绝对偏移 + 连续句位编号」的 spans。
//
// 设计（见「切句 / 坐标公共化」重构第 2 步）：坐标和切句正交。切句（sentence-split）产出每句的
// 段内偏移；这里把段内偏移加上「这段在目标坐标系的起点」换成绝对偏移、连续编号成句位 spans。
// spans 四元组 { sentence_index, start_offset, end_offset, text } 落 source_spans 表（node_id 落库时挂）。
//
// 两层职责：
// - appendSpans：无状态核。给定 baseOffset（段落在坐标系的起点）+ 段内句子偏移，叠加成绝对 spans。
//   md / pdf 用它——它们的 baseOffset 是 block 在 raw_markdown 里的真实偏移，无需重建载体。
// - createSpanAccumulator：带载体游标。docx / epub / chm 用它——它们没有现成源文，要一边解析一边把
//   抽出的文本按「段 + 两个换行」拼成载体（raw_markdown），spans 偏移相对这个载体。

import { splitSentenceSpans } from './sentence-split.mjs';

// 无状态核：把一段的句子段内偏移叠加成绝对 spans、连续编号。返回这批句位编号。
export function appendSpans(spans, baseOffset, segmentSpans) {
  const indexes = [];
  for (const seg of segmentSpans) {
    const index = spans.length + 1;
    spans.push({
      sentence_index: index,
      start_offset: baseOffset + seg.start,
      end_offset: baseOffset + seg.end,
      text: seg.text
    });
    indexes.push(index);
  }
  return indexes;
}

// 带载体游标的累加器：docx / epub / chm 用。一边 appendSegment 把文本铺进载体（段 + '\n\n' 分隔），
// 一边按段内偏移登记 spans。finalize 出 { rawText（落库 raw_markdown）, spans }。
export function createSpanAccumulator() {
  const parts = [];
  const spans = [];
  let offset = 0;

  return {
    spans,
    // 追加一段文本：trim 后接进载体（+ '\n\n'），按 segmentSpans 段内偏移登记 spans。
    // segmentSpans（[{ text, start, end }]，相对 trim 后文本）不传 / 为空时整段作一个 span。
    // 返回这段占用的句位编号列表（供调用方挂节点 sourcePosition / indexes）。
    appendSegment(text, segmentSpans = null) {
      const normalized = String(text || '').trim();
      if (!normalized) return null;
      const start = offset;
      parts.push(normalized);
      offset += normalized.length;
      parts.push('\n\n'); // 段落分隔符是载体语义的一部分，偏移依赖它、不可改
      offset += 2;
      const segs = (Array.isArray(segmentSpans) && segmentSpans.length > 0)
        ? segmentSpans
        : [{ text: normalized, start: 0, end: normalized.length }];
      return appendSpans(spans, start, segs);
    },
    finalize() {
      return { rawText: parts.join('').trim(), spans };
    }
  };
}

// 导入器通用「段落空容器 + 句子子节点」装配（docx / epub / chm 共用）：切句 → 坐标 → 形态一趟做。
// 段落正文清空成空容器（半步 source_position、不进向量），每句作它的子节点；rolePrefix 区分来源
// （'docx' → docx-paragraph / docx-sentence，'html' → html-paragraph / html-sentence）。addRecord 是
// 各 reader 自己的建记录函数（签名 (parentAddress, text, role, options) → record；options 取 indexes /
// sourcePosition / skipVector）。返回段落容器 record（切不出句子返回 null，调用方据此 return / continue）。
export function addSentenceContainer({ acc, addRecord, parentAddress, text, rolePrefix }) {
  const normalized = String(text || '').trim();
  const segSpans = splitSentenceSpans(normalized, { hardLineBreaks: true });
  const sentenceTexts = segSpans.length > 0 ? segSpans.map((s) => s.text) : [normalized];
  const indexes = acc.appendSegment(text, segSpans.length > 0 ? segSpans : null);
  if (!indexes?.length) return null;
  const paragraph = addRecord(parentAddress, '', `${rolePrefix}-paragraph`, {
    indexes,
    sourcePosition: indexes[0] - 0.5,
    skipVector: true
  });
  if (!paragraph) return null;
  for (const [sentenceIndex, sentence] of sentenceTexts.entries()) {
    addRecord(paragraph.address, sentence, `${rolePrefix}-sentence`, {
      indexes: [indexes[sentenceIndex] ?? indexes.at(-1)],
      sourcePosition: indexes[sentenceIndex] ?? indexes.at(-1)
    });
  }
  return paragraph;
}
