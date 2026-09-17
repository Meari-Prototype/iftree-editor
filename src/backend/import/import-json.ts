// 智能导入的校验 + 入库命令实现（projectneed 4-3-3）。
// 吃流式写入（stream.push，4-16）同一契约的节点树 JSON——不另设格式（4-3-4）：
// {title, nodes:[{address, text, nodeTitle?, nodeNote?, nodeType?, trustLevel, sourcePosition?, children?}], vectors?}
// 校验逻辑全部机器化：LLM 只给文本，定位与数字由这里产生。
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import { splitSentences } from '../../core/tree.js';
import { isBlockMath } from '../../core/sentence-split.js';
import {
  IMPORTED_DOC_SOURCE_LOOKUP_BY_PATH_SQL,
  importedDocMetaPathLikePattern,
  matchImportedDocForSourcePaths,
  throwDuplicateImportError,
  type DocLookupRow
} from './import-service.js';

export interface ImportTreeNode {
  address?: string;
  text?: unknown;
  nodeTitle?: string;
  nodeNote?: string;
  nodeType?: string;
  trustLevel?: string;
  trust_level?: string;
  sourcePosition?: number;
  source_position?: number;
  role?: string;
  skipVector?: boolean;
  children?: ImportTreeNode[];
  [extra: string]: unknown;
}

export interface ImportPayload {
  title?: string;
  nodes?: ImportTreeNode[];
  docId?: unknown;
  parentId?: unknown;
  vectors?: unknown;
  splitSentences?: boolean;
  embed?: boolean;
  [extra: string]: unknown;
}

export interface ValidationError {
  kind: string;
  address: string;
  message: string;
  textPreview?: string;
}

export interface AnchorEntry {
  address: string;
  start: number;
  end: number;
}

export interface ValidateReport {
  ok: boolean;
  nodeCount: number;
  textNodeCount: number;
  virtualCount: number;
  anchors: AnchorEntry[];
  coverage: {
    coveredChars: number;
    sourceChars: number;
    ratio: number;
  };
  errors: ValidationError[];
}

// 与导入管线的源文本规范化语义一致（CRLF→LF、去 BOM）。
export function normalizeImportSourceText(raw: unknown): string {
  return String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^﻿/, '');
}

function flattenPreorder(nodes: unknown, out: ImportTreeNode[] = []): ImportTreeNode[] {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    out.push(node as ImportTreeNode);
    if (Array.isArray((node as ImportTreeNode)?.children) && (node as ImportTreeNode).children!.length) {
      flattenPreorder((node as ImportTreeNode).children, out);
    }
  }
  return out;
}

function nodeText(node: ImportTreeNode | null | undefined): string {
  return typeof node?.text === 'string' ? node.text : '';
}

function nodeAddress(node: ImportTreeNode | null | undefined): string {
  return String(node?.address ?? '').trim();
}

function preview(text: unknown, limit = 80): string {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

// 地址连续性预检（与 store._validateStreamAddresses 同语义，4-16-2）：
// 新建文档场景挂载点是根节点（address = '1'），顶层节点必须是 1-1、1-2…。
// 前置在校验报告里给出，省得 push 阶段才炸。
function validateAddresses(nodes: ImportTreeNode[] | unknown, parentAddress: string, errors: ValidationError[]): void {
  let expected = 1;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const typedNode = node as ImportTreeNode;
    const addr = nodeAddress(typedNode);
    if (!addr) {
      errors.push({ kind: 'address_missing', address: '', message: `父 ${parentAddress || '(根)'} 下存在缺少 address 的节点` });
      return;
    }
    const cut = addr.lastIndexOf('-');
    const prefix = cut > 0 ? addr.slice(0, cut) : '';
    const order = Number(addr.slice(cut + 1));
    if (prefix !== parentAddress) {
      errors.push({ kind: 'address_prefix', address: addr, message: `地址 ${addr} 的父前缀应为 ${parentAddress || '(根)'}` });
    } else if (!Number.isInteger(order) || order !== expected) {
      errors.push({ kind: 'address_order', address: addr, message: `地址不连续：父 ${parentAddress} 下期望 ${parentAddress}-${expected}，收到 ${addr}` });
    }
    expected += 1;
    if (Array.isArray(typedNode.children) && typedNode.children.length) {
      validateAddresses(typedNode.children, addr, errors);
    }
  }
}

