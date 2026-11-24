import { pipeline } from '@huggingface/transformers';

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSIONS = 384;
const BATCH_SIZE = 4;

export const createTextEmbedder = ({ loadPipeline = pipeline } = {}) => {
  let modelPromise;
  let pending = Promise.resolve();

  const getModel = () => {
    // Share initialization as well as the loaded session. Concurrent downloads can
    // otherwise read an ONNX cache file before another request finishes writing it.
    modelPromise ??= loadPipeline('feature-extraction', EMBEDDING_MODEL, {
      dtype: 'fp32',
      device: 'cpu',
      session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 }
    }).catch((error) => {
      modelPromise = undefined;
      throw error;
    });
    return modelPromise;
  };

  return (texts) => {
    if (texts.length === 0) return Promise.resolve([]);

    // Bound peak memory across uploads and parallel retrieval queries on small hosts.
    const task = pending.then(async () => {
      const model = await getModel();
      const vectors = [];
      for (let start = 0; start < texts.length; start += BATCH_SIZE) {
        const batch = texts.slice(start, start + BATCH_SIZE);
        const output = await model(batch, { pooling: 'mean', normalize: true });
        const rows = output.tolist();
        if (rows.length !== batch.length || rows.some((row) =>
          row.length !== EMBEDDING_DIMENSIONS || !row.every(Number.isFinite))) {
          throw new Error('The embedding model returned invalid vectors');
        }
        vectors.push(...rows);
      }
      return vectors;
    });
    // A failed request must not prevent later requests from using the queue.
    pending = task.then(() => undefined, () => undefined);
    return task;
  };
};

export const embedTexts = createTextEmbedder();
