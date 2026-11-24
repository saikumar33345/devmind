import * as chroma from './chroma.js';
import { getQdrantStore } from './qdrant.js';

// Configuring either Qdrant variable selects Qdrant. Incomplete credentials must
// fail explicitly rather than silently writing new data to the local Chroma DB.
const usesQdrant = () => Boolean(process.env.QDRANT_URL || process.env.QDRANT_API_KEY);
export const studyCollectionName = (id) => `study_${id}`;
export const codeCollectionName = (id) => `code_${id}`;

const qdrant = {
  addChunks: (id, ...args) => getQdrantStore().addChunks(studyCollectionName(id), ...args, 'materialId'),
  addStructuredChunks: (id, ...args) => getQdrantStore().addStructuredChunks(studyCollectionName(id), ...args, 'materialId'),
  deleteMaterialChunks: (id, docId) => getQdrantStore().deleteDocChunks(studyCollectionName(id), docId, 'materialId'),
  deleteStudyPlanCollection: (id) => getQdrantStore().deleteNamespace(studyCollectionName(id)),
  queryChunks: (id, ...args) => getQdrantStore().queryCollection(studyCollectionName(id), ...args),
  addCodeChunks: (id, ...args) => getQdrantStore().addChunks(codeCollectionName(id), ...args, 'fileId'),
  addStructuredCodeChunks: (id, ...args) => getQdrantStore().addStructuredChunks(codeCollectionName(id), ...args, 'fileId'),
  deleteCodeFileChunks: (id, docId) => getQdrantStore().deleteDocChunks(codeCollectionName(id), docId, 'fileId'),
  deleteProjectCodeCollection: (id) => getQdrantStore().deleteNamespace(codeCollectionName(id)),
  queryCodeChunks: (id, ...args) => getQdrantStore().queryCollection(codeCollectionName(id), ...args),
  getAllChunksIn: (...args) => getQdrantStore().getAllDocs(...args),
  queryDenseWithEmbeddings: (...args) => getQdrantStore().queryWithEmbeddings(...args)
};

const call = (method, args) => (usesQdrant() ? qdrant : chroma)[method](...args);
export const addChunks = (...args) => call('addChunks', args);
export const addStructuredChunks = (...args) => call('addStructuredChunks', args);
export const deleteMaterialChunks = (...args) => call('deleteMaterialChunks', args);
export const deleteStudyPlanCollection = (...args) => call('deleteStudyPlanCollection', args);
export const queryChunks = (...args) => call('queryChunks', args);
export const addCodeChunks = (...args) => call('addCodeChunks', args);
export const addStructuredCodeChunks = (...args) => call('addStructuredCodeChunks', args);
export const deleteCodeFileChunks = (...args) => call('deleteCodeFileChunks', args);
export const deleteProjectCodeCollection = (...args) => call('deleteProjectCodeCollection', args);
export const queryCodeChunks = (...args) => call('queryCodeChunks', args);
export const getAllChunksIn = (...args) => call('getAllChunksIn', args);
export const queryDenseWithEmbeddings = (...args) => call('queryDenseWithEmbeddings', args);