// 契约增强：address 缺失时按 children 嵌套前序自动补全（顶层 1-1、1-2…，子节点 父地址-序号）。
// agent 只贡献「哪里是章节、哪里是段落」的结构与逐字文本，连续地址这种纯机械的事由这里生成——
// 规则先于 LLM，地址连续性不该让模型写代码去算（最易翻车处）。已带 address 的节点原样保留（向后兼容）。
export function fillMissingAddresses(nodes: ImportTreeNode[] | unknown, parentAddress: string = '1'): ImportTreeNode[] {
  return (Array.isArray(nodes) ? nodes : []).map((node, index) => {
    const typedNode = node as ImportTreeNode;
    const address = String(typedNode?.address ?? '').trim() || `${parentAddress}-${index + 1}`;
    const next: ImportTreeNode = { ...typedNode, address };
    if (Array.isArray(typedNode?.children) && typedNode.children.length) {
      next.children = fillMissingAddresses(typedNode.children, address);
    }
    return next;
  });
}

// 插入 gap 节点后整树位置变了，必须按 children 前序重排全部地址（不能沿用旧 address，否则与新位置撞号）。
export function reassignAddresses(nodes: ImportTreeNode[] | unknown, parentAddress: string = '1'): ImportTreeNode[] {
  return (Array.isArray(nodes) ? nodes : []).map((node, index) => {
    const typedNode = node as ImportTreeNode;
    const address = `${parentAddress}-${index + 1}`;
    const next: ImportTreeNode = { ...typedNode, address };
    if (Array.isArray(typedNode?.children) && typedNode.children.length) {
      next.children = reassignAddresses(typedNode.children, address);
    }
    return next;
  });
}

