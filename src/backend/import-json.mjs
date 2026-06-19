// 智能导入的校验 + 入库命令实现（projectneed 4-3-3）。
// 吃流式写入（stream.push，4-16）同一契约的节点树 JSON——不另设格式（4-3-4）：
// {title, nodes:[{address, text, nodeTitle?, nodeNote?, nodeType?, trustLevel, sourcePosition?, children?}], vectors?}
// 校验逻辑全部机器化：LLM 只给文本，定位与数字由这里产生。
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

// 与导入管线的源文本规范化语义一致（CRLF→LF、去 BOM）；不 import core 层，避免耦合文件重组。
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
      if (gapText.trim()) gaps.push({ start: previousEnd, end: anchor.start, preview: preview(gapText) });
    }
    previousEnd = Math.max(previousEnd, anchor.end);
  }
  if (previousEnd < source.length) {
    const tail = source.slice(previousEnd);
    if (tail.trim()) gaps.push({ start: previousEnd, end: source.length, preview: preview(tail) });
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

  const report = validateImportTree(payload, source);
  const blockedByGaps = report.gaps.length > 0 && !allowGaps;
  if (!report.ok || blockedByGaps || dryRun) {
    return {
      ok: report.ok && !blockedByGaps,
      imported: false,
      dryRun: Boolean(dryRun),
      ...(blockedByGaps ? { gapPolicy: '存在未覆盖区间；确认 gap 合理（页眉页脚等）后用 --allow-gaps 放行' } : {}),
      ...report
    };
  }

  const anchorIndexByAddress = new Map(report.anchors.map((anchor, index) => [anchor.address, index + 1]));
  const nodes = fillSourcePositions(payload.nodes, anchorIndexByAddress);
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
    await database.run({ operation: 'write', payload: { action: 'stream.bulkEnd' } }, 'write');
  }
}
