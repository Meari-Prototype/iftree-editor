import { splitSentenceSpans } from './sentence-split.js';

export interface SourceSpanRecord {
  sentence_index: number;
  start_offset: number;
  end_offset: number;
  text: string;
}

interface SentenceSegment {
  text: string;
  start: number;
  end: number;
}

export function appendSpans(spans: SourceSpanRecord[], baseOffset: number, segmentSpans: SentenceSegment[]): number[] {
  const indexes: number[] = [];
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

interface SpanAccumulator {
  spans: SourceSpanRecord[];
  appendSegment(text: unknown, segmentSpans?: SentenceSegment[] | null): number[] | null;
  finalize(): { rawText: string; spans: SourceSpanRecord[] };
}

export function createSpanAccumulator(): SpanAccumulator {
  const parts: string[] = [];
  const spans: SourceSpanRecord[] = [];
  let offset = 0;

  return {
    spans,
    appendSegment(text: unknown, segmentSpans: SentenceSegment[] | null = null) {
      const normalized = String(text || '').trim();
      if (!normalized) return null;
      const start = offset;
      parts.push(normalized);
      offset += normalized.length;
      parts.push('\n\n');
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

interface AddSentenceContainerArgs {
  acc: SpanAccumulator;
  addRecord: (...args: any[]) => any;
  parentAddress: string;
  text: unknown;
  rolePrefix: string;
}

export function addSentenceContainer({ acc, addRecord, parentAddress, text, rolePrefix }: AddSentenceContainerArgs) {
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
      indexes: [indexes[sentenceIndex] ?? indexes.at(-1)!],
      sourcePosition: indexes[sentenceIndex] ?? indexes.at(-1)
    });
  }
  return paragraph;
}