// 核心校验（4-3-3）：
// 正文存在性——非空 text 必须逐字节存在于导入源；
// 顺序一致性——树前序与源文出现位置单调对应，重复文本按树序贪心消歧；
// 全覆盖——源文非空白区间必须被某节点逐字节覆盖，漏掉的正文（uncovered）即 error 不放行；纯空白不报。
// 虚拟节点形态——text 为空的节点必须带数值 source_position（9-1-1 半步偏移）。
export function validateImportTree(payload: ImportPayload | null | undefined, sourceText: unknown): ValidateReport {
  const source = normalizeImportSourceText(sourceText);
  const errors: ValidationError[] = [];
  const nodes = Array.isArray(payload?.nodes) ? payload!.nodes : [];
  if (nodes.length === 0) {
    errors.push({ kind: 'empty', address: '', message: 'nodes 为空：契约要求至少一个节点' });
  }
  if (payload?.docId != null || payload?.parentId != null) {
    errors.push({ kind: 'payload', address: '', message: 'import-json 总是新建文档，payload 不接受 docId/parentId（续推请直接用 db push）' });
  }
  if (!String(payload?.title || '').trim()) {
    errors.push({ kind: 'payload', address: '', message: '缺少 title：新建文档需要标题' });
  }
  validateAddresses(nodes, '1', errors);

  const flat = flattenPreorder(nodes);
  const anchors: AnchorEntry[] = [];
  let cursor = 0;
  let virtualCount = 0;
  for (const node of flat) {
    const address = nodeAddress(node);
    const trustLevel = String(node?.trustLevel ?? node?.trust_level ?? '').trim();
    if (trustLevel !== '受控' && trustLevel !== '不受控') {
      errors.push({ kind: 'trust_level', address, message: `节点 ${address} 缺少显式 trust_level（受控 / 不受控）` });
    }
    const text = nodeText(node);
    if (!text) {
      virtualCount += 1;
      const position = Number(node?.sourcePosition ?? node?.source_position);
      if (!Number.isFinite(position)) {
        errors.push({ kind: 'virtual_source_position', address, message: `虚拟节点 ${address}（text 为空）必须带数值 source_position（9-1-1 半步偏移，如相邻句位减 0.5）` });
      }
      continue;
    }
    const start = source.indexOf(text, cursor);
    if (start >= 0) {
      anchors.push({ address, start, end: start + text.length });
      cursor = start + text.length;
      continue;
    }
    const anywhere = source.indexOf(text);
    errors.push(anywhere >= 0
      ? { kind: 'out_of_order', address, message: `节点 ${address} 的正文存在于源文，但位置在已消费区间之前——树前序必须与源文顺序单调对应`, textPreview: preview(text) }
      : { kind: 'missing', address, message: `节点 ${address} 的正文在导入源中不存在（逐字节比对；检查换行/空白/省略号等差异）`, textPreview: preview(text) });
  }

  let coveredChars = 0;
  let previousEnd = 0;
  for (const anchor of anchors) {
    coveredChars += anchor.end - anchor.start;
    if (anchor.start > previousEnd) {
      const gapText = source.slice(previousEnd, anchor.start);
      // 带内容的未覆盖区间 → error：系统只呈现「源文这段没被 JSON 映射进来」，不替 agent 兜底补全，
      // 也不猜它是不是页眉页脚——纯文本没有那种结构标记，判噪声是语义活、不归系统管。
      // 纯空白（段落间换行、分页符）不报：段落空容器的半步位置已表达边界。
      if (gapText.trim()) {
        errors.push({ kind: 'uncovered', address: anchor.address, message: `源文有正文未被任何节点覆盖（位于节点 ${anchor.address} 之前）——检查切割是否漏了这段`, textPreview: preview(gapText) });
      }
    }
    previousEnd = Math.max(previousEnd, anchor.end);
  }
  if (previousEnd < source.length) {
    const tail = source.slice(previousEnd);
    if (tail.trim()) {
      errors.push({ kind: 'uncovered', address: '', message: '源文末尾有正文未被任何节点覆盖——检查切割是否漏了结尾这段', textPreview: preview(tail) });
    }
  }

  return {
    ok: errors.length === 0,
    nodeCount: flat.length,
    textNodeCount: anchors.length + errors.filter((item) => item.kind === 'missing' || item.kind === 'out_of_order').length,
    virtualCount,
    anchors,
    // coverage 只统计被节点逐字节锚定的字符占比；纯空白区间（不报 uncovered）不算覆盖，
    // 所以 ok:true 时 ratio 仍可能 <1。仅供 dry-run 报告参考，不参与放行判定。
    coverage: {
      coveredChars,
      sourceChars: source.length,
      ratio: source.length > 0 ? Math.round((coveredChars / source.length) * 1000) / 1000 : 0
    },
    errors
  };
}

// 锚定结果 → 源文档层：spans 顺序编号即句位（sentence_index），
// text 节点缺省 source_position 时回填它锚定的句位——智能导入文档
// 因此获得与直写导入同等的句位对照/选区高亮能力（4-3-3）。
function fillSourcePositions(nodes: ImportTreeNode[] | unknown, anchorIndexByAddress: Map<string, number>): ImportTreeNode[] {
  return (Array.isArray(nodes) ? nodes : []).map((node) => {
    const typedNode = node as ImportTreeNode;
    const next: ImportTreeNode = { ...typedNode };
    const address = nodeAddress(typedNode);
    if (nodeText(typedNode) && next.sourcePosition == null && next.source_position == null) {
      const index = anchorIndexByAddress.get(address);
      if (index != null) next.sourcePosition = index;
    }
    if (Array.isArray(typedNode.children) && typedNode.children.length) {
      next.children = fillSourcePositions(typedNode.children, anchorIndexByAddress);
    }
    return next;
  });
}

interface CreatedNode {
  id: string;
  children?: CreatedNode[];
}

function zipCreatedIds(
  payloadNodes: ImportTreeNode[] | unknown,
  createdNodes: CreatedNode[] | unknown,
  idByAddress: Map<string, string> = new Map()
): Map<string, string> {
  const created = (Array.isArray(createdNodes) ? createdNodes : []) as CreatedNode[];
  (Array.isArray(payloadNodes) ? payloadNodes : []).forEach((node, index) => {
    const typedNode = node as ImportTreeNode;
    const match = created[index];
    if (!match) return;
    idByAddress.set(nodeAddress(typedNode), match.id);
    if (Array.isArray(typedNode.children) && typedNode.children.length) {
      zipCreatedIds(typedNode.children, match.children, idByAddress);
    }
  });
  return idByAddress;
}

