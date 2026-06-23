import { statSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';

import { importRecordsForFile } from '../core/import-formats/router.mjs';
import { normalizeImportMode } from '../core/import-formats/shared.mjs';
import { isSameOrChildPath, normalizeLibraryRelativePath } from './library-fs.mjs';
import { normalizeStableId, sameStableId } from './db/ids.mjs';

function parseDocMetaJson(meta) {
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) return meta;
  try {
    return meta ? JSON.parse(meta) : {};
  } catch {
    return {};
  }
}

function pathKey(value) {
  return resolve(String(value || '')).toLowerCase();
}

// 路径前缀替换（库文件移动/改名后重写源绑定用）：target 落在 fromPath 下时把前缀换成 toPath，
// target 恰为 fromPath 时整体替换为 toPath。
function replacePathPrefix(target, fromPath, toPath) {
  const targetResolved = resolve(target);
  const fromResolved = resolve(fromPath);
  if (pathKey(targetResolved) === pathKey(fromResolved)) return resolve(toPath);
  const suffix = targetResolved.slice(fromResolved.length).replace(/^[\\/]+/, '');
  return join(resolve(toPath), suffix);
}

function sourcePathKey(value) {
  const raw = String(value || '').trim();
  return raw ? pathKey(raw) : '';
}

function docSourcePathKeys(row) {
  const meta = parseDocMetaJson(row.meta);
  return [meta.sourcePath, row.original_path].map(sourcePathKey).filter(Boolean);
}

function sortExistingDocs(left, right) {
  return String(right.updated_at || '').localeCompare(String(left.updated_at || '')) || String(right.id || '').localeCompare(String(left.id || ''));
}

function findExistingImportedDocForSourcePaths(store, sourcePaths = []) {
  const normalizedKeys = new Set(sourcePaths.map(sourcePathKey).filter(Boolean));
  const rows = store.db.prepare(`
    SELECT docs.id, docs.title, docs.meta, docs.created_at, docs.updated_at, source_documents.original_path
    FROM docs
    LEFT JOIN source_documents ON source_documents.doc_id = docs.id
  `).all();
  return rows
    .filter((row) => docSourcePathKeys(row).some((key) => normalizedKeys.has(key)))
    .sort(sortExistingDocs)[0] || null;
}

function throwDuplicateImportError(existingDoc) {
  if (!existingDoc) return;
  throw new Error(`导入失败：该真实文本路径已对应数据库文档 doc ${existingDoc.id}「${existingDoc.title || ''}」。如需重新导入，请先删除旧数据库文档。`);
}

function importRecordSentenceIndexes(record, fallbackIndex, hasExplicitIndex) {
  if (Array.isArray(record?.indexes)) {
    return record.indexes
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
  }
  if (record?.index != null) {
    const index = Number(record.index);
    return Number.isFinite(index) && index > 0 ? [index] : [];
  }
  return hasExplicitIndex ? [] : [fallbackIndex];
}

function cleanupFailedImport(store, docId) {
  if (!docId) return;
  try {
    store.deleteDoc(docId);
  } catch {
    // Best-effort rollback; preserve the original import error.
  }
  // 失败回滚只删文档；导入时不建向量（向量由 host 返回后统一 reconcile），无向量可清。
}

