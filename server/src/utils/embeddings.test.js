import { describe, expect, it, vi } from 'vitest';
import { createTextEmbedder } from './embeddings.js';

const vector = (value = 1) => [value, ...Array(383).fill(0)];
const output = (texts) => ({ tolist: () => texts.map((text) => vector(Number(text))) });
const fixture = () => {
  const model = vi.fn(async (texts) => output(texts));
  const loadPipeline = vi.fn(async () => model);
  return { model, loadPipeline, embed: createTextEmbedder({ loadPipeline }) };
};

describe('shared text embeddings', () => {
  it('reuses one model across concurrent upload and query requests without overlapping inference', async () => {
    const { model, loadPipeline, embed } = fixture();
    let active = 0;
    let peak = 0;
    model.mockImplementation(async (texts) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return output(texts);
    });

    const results = await Promise.all([embed(['1', '2']), embed(['3']), embed(['4'])]);

    expect(loadPipeline).toHaveBeenCalledTimes(1);
    expect(peak).toBe(1);
    expect(results.map((rows) => rows.map((row) => row[0]))).toEqual([[1, 2], [3], [4]]);
    expect(model).toHaveBeenCalledWith(['3'], { pooling: 'mean', normalize: true });
  });

  it('bounds inference batches while preserving every input and its order', async () => {
    const { model, embed } = fixture();
    const texts = Array.from({ length: 35 }, (_, index) => String(index));

    const vectors = await embed(texts);

    expect(vectors.map((row) => row[0])).toEqual(texts.map(Number));
    expect(model.mock.calls.every(([batch]) => batch.length <= 4)).toBe(true);
    expect(model.mock.calls.flatMap(([batch]) => batch)).toEqual(texts);
  });

  it('retries a failed initialization instead of caching a rejected promise', async () => {
    const { model, loadPipeline, embed } = fixture();
    loadPipeline.mockRejectedValueOnce(new Error('ModelProto does not have a graph'));

    await expect(embed(['1'])).rejects.toThrow('ModelProto does not have a graph');
    await expect(embed(['2'])).resolves.toEqual([vector(2)]);
    expect(loadPipeline).toHaveBeenCalledTimes(2);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it('continues after inference fails without reloading a working model', async () => {
    const { model, loadPipeline, embed } = fixture();
    model.mockRejectedValueOnce(new Error('inference failed'));

    const results = await Promise.allSettled([embed(['1']), embed(['2'])]);

    expect(results[0].status).toBe('rejected');
    expect(results[1]).toEqual({ status: 'fulfilled', value: [vector(2)] });
    expect(loadPipeline).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['wrong dimension', [[1, 2]]],
    ['non-finite value', [vector(NaN)]],
    ['missing vector', []]
  ])('rejects invalid model output: %s', async (_name, rows) => {
    const { model, embed } = fixture();
    model.mockResolvedValueOnce({ tolist: () => rows });

    await expect(embed(['1'])).rejects.toThrow('invalid vectors');
    await expect(embed(['2'])).resolves.toEqual([vector(2)]);
  });

  it('does not load a model for empty input', async () => {
    const { loadPipeline, embed } = fixture();
    await expect(embed([])).resolves.toEqual([]);
    expect(loadPipeline).not.toHaveBeenCalled();
  });
});