// 切句子（照完整导入「切到句子」那档的形态）：把每个叶子段落正文节点变成「空容器 + 句子子节点」——
// 段落节点正文清空、给半步 source_position（标记它是段落边界容器）、不进向量；段落正文按句末标点
// 切成句子、每句作它的子节点。章节容器（有子）只递归、标题占一个句位；已是空节点的原样。
export function splitParagraphsToSentenceContainers(nodes: ImportTreeNode[] | unknown): ImportTreeNode[] {
  let ordinal = 0; // 已分配句位的正文节点数（标题 + 句子），= 校验锚定后的句位
  const walk = (list: ImportTreeNode[] | unknown): ImportTreeNode[] => (Array.isArray(list) ? list : []).flatMap((node): ImportTreeNode[] => {
    const typedNode = node as ImportTreeNode;
    const children = Array.isArray(typedNode.children) ? typedNode.children : [];
    const text = typeof typedNode.text === 'string' ? typedNode.text : '';
    if (children.length > 0) {
      if (text) ordinal += 1; // 章节标题正文占一个句位
      return [{ ...typedNode, children: walk(children) }];
    }
    if (!text) return []; // 空节点：丢弃（智能导入只产嵌套 + 正文，误产的空节点不入库）
    const sentences = splitSentences(text);
    if (sentences.length === 0) return []; // 切不出句子（纯空白 / 纯标点段落）：丢弃、不产空容器
    const trust = typedNode.trustLevel ?? typedNode.trust_level ?? '不受控';
    // 纯公式段落（整段就一个 $$ / \[ 块）：整块一个 math 节点，拉齐完整导入待遇——不套容器、不切、不进向量。
    if (sentences.length === 1 && isBlockMath(sentences[0])) {
      ordinal += 1;
      return [{ ...typedNode, text: sentences[0], role: 'math', skipVector: true, trustLevel: trust }];
    }
    const firstOrdinal = ordinal + 1; // 段落容器半步 = 首句句位 − 0.5
    const sentenceNodes: ImportTreeNode[] = sentences.map((sentence) => {
      ordinal += 1;
      // 段落内夹的公式块也整块 + 标 math + skipVector（与完整导入一致）；其余是普通句子。
      return isBlockMath(sentence)
        ? { text: sentence, role: 'math', skipVector: true, trustLevel: trust }
        : { text: sentence, role: 'sentence', trustLevel: trust };
    });
    return [{
      ...typedNode,
      text: '',
      role: 'paragraph',
      skipVector: true,
      sourcePosition: firstOrdinal - 0.5,
      children: sentenceNodes
    }];
  });
  return walk(nodes);
}

export interface ImportJsonDatabase {
  run(
    request: { operation: 'write'; payload: Record<string, unknown> },
    role: 'write'
  ): Promise<Record<string, unknown> | null | undefined>;
  run(
    request: { operation: 'read'; payload: Record<string, unknown> },
    role: 'read'
  ): Promise<Record<string, unknown> | null | undefined>;
}

// 与 importFilePathsToStore 同口径的源路径查重（import-service 的 matchImportedDocForSourcePaths）：
// import-json 手上只有 db 契约、没有 store 句柄，所以用同一条 SQL 走只读 action 取候选行，判定复用纯函数。
// 不查的话同一份源文可以被反复导成多个 doc，library 侧「文件↔文档」一对一的前提就破了。
async function assertSourcePathNotImported(database: ImportJsonDatabase, sourcePath: string): Promise<void> {
  const result = await database.run({
    operation: 'read',
    payload: {
      action: 'debug.sql',
      sql: IMPORTED_DOC_SOURCE_LOOKUP_BY_PATH_SQL,
      params: { path: sourcePath, metaLike: importedDocMetaPathLikePattern(sourcePath) }
    }
  }, 'read') as { rows?: DocLookupRow[] } | null | undefined;
  throwDuplicateImportError(matchImportedDocForSourcePaths(result?.rows || [], [sourcePath]));
}

export interface RunImportJsonInput {
  database: ImportJsonDatabase;
  jsonPath: string;
  sourcePath: string;
  dryRun?: boolean;
  embed?: boolean;
}

