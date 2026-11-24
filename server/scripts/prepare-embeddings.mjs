import { embedTexts, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '../src/utils/embeddings.js';

// Cache and exercise the actual ONNX graph during the build, before serving users.
try {
  const [vector] = await embedTexts(['DevMind embedding model check.']);
  const norm = Math.hypot(...vector);
  if (Math.abs(norm - 1) > 0.001) {
    throw new Error('The embedding model did not return a normalized vector');
  }
  console.log(`Verified ${EMBEDDING_MODEL}: ${EMBEDDING_DIMENSIONS}-dimensional embeddings. Model files are cached.`);
} catch (error) {
  console.error('Embedding model preparation failed:', error.message);
  process.exitCode = 1;
}