export async function importFilePathsToStore(options = {}) {
  const {
    store,
    filePaths = [],
    mode,
    chunkSize,
    overlap,
    sendProgress = () => {},
    refreshDoc = null
  } = options;
  if (!store?.db) throw new Error('importFilePathsToStore requires an initialized store');

  const imported = [];
  const total = filePaths.length;
  for (const [fileIndex, filePath] of filePaths.entries()) {
    const filename = parse(filePath).base;
    sendProgress({ label: `读取文件${total > 1 ? ` ${fileIndex + 1}/${total}` : ''}：${filename}`, step: 0, total: 0 });

    throwDuplicateImportError(findExistingImportedDocForSourcePaths(store, [filePath]));

    let doc = null;
    try {
      const routedImport = await importRecordsForFile(filePath, { mode: normalizeImportMode(mode), chunkSize, overlap });
      const structured = routedImport.structured;
      const records = routedImport.records;
      const sourceDocument = routedImport.sourceDocument;
      const direct = routedImport.direct === true;

      if (records.length === 0) continue;
      const title = parse(filePath).name.replace(/_sentences(_with_vectors|_structured)?$/i, '');

      sendProgress({ label: '构建文档结构...', step: 0, total: 0 });
      if (direct) {
        doc = store.createDoc({
          title,
          rootText: records[0]?.text || title,
          meta: JSON.stringify({ sourcePath: filePath, importedAt: new Date().toISOString(), direct: true })
        });
        doc = { ...doc, importedNodeIds: [doc.rootNodeId], importedNodeIdsByRecordIndex: { 1: doc.rootNodeId } };
      } else if (structured) {
        doc = store.createDocFromStructuredRecords({ title, sourcePath: filePath, records: structured });
      } else {
        doc = store.createDocFromSentenceRecords({ title, sourcePath: filePath, records });
      }

      if (sourceDocument) {
        const nodeIdsBySentenceIndex = new Map();
        if (direct) {
          for (const span of sourceDocument.spans || []) {
            const sentenceIndex = Number(span.sentence_index ?? span.sentenceIndex ?? span.index);
            if (Number.isFinite(sentenceIndex) && sentenceIndex > 0) {
              nodeIdsBySentenceIndex.set(sentenceIndex, doc.rootNodeId);
            }
          }
        } else {
          const sourceRecords = structured || records;
          const hasExplicitIndex = sourceRecords.some((record) => record.index != null || Array.isArray(record.indexes));
          for (const [index, record] of sourceRecords.entries()) {
            for (const sentenceIndex of importRecordSentenceIndexes(record, index + 1, hasExplicitIndex)) {
              const nodeId = doc.importedNodeIdsByRecordIndex?.[sentenceIndex] || doc.importedNodeIds[index];
              if (nodeId) nodeIdsBySentenceIndex.set(sentenceIndex, nodeId);
            }
          }
        }
        store.saveSourceDocument({
          docId: doc.id,
          sourcePath: sourceDocument.sourcePath,
          sourceType: sourceDocument.sourceType,
          rawMarkdown: sourceDocument.rawMarkdown || sourceDocument.rawText || '',
          spans: sourceDocument.spans,
          pdfPages: sourceDocument.pdfPages || [],
          pdfChars: sourceDocument.pdfChars || [],
          docBlocks: sourceDocument.docBlocks || [],
          nodeIdsBySentenceIndex
        });
      }

      // 派生索引（BM25/向量）不在导入落库时建：本函数只解析+落库+存源文档，返回后由 host 对每篇
      // 文档调派生索引模块的统一维护入口（与流式导入 bulkEnd 收尾同一口径）。
      const entry = typeof refreshDoc === 'function' ? refreshDoc(doc.id) : { docId: doc.id, title };
      if (routedImport.degraded?.from === 'simple') {
        entry.degraded = routedImport.degraded;
        entry.notice = `simple 模式未识别到可用目录结构（${routedImport.degraded.reason}），已按整篇单节点导入；要按标题切分请补全标题层级或改用其它 mode。`;
      }
      imported.push(entry);
    } catch (error) {
      cleanupFailedImport(store, doc?.id);
      throw error;
    }
  }
  sendProgress({ done: true });
  return imported;
}

