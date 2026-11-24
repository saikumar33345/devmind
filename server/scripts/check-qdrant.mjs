import 'dotenv/config';
import { getQdrantStore } from '../src/utils/qdrant.js';

try {
  const result = await getQdrantStore().checkConnection();
  console.log(`Connected to Qdrant. ${result.collections.length} collection(s) available.`);
  console.log('No data was created or changed.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
