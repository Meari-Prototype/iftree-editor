import { parse, resolve } from 'node:path';

import { importRecordsForFile } from '../core/import-formats/router.mjs';
import { normalizeImportMode } from '../core/import-formats/shared.mjs';
import { assertEmbeddingVector } from '../vector/embeddings.mjs';

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

function sourcePathKey(value) {
  const raw = String(value || '').trim();
  return raw ? pathKey(raw) : '';
}

function docSourcePathKeys(row) {
  const meta = parseDocMetaJson(row.meta);
  return [meta.sourcePath, row.original_path].map(sourcePathKey).filter(Boolean);
}

function sortExistingDocs(left, right) {
  return String(right.updated_at || '').localeCompare(String(left.updated_at || '')) || Number(right.id) - Number(left.id);
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

async function cleanupFailedImport(store, docId, vectorStore) {
  if (!docId) return;
  try {
    store.deleteDoc(docId);
  } catch {
    // Best-effort rollback; preserve the original import error.
  }
  try {
    await vectorStore?.deleteDoc?.(docId);
  } catch {
    // Best-effort vector cleanup; preserve the original import error.
  }
}

export async function importFilePathsToStore(options = {}) {
  const {
    store,
    filePaths = [],
    mode,
    sendProgress = () => {},
    refreshDoc = null,
    vector = null,
    keyword = null
  } = options;
  if (!store?.db) throw new Error('importFilePathsToStore requires an initialized store');

  const imported = [];
  const total = filePaths.length;
  for (const [fileIndex, filePath] of filePaths.entries()) {
    const filename = parse(filePath).base;
    sendProgress({ label: `读取文件${total > 1 ? ` ${fileIndex + 1}/${total}` : ''}：${filename}`, step: 0, total: 0 });

    throwDuplicateImportError(findExistingImportedDocForSourcePaths(store, [filePath]));

    let doc = null;
    let vectorStore = null;
    try {
      const routedImport = await importRecordsForFile(filePath, { mode: normalizeImportMode(mode) });
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
          nodeIdsBySentenceIndex
        });
      }

      if (vector?.enabled?.()) {
        vectorStore = await vector.getStore?.();
        const vectorConfig = vector.getConfig?.() || {};
        const srcRecords = structured || records;
        const nodeCount = srcRecords.length;
        const vectorRows = [];
        const recordsToEmbed = [];
        for (const [index, record] of srcRecords.entries()) {
          if (record.skipVector) continue;
          const sentenceIndex = importRecordSentenceIndexes(record, index + 1, false)[0] || index + 1;
          const nodeId = doc.importedNodeIdsByRecordIndex?.[sentenceIndex] || doc.importedNodeIds[index];
          if (!nodeId) continue;
          if (record.vector && record.vector.length > 0) {
            vectorRows.push({
              nodeId,
              docId: doc.id,
              text: record.text || '',
              vector: assertEmbeddingVector(record.vector, `imported vector for node ${nodeId}`, vectorConfig.dimensions)
            });
          } else {
            recordsToEmbed.push({ index, nodeId, text: record.text || '' });
          }
        }

        if (recordsToEmbed.length > 0 && vectorConfig.importVectors !== false) {
          const embeddings = await vector.embedTexts?.(
            recordsToEmbed.map((record) => record.text),
            { label: `生成 ${vectorConfig.label} 向量` }
          );
          for (const [index, record] of recordsToEmbed.entries()) {
            vectorRows.push({
              nodeId: record.nodeId,
              docId: doc.id,
              text: record.text,
              vector: embeddings[index]
            });
          }
        }
        if (vectorRows.length > 0 && vectorStore) {
          sendProgress({ label: '写入 LanceDB 向量库', step: nodeCount, total: nodeCount });
          await vectorStore.upsertNodeVectors(vectorRows, { deleteExisting: false });
        }
      }

      if (keyword?.rebuildDoc) {
        sendProgress({ label: '写入 LanceDB 关键词索引', step: 0, total: 0 });
        await keyword.rebuildDoc(doc.id);
      }

      imported.push(typeof refreshDoc === 'function' ? refreshDoc(doc.id) : { docId: doc.id, title });
    } catch (error) {
      await cleanupFailedImport(store, doc?.id, vectorStore);
      throw error;
    }
  }
  sendProgress({ done: true });
  return imported;
}
