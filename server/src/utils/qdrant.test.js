import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQdrantStore } from './qdrant.js';
import * as qdrantModule from './qdrant.js';
import * as vectorStore from './vectorStore.js';

const vector = () => [1, ...Array(383).fill(0)];
const collectionInfo = () => ({
  config: { params: { vectors: { size: 384, distance: 'Cosine' } } },
  payload_schema: Object.fromEntries(['namespace', 'metadata.materialId', 'metadata.fileId'].map((key) => [key, { data_type: 'keyword' }]))
});
const reply = (result, status = 200) => new Response(JSON.stringify({ result, status: 'ok' }), { status });

// REST-contract fixture: keeps points and applies payload filters to exercise
// uploads, retrieval, pagination and deletion together without real credentials.
const fixture = ({ exists = true, info = collectionInfo(), failFirstGet = false } = {}) => {
  const points = new Map();
  const calls = [];
  let reads = 0;
  const matches = (point, filter) => filter.must.every(({ key, match }) =>
    key.split('.').reduce((obj, part) => obj?.[part], point.payload) === match.value);
  const fetchImpl = vi.fn(async (url, options) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method: options.method, body });
    if (options.method === 'GET' && path === '/collections') return reply({ collections: [] });
    if (options.method === 'GET') {
      reads += 1;
      if (failFirstGet && reads === 1) return reply(null, 503);
      return exists ? reply(info) : reply(null, 404);
    }
    if (path.endsWith('/index')) return reply(true);
    if (path.endsWith('/points/delete')) {
      for (const [id, point] of points) if (matches(point, body.filter)) points.delete(id);
      return reply({ status: 'completed' });
    }
    if (path.endsWith('/points/query')) {
      const hits = [...points.values()].filter((point) => matches(point, body.filter)).slice(0, body.limit);
      return reply({ points: hits.map((point) => ({ ...point, score: 0.8 })) });
    }
    if (path.endsWith('/points/scroll')) {
      const hits = [...points.values()].filter((point) => matches(point, body.filter));
      const start = body.offset === undefined ? 0 : Number(body.offset);
      return reply({ points: hits.slice(start, start + 1), next_page_offset: start + 1 < hits.length ? start + 1 : null });
    }
    if (path.endsWith('/points') && options.method === 'PUT') {
      for (const point of body.points) points.set(point.id, point);
      return reply({ status: 'completed' });
    }
    if (options.method === 'PUT') { exists = true; return reply(true); }
    throw new Error(`Unexpected fixture request: ${options.method} ${path}`);
  });
  const embed = vi.fn(async (texts) => texts.map(vector));
  const store = createQdrantStore({ url: 'https://example.qdrant.io:6333', apiKey: 'test-key', fetchImpl, embed });
  return { store, points, calls, embed };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Qdrant vector storage', () => {
  it('routes the application helpers through Qdrant for study and code uploads, search and cleanup', async () => {
    const { store } = fixture();
    vi.spyOn(qdrantModule, 'getQdrantStore').mockReturnValue(store);
    vi.stubEnv('QDRANT_URL', 'https://example.qdrant.io');
    vi.stubEnv('QDRANT_API_KEY', 'test-key');
    await vectorStore.addChunks('a', 'doc', 'notes.md', ['study text']);
    await vectorStore.addStructuredChunks('b', 'doc', 'notes.md', [{ text: 'other study', parentId: 'parent' }]);
    await vectorStore.addCodeChunks('a', 'doc', 'app.js', ['code text']);
    await vectorStore.addStructuredCodeChunks('b', 'doc', 'app.js', [{ text: 'other code', parentId: 'parent' }]);
    expect((await vectorStore.queryChunks('a', 'study'))[0].metadata.materialId).toBe('doc');
    expect((await vectorStore.queryCodeChunks('a', 'code'))[0].metadata.fileId).toBe('doc');
    expect(await vectorStore.queryDenseWithEmbeddings(vectorStore.studyCollectionName('b'), 'query', 2)).toHaveLength(1);
    expect(await vectorStore.getAllChunksIn(vectorStore.codeCollectionName('b'))).toHaveLength(1);
    await vectorStore.deleteMaterialChunks('a', 'doc');
    await vectorStore.deleteCodeFileChunks('a', 'doc');
    await vectorStore.deleteStudyPlanCollection('b');
    await vectorStore.deleteProjectCodeCollection('b');
    expect(await vectorStore.queryChunks('a', 'study')).toEqual([]);
    expect(await vectorStore.queryCodeChunks('a', 'code')).toEqual([]);
    expect(await vectorStore.getAllChunksIn(vectorStore.studyCollectionName('b'))).toEqual([]);
    expect(await vectorStore.getAllChunksIn(vectorStore.codeCollectionName('b'))).toEqual([]);
  });

  it('isolates project/study results and preserves citations, MMR vectors and cosine scores', async () => {
    const { store } = fixture();
    await store.addStructuredChunks('study_a', 'doc', 'notes.md', [
      { text: 'Database transactions', parentId: 'doc_parent', heading: 'Transactions', section: 'ACID' }
    ], 'materialId');
    await store.addChunks('study_b', 'doc', 'private.md', ['Different student'], 'materialId');
    await store.addChunks('code_a', 'doc', 'app.js', ['Different project'], 'fileId');
    const hits = await store.queryWithEmbeddings('study_a', 'transactions');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 'doc_0', text: 'Database transactions', metadata: {
      materialId: 'doc', parentId: 'doc_parent', heading: 'Transactions', section: 'ACID'
    } });
    expect(hits[0].embedding).toEqual(vector());
    expect(1 - hits[0].distance).toBeCloseTo(0.8);
    expect(await store.queryCollection('code_a', 'code')).toEqual([
      { text: 'Different project', metadata: { fileId: 'doc', originalName: 'app.js', chunkIndex: 0 } }
    ]);
  });

  it('scrolls every page for BM25 and returns the same IDs as dense retrieval', async () => {
    const { store, calls } = fixture();
    await store.addChunks('study_a', 'doc', 'notes.md', ['first', 'second', 'third'], 'materialId');
    const docs = await store.getAllDocs('study_a');
    expect(docs.map((doc) => doc.text)).toEqual(['first', 'second', 'third']);
    expect(docs.map((doc) => doc.id)).toEqual((await store.queryWithEmbeddings('study_a', 'query')).map((doc) => doc.id));
    expect(calls.filter((call) => call.path.endsWith('/scroll'))).toHaveLength(3);
  });

  it('deletes only the requested document/namespace, never other projects or the shared collection', async () => {
    const { store, calls } = fixture();
    await store.addChunks('code_a', 'doc1', 'one.js', ['one'], 'fileId');
    await store.addChunks('code_a', 'doc2', 'two.js', ['two'], 'fileId');
    await store.addChunks('code_b', 'doc1', 'private.js', ['private'], 'fileId');
    await store.addChunks('study_a', 'doc1', 'notes.md', ['notes'], 'materialId');
    await store.deleteDocChunks('code_a', 'doc1', 'fileId');
    expect((await store.getAllDocs('code_a')).map((doc) => doc.text)).toEqual(['two']);
    await store.deleteNamespace('code_a');
    expect(await store.getAllDocs('code_a')).toEqual([]);
    expect(await store.getAllDocs('code_b')).toHaveLength(1);
    expect(await store.getAllDocs('study_a')).toHaveLength(1);
    await store.deleteDocChunks('study_a', 'doc1', 'materialId');
    expect(await store.getAllDocs('study_a')).toEqual([]);
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('uses stable UUIDs for idempotent retries without cross-namespace collisions', async () => {
    const { store, points } = fixture();
    await store.addChunks('code_a', 'doc', 'a.js', ['old'], 'fileId');
    const firstId = [...points.keys()][0];
    expect(firstId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await store.addChunks('code_a', 'doc', 'a.js', ['updated'], 'fileId');
    await store.addChunks('code_b', 'doc', 'a.js', ['other'], 'fileId');
    expect(points.size).toBe(2);
    expect(points.get(firstId).payload.text).toBe('updated');
  });

  it('initializes compatible collection and filter indexes once during concurrent reads', async () => {
    const info = collectionInfo();
    info.payload_schema = {};
    const { store, calls } = fixture({ exists: false, info });
    await Promise.all([store.getAllDocs('study_a'), store.getAllDocs('study_b')]);
    const creates = calls.filter((call) => call.method === 'PUT' && call.path === '/collections/devmind_chunks');
    expect(creates).toHaveLength(1);
    expect(creates[0].body.vectors).toMatchObject({ size: 384, distance: 'Cosine' });
    expect(calls.filter((call) => call.path.endsWith('/index')).map((call) => call.body.field_name))
      .toEqual(['namespace', 'metadata.materialId', 'metadata.fileId']);
  });

  it('recovers after transient initialization failures and reports auth failures without secrets', async () => {
    const { store } = fixture({ failFirstGet: true });
    await expect(store.getAllDocs('study_a')).rejects.toThrow('HTTP 503');
    expect(await store.getAllDocs('study_a')).toEqual([]);
    const denied = createQdrantStore({ url: 'https://example.qdrant.io', apiKey: 'do-not-print', fetchImpl: async () => reply(null, 401) });
    await expect(denied.getAllDocs('study_a')).rejects.toThrow('Qdrant request failed (HTTP 401)');
  });

  it('rejects incompatible vector dimensions without writing data', async () => {
    const info = collectionInfo();
    info.config.params.vectors.size = 768;
    const { store, calls } = fixture({ info });
    await expect(store.addChunks('study_a', 'doc', 'a.md', ['text'], 'materialId')).rejects.toThrow('384-dimensional Cosine');
    expect(calls.some((call) => call.path.endsWith('/points'))).toBe(false);
  });

  it('accepts a collection created concurrently by another process', async () => {
    let reads = 0;
    const fetchImpl = vi.fn(async (_url, options) => {
      if (options.method === 'PUT') return reply(null, 409);
      reads += 1;
      return reads === 1 ? reply(null, 404) : reply(collectionInfo());
    });
    const store = createQdrantStore({ url: 'https://example.qdrant.io', apiKey: 'test-key', fetchImpl });
    // A deletion request is not needed to initialize; an empty scroll is.
    fetchImpl.mockImplementationOnce(async () => reply(null, 404))
      .mockImplementationOnce(async () => reply(null, 409))
      .mockImplementationOnce(async () => reply(collectionInfo()))
      .mockImplementationOnce(async () => reply({ points: [], next_page_offset: null }));
    expect(await store.getAllDocs('study_a')).toEqual([]);
  });

  it('checks connectivity without creating data or embedding text', async () => {
    const { store, calls, embed } = fixture({ exists: false });
    expect(await store.checkConnection()).toEqual({ collections: [] });
    expect(calls).toEqual([{ method: 'GET', path: '/collections', body: undefined }]);
    expect(embed).not.toHaveBeenCalled();
  });

  it('fails explicitly with incomplete credentials instead of falling back to local Chroma', () => {
    vi.stubEnv('QDRANT_URL', 'https://example.qdrant.io');
    vi.stubEnv('QDRANT_API_KEY', '');
    expect(() => vectorStore.queryChunks('study_a', 'question')).toThrow('Set both QDRANT_URL and QDRANT_API_KEY');
  });

  it('refuses unscoped reads and deletes before contacting the database', async () => {
    const { store, calls } = fixture();
    await expect(store.getAllDocs('')).rejects.toThrow('namespace');
    await expect(store.deleteNamespace('')).rejects.toThrow('namespace');
    expect(calls).toHaveLength(0);
  });
});
