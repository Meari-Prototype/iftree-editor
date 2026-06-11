import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import * as lancedb from '@lancedb/lancedb';

import {
  MIN_VECTOR_DIMENSIONS,
  VECTOR_MODEL_OPTIONS
} from '../src/vector/embeddings.mjs';
import { VectorStore } from '../src/vector/vector-store.mjs';

/** @returns {number[]} */
function vector(dimensions = MIN_VECTOR_DIMENSIONS, hotIndex = 0) {
  return Array.from({ length: dimensions }, (_, index) => (index === hotIndex ? 1 : 0));
}

async function withVectorStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-vectors-'));
  const dbPath = join(dir, 'nodes.lance');
  const store = new VectorStore(dbPath);
  try {
    await store.init();
    await fn(store, dbPath);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('VectorStore persists node vectors in a LanceDB table', async () => {
  await withVectorStore(async (store, dbPath) => {
    await store.upsertNodeVector({ nodeId: 1, docId: 10, text: 'alpha', vector: vector() });

    assert.equal(await store.hasNodeVector(1), true);
    const tableStat = await stat(join(dbPath, 'nodes_vec.lance'));
    assert.equal(tableStat.isDirectory(), true);
  });
});

test('VectorStore returns nearest vectors from LanceDB search', async () => {
  await withVectorStore(async (store) => {
    await store.upsertNodeVector({ nodeId: 1, docId: 10, text: 'alpha', vector: vector(MIN_VECTOR_DIMENSIONS, 0) });
    await store.upsertNodeVector({ nodeId: 2, docId: 10, text: 'beta', vector: vector(MIN_VECTOR_DIMENSIONS, 1) });

    const query = vector(MIN_VECTOR_DIMENSIONS, 0);
    query[1] = 0.1;
    const results = await store.search({ docId: 10, vector: query, limit: 1 });

    assert.equal(results.length, 1);
    assert.equal(results[0].node_id, '1');
    assert.equal(results[0].score > 0.5, true);
  });
});

test('VectorStore can delete all vectors for a document', async () => {
  await withVectorStore(async (store) => {
    await store.upsertNodeVector({ nodeId: 1, docId: 10, text: 'alpha', vector: vector(MIN_VECTOR_DIMENSIONS, 0) });
    await store.upsertNodeVector({ nodeId: 2, docId: 11, text: 'beta', vector: vector(MIN_VECTOR_DIMENSIONS, 1) });

    await store.deleteDoc(10);

    assert.equal(await store.hasNodeVector(1), false);
    assert.equal(await store.hasNodeVector(2), true);
  });
});

test('default embedding model is pinned to bge-m3', () => {
  const bgeM3 = VECTOR_MODEL_OPTIONS.find((option) => option.id === 'bge-m3');
  assert.equal(bgeM3.baseModelName, 'BAAI/bge-m3');
  assert.equal(bgeM3.modelName, 'Xenova/bge-m3');
  assert.equal(MIN_VECTOR_DIMENSIONS >= 1024, true);
});

test('VectorStore rejects vectors that do not match the configured dimension', async () => {
  await withVectorStore(async (store) => {
    await assert.rejects(
      () => store.upsertNodeVector({ nodeId: 1, docId: 10, text: 'short', vector: [1, 0, 0] }),
      /exactly 1024 dimensions/
    );
  });
});

test('VectorStore derives the LanceDB vector size from constructor options', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-customdim-vectors-'));
  const dbPath = join(dir, 'nodes.lance');
  const store = new VectorStore(dbPath, { dimensions: 1536 });
  try {
    await store.init();
    await store.upsertNodeVector({ nodeId: 1, docId: 10, text: 'alpha', vector: vector(1536, 0) });

    await assert.rejects(
      () => store.search({ docId: 10, vector: vector(1024, 0), limit: 1 }),
      /exactly 1536 dimensions/
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('VectorStore can batch upsert bge-m3 sized node vectors', async () => {
  await withVectorStore(async (store) => {
    await store.upsertNodeVectors([
      { nodeId: 1, docId: 10, text: 'alpha', vector: vector(MIN_VECTOR_DIMENSIONS, 0) },
      { nodeId: 2, docId: 10, text: 'beta', vector: vector(MIN_VECTOR_DIMENSIONS, 1) }
    ]);

    assert.equal(await store.hasNodeVector(1), true);
    assert.equal(await store.hasNodeVector(2), true);
  });
});

test('VectorStore drops existing LanceDB tables below the minimum vector dimension', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-lowdim-vectors-'));
  const dbPath = join(dir, 'nodes.lance');
  const connection = await lancedb.connect(dbPath);
  try {
    await connection.createTable('nodes_vec', [{ id: 99, doc_id: 10, text: 'old', vector: [1, 0, 0] }]);
    connection.close?.();

    const store = new VectorStore(dbPath);
    try {
      await store.init();
      assert.equal(await store.hasNodeVector(99), false);
      await store.upsertNodeVector({ nodeId: 1, docId: 10, text: 'alpha', vector: vector() });
      assert.equal(await store.hasNodeVector(1), true);
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
