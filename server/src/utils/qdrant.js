import { createHash } from 'node:crypto';
import { DefaultEmbeddingFunction } from '@chroma-core/default-embed';

const VECTOR_SIZE = 384; // Xenova/all-MiniLM-L6-v2, the existing Chroma embedding model.
let embeddingFunction;
const embedLocally = (texts) => {
  embeddingFunction ??= new DefaultEmbeddingFunction();
  return embeddingFunction.generate(texts);
};

// One physical collection avoids an HNSW index per project on a small free cluster.
// Every operation is scoped by the logical project/study collection in its payload.
const scopeFilter = (namespace, extra = []) => {
  if (!namespace) throw new Error('A vector namespace is required');
  return { must: [{ key: 'namespace', match: { value: namespace } }, ...extra] };
};

const pointId = (namespace, chunkId) => {
  const bytes = createHash('sha256').update(JSON.stringify([namespace, chunkId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const createQdrantStore = ({
  url, apiKey, collectionName = 'devmind_chunks', embed = embedLocally, fetchImpl = globalThis.fetch
}) => {
  if (!url || !apiKey) throw new Error('Set both QDRANT_URL and QDRANT_API_KEY in server/.env or the hosting environment');
  const endpoint = new URL(url);
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('QDRANT_URL must be the cluster base URL, without credentials, a dashboard path, or a query string');
  }
  const baseUrl = endpoint.origin;
  const collectionPath = `/collections/${encodeURIComponent(collectionName)}`;
  let readyPromise;

  const request = async (method, path, body) => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
      redirect: 'error'
    });
    if (!response.ok) {
      // Do not include credentials, URLs, document bodies, or raw provider errors.
      const error = new Error(`Qdrant request failed (HTTP ${response.status})`);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    return data.result;
  };

  const initialize = async () => {
    let info;
    try {
      info = await request('GET', collectionPath);
    } catch (error) {
      if (error.status !== 404) throw error;
      try {
        await request('PUT', collectionPath, {
          vectors: { size: VECTOR_SIZE, distance: 'Cosine', on_disk: true },
          on_disk_payload: true
        });
      } catch (createError) {
        // Another request/process may have created the collection in the meantime.
        if (createError.status !== 409) throw createError;
      }
      info = await request('GET', collectionPath);
    }
    const vectors = info?.config?.params?.vectors;
    if (vectors?.size !== VECTOR_SIZE || vectors?.distance !== 'Cosine') {
      throw new Error('The Qdrant collection must use one unnamed 384-dimensional Cosine vector; choose a new QDRANT_COLLECTION or reindex into a compatible collection');
    }
    for (const field of ['namespace', 'metadata.materialId', 'metadata.fileId']) {
      if (info.payload_schema?.[field]?.data_type !== 'keyword') {
        await request('PUT', `${collectionPath}/index?wait=true`, { field_name: field, field_schema: 'keyword' });
      }
    }
  };

  const ensureReady = () => {
    readyPromise ??= initialize().catch((error) => {
      readyPromise = undefined;
      throw error;
    });
    return readyPromise;
  };

  const writeChunks = async (namespace, docId, originalName, children, metaKey) => {
    if (children.length === 0) return;
    scopeFilter(namespace);
    await ensureReady();
    // Bound local embedding work and request sizes for large study documents.
    for (let start = 0; start < children.length; start += 32) {
      const batch = children.slice(start, start + 32);
      const embeddings = await embed(batch.map((child) => child.text));
      if (embeddings.length !== batch.length || embeddings.some((vector) => vector.length !== VECTOR_SIZE || !vector.every(Number.isFinite))) {
        throw new Error('The embedding model must return one 384-dimensional vector per chunk');
      }
      await request('PUT', `${collectionPath}/points?wait=true`, {
        points: batch.map((child, index) => {
          const chunkIndex = start + index;
          const chunkId = `${docId}_${chunkIndex}`;
          return {
            id: pointId(namespace, chunkId),
            vector: embeddings[index],
            payload: {
              namespace, chunkId, text: child.text,
              metadata: {
                [metaKey]: String(docId), originalName, chunkIndex,
                ...(child.parentId === undefined ? {} : {
                  parentId: child.parentId, heading: child.heading || '', section: child.section || ''
                })
              }
            }
          };
        })
      });
    }
  };

  const getAllDocs = async (namespace) => {
    const filter = scopeFilter(namespace);
    await ensureReady();
    const docs = [];
    let offset;
    do {
      const page = await request('POST', `${collectionPath}/points/scroll`, {
        filter, limit: 256, with_payload: true, with_vector: false,
        ...(offset === undefined ? {} : { offset })
      });
      docs.push(...page.points.map(({ payload }) => ({ id: payload.chunkId, text: payload.text, metadata: payload.metadata })));
      offset = page.next_page_offset;
    } while (offset !== null && offset !== undefined);
    return docs;
  };

  const queryWithEmbeddings = async (namespace, queryText, nResults = 8) => {
    const filter = scopeFilter(namespace);
    if (!Number.isInteger(nResults) || nResults < 1) return [];
    await ensureReady();
    const [queryVector] = await embed([queryText]);
    if (queryVector?.length !== VECTOR_SIZE || !queryVector.every(Number.isFinite)) {
      throw new Error('The query embedding must contain 384 finite numbers');
    }
    const result = await request('POST', `${collectionPath}/points/query`, {
      query: queryVector, filter, limit: nResults, with_payload: true, with_vector: true
    });
    return result.points.map((point) => ({
      id: point.payload.chunkId,
      text: point.payload.text,
      metadata: point.payload.metadata,
      embedding: point.vector,
      // The existing hybrid retriever expects cosine distance, not similarity.
      distance: 1 - point.score
    }));
  };

  const deleteMatching = async (namespace, extra) => {
    const filter = scopeFilter(namespace, extra);
    await ensureReady();
    await request('POST', `${collectionPath}/points/delete?wait=true`, { filter });
  };

  return {
    // Connection verification is read-only and doesn't initialize a collection.
    checkConnection: () => request('GET', '/collections'),
    addChunks: (namespace, docId, originalName, chunks, metaKey) =>
      writeChunks(namespace, docId, originalName, chunks.map((text) => ({ text })), metaKey),
    addStructuredChunks: writeChunks,
    getAllDocs,
    queryWithEmbeddings,
    queryCollection: async (...args) => (await queryWithEmbeddings(...args)).map(({ text, metadata }) => ({ text, metadata })),
    deleteDocChunks: (namespace, docId, metaKey) =>
      deleteMatching(namespace, [{ key: `metadata.${metaKey}`, match: { value: String(docId) } }]),
    // Never drop the shared physical collection when a project/plan is deleted.
    deleteNamespace: (namespace) => deleteMatching(namespace, [])
  };
};

let store;
export const getQdrantStore = () => {
  store ??= createQdrantStore({
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY,
    collectionName: process.env.QDRANT_COLLECTION || 'devmind_chunks'
  });
  return store;
};