export async function runImportJson({ database, jsonPath, sourcePath, dryRun = false, embed = false }: RunImportJsonInput): Promise<Record<string, unknown>> {
  if (!database) throw new Error('import-json requires a database service');
  const resolvedJsonPath = resolve(String(jsonPath || ''));
  const resolvedSourcePath = resolve(String(sourcePath || ''));
  let payload: ImportPayload;
  try {
    payload = JSON.parse(normalizeImportSourceText(readFileSync(resolvedJsonPath, 'utf8'))) as ImportPayload;
  } catch (error) {
    throw new Error(`无法读取节点树 JSON（${resolvedJsonPath}）：${(error as { message?: string }).message || error}`);
  }
  const source = normalizeImportSourceText(readFileSync(resolvedSourcePath, 'utf8'));
  // 同步建向量统一用 embed；JSON 顶层旧的 vectors 字段不再认，传了直接报错、别静默不建。
  if (payload && typeof payload === 'object' && payload.vectors !== undefined) {
    throw new Error('import-json 用 embed 表示同步建向量，不再接受 vectors 参数。');
  }

  // 契约增强：先按 children 前序补全缺失的 address（agent 不必自己算地址）。
  let addressedNodes = fillMissingAddresses(payload.nodes);
  // 切句子开关：把段落正文节点变成空容器（半步位置、不进向量）+ 句子子节点，照完整导入「切到句子」的形态。
  if (payload.splitSentences === true) {
    addressedNodes = reassignAddresses(splitParagraphsToSentenceContainers(addressedNodes));
  }
  // 校验：正文逐字节存在 + 前序顺序 + 全覆盖。源文有正文没被映射进来（uncovered）即 error 不入库——
  // 系统只接 JSON、呈现错误，不替 agent 的切割脚本兜底补全（智能导入的「智能」是 agent 的事，不是系统的）。
  const report = validateImportTree({ ...payload, nodes: addressedNodes }, source);
  if (!report.ok || dryRun) {
    return { imported: false, dryRun: Boolean(dryRun), ...report };
  }

  const anchorIndexByAddress = new Map(report.anchors.map((anchor, index) => [anchor.address, index + 1]));
  const nodes = fillSourcePositions(addressedNodes, anchorIndexByAddress);
  const spans = report.anchors.map((anchor, index) => ({
    sentence_index: index + 1,
    start_offset: anchor.start,
    end_offset: anchor.end,
    text: source.slice(anchor.start, anchor.end)
  }));

  // 查重在建文档之前：撞了就什么都别开始（错误文案与普通导入同一条，见 throwDuplicateImportError）。
  await assertSourcePathNotImported(database, resolvedSourcePath);

  const shouldEmbed = embed === true || payload.embed === true;
  // 先 doc.create、再往这个 docId 上推（而不是 push 省略 docId 的首推自建）：首推自建的文档没有源文件锚，
  // library_index 按文件系统匹配找不到它，stream.push 已为此立守卫拒收（handlers/write/doc.ts）。
  // 锚在第一笔写入就写死在 meta.sourcePath 上——library_index 与源路径查重都读它，不靠后面的 attachSource 补；
  // 中途失败留下的半成品也因此带着源路径，下次导入同一份源文查重拦得住。
  // meta 必须是 JSON 文本：store.createDoc 把它原样写进 docs.meta 列，给对象会存成 "[object Object]"。
  // 字段与 importFilePathsToStore 建文档时同构（sourcePath / importedAt + 一个导入方式标记）。
  // skipInitialCommit：此刻文档只有一个空根、没有源文档层，立 commit 就是把「空文章」写进历史——
  // 用户回退到初始版本等于删空文章、连 source 行一起没掉。唯一的 commit 留到内容落齐后建（见下）。
  const createResult = await database.run({
    operation: 'write',
    payload: {
      action: 'doc.create',
      title: String(payload.title).trim(),
      meta: JSON.stringify({
        sourcePath: resolvedSourcePath,
        importedAt: new Date().toISOString(),
        smartImport: true
      }),
      skipInitialCommit: true
    }
  }, 'write') as { docId?: unknown } | null | undefined;
  const docId = createResult?.docId;
  if (!docId) throw new Error('doc.create 未返回 docId');

  // doc.create 之后任何一步失败都要把这篇收走：留下的是「有壳无内容」或「有节点、无源文档层」的
  // 残缺文档——它绕过了导入的原子性承诺。回滚放在 bulkEnd 之后（外层 try 包内层 try/finally）：
  // bulk 会话还开着就删文档，等于让派生索引维护跨在会话里收尾，顺序上更容易出二次错。
  let createdCount: number | undefined;
  try {
    // push 只收 incremental 文档（4-16 流式写入不走 edit branch），doc.create 建出来的是 full。
    // incremental 只是这段推送的通行证，推完切回 full（见下）。
    await database.run({
      operation: 'write',
      payload: { action: 'doc.setEditMode', docId, mode: 'incremental', includeDoc: false }
    }, 'write');

    await database.run({ operation: 'write', payload: { action: 'stream.bulkBegin' } }, 'write');
    try {
      // 不传 parentId：挂载点默认取该文档的根节点（address 恒为 '1'），正是校验器假定的挂载点
      //（validateAddresses 以 '1' 为父前缀校验顶层）。于是顶层 1-1、1-2… 原样落库、地址零偏移，
      // zipCreatedIds / anchorIndexByAddress / nodeIdsBySentenceIndex 这三套按地址对齐的映射照旧成立。
      // 树里不含根：根节点由 doc.create 建、正文取 title（与普通导入的 rootText 同口径），它不参与句位锚定。
      const pushResult = await database.run({
        operation: 'write',
        payload: {
          action: 'stream.push',
          docId,
          nodes,
          embed: shouldEmbed
        }
      }, 'write') as { created?: CreatedNode[]; createdCount?: number } | null | undefined;

      const idByAddress = zipCreatedIds(nodes, pushResult?.created);
      const nodeIdsBySentenceIndex: Record<number, string> = {};
      for (const [address, sentenceIndex] of anchorIndexByAddress) {
        const nodeId = idByAddress.get(address);
        if (nodeId) nodeIdsBySentenceIndex[sentenceIndex] = nodeId;
      }
      await database.run({
        operation: 'write',
        payload: {
          action: 'stream.attachSource',
          docId,
          sourcePath: resolvedSourcePath,
          sourceType: extname(resolvedSourcePath).slice(1).toLowerCase() || 'md',
          rawMarkdown: source,
          spans,
          nodeIdsBySentenceIndex
        }
      }, 'write');

      createdCount = pushResult?.createdCount;
    } finally {
      // bulkEnd 带 embed：写分发收尾据此对本批文档统一建（或不建）向量。
      await database.run({ operation: 'write', payload: { action: 'stream.bulkEnd', embed: shouldEmbed } }, 'write');
    }

    // 切回 full：智能导入产物是一篇完整文档，该和普通导入产物一样能正常编辑，
    // 不该停在「只能追加」的 incremental 档上。
    await database.run({
      operation: 'write',
      payload: { action: 'doc.setEditMode', docId, mode: 'full', includeDoc: false }
    }, 'write');
    // 「导入」commit 押到 attachSource 之后才建，与 importFilePathsToStore 同一条纪律
    //（见 import-service 的 createImportInitialCommit 注释）：建树时就建 commit 的话快照缺原文层，
    // restore 回那一版会把 source 行静默删掉。配合上面的 skipInitialCommit，这是本文档唯一的 commit，
    // 也是 head 所指——历史里没有可以把文章回退成空的那一版。
    await database.run({
      operation: 'write',
      payload: { action: 'history.save', docId, summary: '导入', owner: 'import' }
    }, 'write');

    return {
      ...report,
      ok: true,
      imported: true,
      docId,
      createdCount,
      spanCount: spans.length
    };
  } catch (error) {
    // best-effort 回滚：删不掉也要把原始错误抛给调用方（回滚失败不该盖住真正的失败原因）。
    try {
      await database.run({ operation: 'write', payload: { action: 'doc.delete', docId } }, 'write');
    } catch { /* 回滚失败：残留文档交由用户/运维删除，原始错误照常上抛 */ }
    throw error;
  }
}