// 已导入库文档的生命周期编排（从 headless-agent-host 闭包下沉，解耦第 1c 步）：把「导入一个 library
// 文件成文档 / 删一篇已导入文档 / 库文件移动后批量重写源路径绑定」从 host 收口到导入域。落库仍直接走
// store 的整篇建库能力（导入是后端内部编排、不走 mutation-api 信封；删走 database.write 信封复用现成
// doc.delete 动作）。派生索引维护沿用「落库后对每篇文档调统一维护入口」的口径，与流式导入 bulkEnd 收尾一致。
// 等价搬迁、保持 in-process。依赖注入：
//   · getStore() —— 主库 store 实例；runWrite(payload) —— database.write 信封（删文档用）；
//   · maintainDerivedAfterWrite(docId, opts) —— 派生索引维护；refreshDoc(docId, opts) —— 刷新文档视图；
//   · notifyLibraryChanged() —— 通知前端 library 变化；libraryPath(rel) —— library 相对路径转绝对；
//   · treeSliceDepth —— 导入回执的树切片深度。
// 智能导入任务 prompt（projectneed 4-3-2-1 导入流程入口）：发给内置 agent 的一次性任务指令。
// agent 在 full 档下按 smart-import skill 自主跑——观察源文、写一次性切割脚本、产节点树 JSON、
// 经 db import-json 校验后原子入库（不走影子分支审批；入库前的脚本/修整副本是 agent 在工作区的过程
// 产物，不进我们的版本管理）。正文逐字节切片由 skill 纪律 + 校验器逐字节比对双重保证。
// 源文用绝对路径：agent 跑 db import-json 时按后端进程 cwd 解析，相对路径会落到项目根而非 library。
function buildSmartImportPromptText(relativePath, absolutePath) {
  const rel = String(relativePath || '').trim();
  const abs = String(absolutePath || '').trim();
  return [
    `执行「智能导入」：把 library 文件 \`${rel}\` 整理成条件树文档并入库。源文件绝对路径：${abs}`,
    '',
    '先读 skill 文档 `.iftree-llm-workspace/skills/smart-import/SKILL.md`，严格照它的工作流做。要点：',
    '1. 读源文件开头 / 中间 / 结尾样本，识别它特有的章节与段落结构（章节标题特征、编号体系、段落分隔）。',
    '2. 在 `.iftree-llm-workspace` 工作区写一个一次性 node 切割脚本，扫全文产出与 db push 同契约的节点树 JSON——',
    '   只切到「章节 → 段落」两层：章节标题作 text 节点、其下每个自然段作一个子 text 节点。不要切到句子（句子层由系统补），也不要只切到章节那么粗。',
    '   正文 text 必须是源文的逐字节切片——你只贡献结构、不得改写/润色/纠正任何正文字符；自己起的章节名只写进 nodeTitle、绝不混进 text。',
    '   JSON 顶层加 `"splitSentences": true`：入库后系统会用句末标点正则把每个段落自动细切成句子子节点，你不用自己切句子。',
    '   不用写 address：只用 children 嵌套表达层级（章节节点的 children 放它的段落），连续地址由系统按 children 前序自动生成，你不用算地址。',
    `3. 跑脚本产出 tree.json，校验：\`db import-json <工作区>/tree.json "${abs}" --dry-run\`。读报告只按 missing / out_of_order 修脚本（正文逐字节 + 前序顺序），直到 ok:true；地址、gap、句子层都由系统处理、你不用管。`,
    `4. 校验通过后去掉 --dry-run 正式入库（需要建向量则加 --embed）：\`db import-json <工作区>/tree.json "${abs}"\`。`,
    '5. 入库后向用户简述：识别出的结构层级、节点数、有无 gap。',
    '',
    '约束：所有真实 shell 命令（跑脚本等）的工作目录必须留在 library 或 .iftree-llm-workspace 内，不要触碰这两个目录之外的文件。',
    '若源文无法直接切割（乱序文本层 / OCR 噪声 / XML 残渣），先在工作区生成修整副本，再对副本走整套流程（见 skill）。'
  ].join('\n');
}

