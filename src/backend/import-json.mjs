// 智能导入的校验 + 入库命令实现（projectneed 4-3-3）。
// 吃流式写入（stream.push，4-16）同一契约的节点树 JSON——不另设格式（4-3-4）：
// {title, nodes:[{address, text, nodeTitle?, nodeNote?, nodeType?, trustLevel, sourcePosition?, children?}], vectors?}
// 校验逻辑全部机器化：LLM 只给文本，定位与数字由这里产生。
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import { splitSentences } from '../core/tree.mjs';
import { isBlockMath } from '../core/sentence-split.mjs';

// 与导入管线的源文本规范化语义一致（CRLF→LF、去 BOM）。
export function normalizeImportSourceText(raw) {
  return String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^﻿/, '');
}

function flattenPreorder(nodes, out = []) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    out.push(node);
    if (Array.isArray(node?.children) && node.children.length) flattenPreorder(node.children, out);
  }
  return out;
}

function nodeText(node) {
  return typeof node?.text === 'string' ? node.text : '';
}

function nodeAddress(node) {
  return String(node?.address ?? '').trim();
}

function preview(text, limit = 80) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

// 地址连续性预检（与 store._validateStreamAddresses 同语义，4-16-2）：
// 新建文档场景挂载点是根节点（address = '1'），顶层节点必须是 1-1、1-2…。
// 前置在校验报告里给出，省得 push 阶段才炸。
function validateAddresses(nodes, parentAddress, errors) {
  let expected = 1;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const addr = nodeAddress(node);
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
    if (Array.isArray(node.children) && node.children.length) {
      validateAddresses(node.children, addr, errors);
    }
  }
}

// 契约增强：address 缺失时按 children 嵌套前序自动补全（顶层 1-1、1-2…，子节点 父地址-序号）。
// agent 只贡献「哪里是章节、哪里是段落」的结构与逐字文本，连续地址这种纯机械的事由这里生成——
// 规则先于 LLM，地址连续性不该让模型写代码去算（最易翻车处）。已带 address 的节点原样保留（向后兼容）。
export function fillMissingAddresses(nodes, parentAddress = '1') {
  return (Array.isArray(nodes) ? nodes : []).map((node, index) => {
    const address = String(node?.address ?? '').trim() || `${parentAddress}-${index + 1}`;
    const next = { ...node, address };
    if (Array.isArray(node?.children) && node.children.length) {
      next.children = fillMissingAddresses(node.children, address);
    }
    return next;
  });
}

// 插入 gap 节点后整树位置变了，必须按 children 前序重排全部地址（不能沿用旧 address，否则与新位置撞号）。
export function reassignAddresses(nodes, parentAddress = '1') {
  return (Array.isArray(nodes) ? nodes : []).map((node, index) => {
    const address = `${parentAddress}-${index + 1}`;
    const next = { ...node, address };
    if (Array.isArray(node?.children) && node.children.length) {
      next.children = reassignAddresses(node.children, address);
    }
    return next;
  });
}

