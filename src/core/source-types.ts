// 导入 / 源文档层共享类型（source-* 与 import-formats 复用，单一来源）。
// 各 reader（md/txt/pdf/docx/epub/chm）产出 SourceDocument，import-formats 消费。
// 字段宽松 + index signature：不同 reader 带的额外字段不报错，按"标边界、内部靠推断"约定。

export interface SourceSpan {
  sentence_index: number;
  start_offset: number;
  end_offset: number;
  text: string;
  [key: string]: unknown;
}

export interface SourceDocument {
  sourcePath?: string;
  sourceType?: string;
  rawMarkdown?: string;
  rawText?: string;
  raw_markdown?: string;
  spans?: SourceSpan[];
  [key: string]: unknown;
}

export interface SourceRecord {
  index?: number;
  address?: string;
  text: string;
  nodeType?: string;
  trustLevel?: unknown;
  vector?: number[] | null;
  [key: string]: unknown;
}

export interface SourceStructure {
  headingCount: number;
  [key: string]: unknown;
}

export interface ImportOptions {
  mode?: string;
  chunkSize?: number;
  overlap?: number;
  granularity?: string;
  [key: string]: unknown;
}