export function createLibraryDocumentService(deps = {}) {
  const {
    getStore,
    runWrite,
    maintainDerivedAfterWrite,
    refreshDoc,
    notifyLibraryChanged,
    libraryPath,
    treeSliceDepth = 1
  } = deps;

  function importedDocSummary(item = {}, fallbackSourcePath = '') {
    const doc = item.doc || item.created || item;
    const meta = parseDocMetaJson(doc?.meta);
    return {
      docId: normalizeStableId(doc?.id ?? item.docId, null),
      title: doc?.title || item.title || '',
      sourcePath: meta.sourcePath || fallbackSourcePath,
      nodeCount: Number(doc?.node_count ?? doc?.nodeCount ?? item.nodeCount) || 0
    };
  }

  async function importLibraryDocument(payload = {}) {
    const relativePath = normalizeLibraryRelativePath(
      payload.relativePath ?? payload.relative_path ?? payload.path ?? payload.libraryPath
    );
    if (!relativePath) throw new Error('import_library_document requires relativePath');
    // vectors 是 stream.push 的内联向量口径、不是 import 的开关——传成 vectors 先于导入报错（fail-fast），
    // 别让人以为同步建了向量、实则静默不建。导入时同步建向量用 embed:true。
    if (payload.vectors !== undefined) {
      throw new Error('import 不接受 vectors 参数；导入时同步建向量请用 embed:true（vectors 是 stream.push 的内联向量口径）。');
    }
    const filePath = libraryPath(relativePath);
    if (!statSync(filePath).isFile()) throw new Error('import_library_document 只能导入 library 内真实文件');
    const imported = await importFilePathsToStore({
      store: getStore(),
      filePaths: [filePath],
      mode: payload.mode,
      chunkSize: payload.chunkSize,
      overlap: payload.overlap,
      refreshDoc: (docId) => refreshDoc(docId, {
        maxTreeDepth: treeSliceDepth,
        includeNodes: false,
        includeSourceSpans: false,
        includeSourceDocumentContent: false
      })
    });
    notifyLibraryChanged();
    const docs = imported.map((item) => importedDocSummary(item, filePath));
    // 文件导入直接落库、不走流式：落库后对每篇文档调派生索引模块的统一维护入口——BM25 整篇重建，
    // embed:true 当场全量建向量、否则失活留显式补（vectors 动词 / completeness 闸）。与流式导入
    // bulkEnd 收尾同一口径。这与「向量式导入」（mode:'vector' 按字数切块）正交：怎么切归 mode，
    // 建不建 embedding 归 embed 开关（vectors 参数在入口已被拒，见上）。
    // 建向量与切分方式正交：所有 mode（含向量式导入）默认不建 embedding、留 embed:true 手动触发
    //（4-6-1「文档导入时不得自动执行 embedding」）。向量式导入只管按字数切块，不因名字带「向量」就默认建。
    const wantVectors = payload.embed === true;
    let vectorWarning = null;
    for (const doc of docs) {
      if (!doc?.docId) continue;
      try {
        await maintainDerivedAfterWrite(doc.docId, { embed: wantVectors });
      } catch (error) {
        // 派生索引可重建、SQL 已落库 → 不让导入失败；显式建向量时把错误冒泡成 warning。
        if (wantVectors) vectorWarning = error?.message || String(error);
      }
    }
    return {
      ok: true,
      action: 'import.libraryDocument',
      relativePath,
      imported: docs,
      docId: docs[0]?.docId ?? null,
      title: docs[0]?.title || '',
      nodeCount: docs[0]?.nodeCount || 0,
      ...(vectorWarning ? { vectorWarning } : {})
    };
  }

  // 智能导入只产「发给 agent 的任务」、不在后端落库：由前端以 full 档发起 agent 会话，agent 自主跑
  // skill 工作流（观察 / 写脚本 / 校验 / 入库），过程在 AgentPanel 可监控。这里只做定位 + 构造 prompt。
  function smartImportTask(payload = {}) {
    const relativePath = normalizeLibraryRelativePath(
      payload.relativePath ?? payload.relative_path ?? payload.path ?? payload.libraryPath
    );
    if (!relativePath) throw new Error('smart import requires relativePath');
    const filePath = libraryPath(relativePath);
    if (!statSync(filePath).isFile()) throw new Error('智能导入只能导入 library 内真实文件');
    return {
      ok: true,
      action: 'import.smartTask',
      relativePath,
      mode: 'full',
      prompt: buildSmartImportPromptText(relativePath, filePath)
    };
  }

  async function deleteImportedDocument(payload = {}) {
    const docId = normalizeStableId(payload.docId ?? payload.doc_id, null);
    if (!docId) throw new Error('delete_library_document requires docId');
    const existing = getStore().listDocs().find((doc) => sameStableId(doc.id, docId)) || null;
    const result = await runWrite({ action: 'doc.delete', docId });
    notifyLibraryChanged();
    return {
      ok: result?.ok !== false,
      action: 'import.deleteDocument',
      docId,
      changed: Boolean(result?.changed),
      title: existing?.title || '',
      nodeCount: Number(existing?.node_count) || 0
    };
  }

  function updateImportedSourcePaths(fromPath, toPath, isDirectory) {
    const db = getStore().db;
    const docs = db.prepare('SELECT id, meta FROM docs').all();
    const updateDoc = db.prepare('UPDATE docs SET meta = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    for (const doc of docs) {
      const meta = parseDocMetaJson(doc.meta);
      if (!meta.sourcePath) continue;
      const matched = isDirectory ? isSameOrChildPath(meta.sourcePath, fromPath) : pathKey(meta.sourcePath) === pathKey(fromPath);
      if (!matched) continue;
      updateDoc.run(JSON.stringify({
        ...meta,
        sourcePath: replacePathPrefix(meta.sourcePath, fromPath, toPath)
      }), doc.id);
    }
    const sourceDocs = db.prepare('SELECT doc_id, original_path FROM source_documents WHERE original_path IS NOT NULL').all();
    const updateSourceDoc = db.prepare('UPDATE source_documents SET original_path = ? WHERE doc_id = ?');
    for (const row of sourceDocs) {
      const matched = isDirectory ? isSameOrChildPath(row.original_path, fromPath) : pathKey(row.original_path) === pathKey(fromPath);
      if (matched) updateSourceDoc.run(replacePathPrefix(row.original_path, fromPath, toPath), row.doc_id);
    }
  }

  return { importLibraryDocument, smartImportTask, deleteImportedDocument, updateImportedSourcePaths };
}