// 核心校验（4-3-3）：
// 正文存在性——非空 text 必须逐字节存在于导入源；
// 顺序一致性——树前序与源文出现位置单调对应，重复文本按树序贪心消歧；
// 覆盖率——报告源文未被任何节点覆盖的非空白区间（gap）；
// 虚拟节点形态——text 为空的节点必须带数值 source_position（9-1-1 半步偏移）。
export function validateImportTree(payload, sourceText) {
  const source = normalizeImportSourceText(sourceText);
  const errors = [];
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
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
  const anchors = [];
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

  const gaps = [];
  let coveredChars = 0;
  let previousEnd = 0;
  for (const anchor of anchors) {
    coveredChars += anchor.end - anchor.start;
    if (anchor.start > previousEnd) {
      const gapText = source.slice(previousEnd, anchor.start);
      // 只记带内容的 gap（⸻、漏的正文段）：纯空白（段落间换行、分页符）由段落空容器的半步位置表达
      // 边界、不补节点。beforeAddress = 下一个内容节点（null=文档末尾）。
      if (gapText.trim()) gaps.push({ start: previousEnd, end: anchor.start, beforeAddress: anchor.address, preview: preview(gapText) });
    }
    previousEnd = Math.max(previousEnd, anchor.end);
  }
  if (previousEnd < source.length) {
    const tail = source.slice(previousEnd);
    if (tail.trim()) gaps.push({ start: previousEnd, end: source.length, beforeAddress: null, preview: preview(tail) });
  }

  return {
    ok: errors.length === 0,
    nodeCount: flat.length,
    textNodeCount: anchors.length + errors.filter((item) => item.kind === 'missing' || item.kind === 'out_of_order').length,
    virtualCount,
    anchors,
    gaps,
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
function fillSourcePositions(nodes, anchorIndexByAddress) {
  return (Array.isArray(nodes) ? nodes : []).map((node) => {
    const next = { ...node };
    const address = nodeAddress(node);
    if (nodeText(node) && next.sourcePosition == null && next.source_position == null) {
      const index = anchorIndexByAddress.get(address);
      if (index != null) next.sourcePosition = index;
    }
    if (Array.isArray(node.children) && node.children.length) {
      next.children = fillSourcePositions(node.children, anchorIndexByAddress);
    }
    return next;
  });
}

function zipCreatedIds(payloadNodes, createdNodes, idByAddress = new Map()) {
  const created = Array.isArray(createdNodes) ? createdNodes : [];
  (Array.isArray(payloadNodes) ? payloadNodes : []).forEach((node, index) => {
    const match = created[index];
    if (!match) return;
    idByAddress.set(nodeAddress(node), match.id);
    if (Array.isArray(node.children) && node.children.length) {
      zipCreatedIds(node.children, match.children, idByAddress);
    }
  });
  return idByAddress;
}

// gap 补节点：只补带内容的 gap（⸻、漏的正文段）——补成正文节点（text = 去首尾空白的原文），
// 插在「下一个内容节点」之前（同层）；纯空白 gap 不进来（gap 检测已只记带内容的）。
export function fillGapNodes(nodes, gaps, source) {
  if (!Array.isArray(gaps) || gaps.length === 0) return nodes;
  const gapsByBefore = new Map();
  for (const gap of gaps) {
    const key = gap.beforeAddress ?? '';
    if (!gapsByBefore.has(key)) gapsByBefore.set(key, []);
    gapsByBefore.get(key).push(gap);
  }
  const makeNode = (gap) => ({ text: source.slice(gap.start, gap.end).trim(), trustLevel: '不受控' });
  const walk = (list) => {
    const out = [];
    for (const node of Array.isArray(list) ? list : []) {
      const leading = gapsByBefore.get(nodeAddress(node));
      if (leading) for (const gap of leading) out.push(makeNode(gap)); // 插在该节点之前
      const next = { ...node };
      if (Array.isArray(node.children) && node.children.length) next.children = walk(node.children);
      out.push(next);
    }
    return out;
  };
  const result = walk(nodes);
  const trailing = gapsByBefore.get(''); // 文档末尾的 gap
  return trailing ? [...result, ...trailing.map(makeNode)] : result;
}

// 切句子（照完整导入「切到句子」那档的形态）：把每个叶子段落正文节点变成「空容器 + 句子子节点」——
// 段落节点正文清空、给半步 source_position（标记它是段落边界容器）、不进向量；段落正文按句末标点
// 切成句子、每句作它的子节点。章节容器（有子）只递归、标题占一个句位；已是空节点的原样。
export function splitParagraphsToSentenceContainers(nodes) {
  let ordinal = 0; // 已分配句位的正文节点数（标题 + 句子），= 校验锚定后的句位
  const walk = (list) => (Array.isArray(list) ? list : []).flatMap((node) => {
    const children = Array.isArray(node.children) ? node.children : [];
    const text = typeof node.text === 'string' ? node.text : '';
    if (children.length > 0) {
      if (text) ordinal += 1; // 章节标题正文占一个句位
      return [{ ...node, children: walk(children) }];
    }
    if (!text) return []; // 空节点：丢弃（智能导入只产嵌套 + 正文，误产的空节点不入库）
    const sentences = splitSentences(text);
    if (sentences.length === 0) return []; // 切不出句子（纯空白 / 纯标点段落）：丢弃、不产空容器
    const trust = node.trustLevel ?? node.trust_level ?? '不受控';
    // 纯公式段落（整段就一个 $$ / \[ 块）：整块一个 math 节点，拉齐完整导入待遇——不套容器、不切、不进向量。
    if (sentences.length === 1 && isBlockMath(sentences[0])) {
      ordinal += 1;
      return [{ ...node, text: sentences[0], role: 'math', skipVector: true, trustLevel: trust }];
    }
    const firstOrdinal = ordinal + 1; // 段落容器半步 = 首句句位 − 0.5
    const sentenceNodes = sentences.map((sentence) => {
      ordinal += 1;
      // 段落内夹的公式块也整块 + 标 math + skipVector（与完整导入一致）；其余是普通句子。
      return isBlockMath(sentence)
        ? { text: sentence, role: 'math', skipVector: true, trustLevel: trust }
        : { text: sentence, role: 'sentence', trustLevel: trust };
    });
    return [{
      ...node,
      text: '',
      role: 'paragraph',
      skipVector: true,
      sourcePosition: firstOrdinal - 0.5,
      children: sentenceNodes
    }];
  });
  return walk(nodes);
}

export async function runImportJson({ database, jsonPath, sourcePath, dryRun = false, allowGaps = false, embed = false }) {
  if (!database) throw new Error('import-json requires a database service');
  const resolvedJsonPath = resolve(String(jsonPath || ''));
  const resolvedSourcePath = resolve(String(sourcePath || ''));
  let payload;
  try {
    payload = JSON.parse(normalizeImportSourceText(readFileSync(resolvedJsonPath, 'utf8')));
  } catch (error) {
    throw new Error(`无法读取节点树 JSON（${resolvedJsonPath}）：${error.message || error}`);
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
  let report = validateImportTree({ ...payload, nodes: addressedNodes }, source);
  // gap 只补带内容的（⸻、漏的正文段）成正文节点；纯空白（段落间换行、分页符）不补——段落空容器的半步
  // 位置就是边界。补完重排地址、重新校验。
  if (report.gaps.length > 0) {
    addressedNodes = reassignAddresses(fillGapNodes(addressedNodes, report.gaps, source));
    report = validateImportTree({ ...payload, nodes: addressedNodes }, source);
  }
  if (!report.ok || dryRun) {
    return { ok: report.ok, imported: false, dryRun: Boolean(dryRun), ...report };
  }

  const anchorIndexByAddress = new Map(report.anchors.map((anchor, index) => [anchor.address, index + 1]));
  const nodes = fillSourcePositions(addressedNodes, anchorIndexByAddress);
  const spans = report.anchors.map((anchor, index) => ({
    sentence_index: index + 1,
    start_offset: anchor.start,
    end_offset: anchor.end,
    text: source.slice(anchor.start, anchor.end)
  }));

  await database.run({ operation: 'write', payload: { action: 'stream.bulkBegin' } }, 'write');
  try {
    const pushResult = await database.run({
      operation: 'write',
      payload: {
        action: 'stream.push',
        title: String(payload.title).trim(),
        nodes,
        embed: embed === true || payload.embed === true
      }
    }, 'write');
    const docId = pushResult?.docId;
    if (!docId) throw new Error('stream.push 未返回 docId');

    const idByAddress = zipCreatedIds(nodes, pushResult.created);
    const nodeIdsBySentenceIndex = {};
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

    return {
      ok: true,
      imported: true,
      docId,
      createdCount: pushResult.createdCount,
      spanCount: spans.length,
      ...report
    };
  } finally {
    // bulkEnd 带 embed：写分发收尾据此对本批文档统一建（或不建）向量。
    await database.run({ operation: 'write', payload: { action: 'stream.bulkEnd', embed: embed === true || payload.embed === true } }, 'write');
  }
}
