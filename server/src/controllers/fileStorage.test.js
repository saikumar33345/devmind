import { afterEach, describe, expect, it, vi } from 'vitest';
import Project from '../models/Project.js';
import ProjectFile from '../models/ProjectFile.js';
import StudyPlan from '../models/StudyPlan.js';
import StudyMaterial from '../models/StudyMaterial.js';
import Checkpoint from '../models/Checkpoint.js';
import RagParentChunk from '../models/RagParentChunk.js';
import { fileStorage } from '../utils/fileStorage.js';
import { uploadFile, applyFileEdit, restoreCheckpoint, getFilesContext } from './fileController.js';
import { uploadMaterial, deleteStudyPlan } from './studyPlanController.js';
import { deleteProject } from './projectController.js';
import { addCodeChunks, addStructuredChunks } from '../utils/vectorStore.js';

vi.mock('../utils/fileStorage.js', () => ({ fileStorage: {
  saveUpload: vi.fn(), discardBlob: vi.fn(), readFile: vi.fn(), replaceFile: vi.fn(), deleteFile: vi.fn()
} }));
vi.mock('../utils/vectorStore.js', () => ({
  addCodeChunks: vi.fn(), deleteCodeFileChunks: vi.fn(), queryCodeChunks: vi.fn(),
  deleteProjectCodeCollection: vi.fn(), deleteMaterialChunks: vi.fn(), deleteStudyPlanCollection: vi.fn(),
  queryChunks: vi.fn(), addStructuredChunks: vi.fn(), studyCollectionName: (id) => `study_${id}`
}));
vi.mock('./notificationController.js', () => ({ notify: vi.fn() }));
vi.mock('./resultsController.js', () => ({ invalidateResultsCache: vi.fn() }));
vi.mock('../utils/cache.js', () => ({ cached: vi.fn(), cacheDelByPrefix: vi.fn() }));

const response = () => {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
};
const request = () => ({
  params: { id: 'plan-a', projectId: 'project-a' }, user: { _id: 'owner' }, body: {},
  file: { originalname: 'notes.txt', mimetype: 'text/plain', size: 23, buffer: Buffer.from('A database stores data.') }
});
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

describe('GridFS controller integration', () => {
  it('saves code upload bytes and their GridFS reference before indexing', async () => {
    const req = request();
    const res = response();
    vi.spyOn(Project, 'findOne').mockResolvedValue({ _id: 'project-a' });
    const blob = { storedName: 'stored.txt', storageId: 'blob-id' };
    fileStorage.saveUpload.mockResolvedValue(blob);
    vi.spyOn(ProjectFile, 'create').mockImplementation(async (data) => ({ _id: 'file-a', ...data }));
    await uploadFile(req, res);
    expect(ProjectFile.create).toHaveBeenCalledWith(expect.objectContaining(blob));
    expect(fileStorage.saveUpload).toHaveBeenCalledWith(req.file, { user: 'owner', project: 'project-a' });
    expect(addCodeChunks).toHaveBeenCalledWith('project-a', 'file-a', 'notes.txt', expect.arrayContaining(['A database stores data.']));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('rejects unauthorized project/study uploads before creating stored blobs', async () => {
    vi.spyOn(Project, 'findOne').mockResolvedValue(null);
    vi.spyOn(StudyPlan, 'findOne').mockResolvedValue(null);
    const res = response();
    await uploadFile(request(), res);
    await uploadMaterial(request(), res);
    expect(fileStorage.saveUpload).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('cleans up the blob if creating its application record fails', async () => {
    vi.spyOn(Project, 'findOne').mockResolvedValue({ _id: 'project-a' });
    fileStorage.saveUpload.mockResolvedValue({ storedName: 'stored.txt', storageId: 'blob-id' });
    fileStorage.discardBlob.mockResolvedValue();
    vi.spyOn(ProjectFile, 'create').mockRejectedValue(new Error('record save failed'));
    await expect(uploadFile(request(), response())).rejects.toThrow('record save failed');
    expect(fileStorage.discardBlob).toHaveBeenCalledWith('blob-id');
    expect(addCodeChunks).not.toHaveBeenCalled();
  });

  it('parses study upload bytes and marks the material ready after indexing', async () => {
    vi.spyOn(StudyPlan, 'findOne').mockResolvedValue({ _id: 'plan-a' });
    fileStorage.saveUpload.mockResolvedValue({ storedName: 'stored.txt', storageId: 'blob-id' });
    const material = { _id: 'material-a', save: vi.fn() };
    vi.spyOn(StudyMaterial, 'create').mockResolvedValue(material);
    vi.spyOn(RagParentChunk, 'insertMany').mockResolvedValue([]);
    const res = response();
    await uploadMaterial(request(), res);
    expect(StudyMaterial.create).toHaveBeenCalledWith(expect.objectContaining({ storageId: 'blob-id' }));
    expect(addStructuredChunks).toHaveBeenCalledWith('plan-a', 'material-a', 'notes.txt', expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('database stores data') })
    ]));
    expect(material.status).toBe('ready');
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('reads project chat context from persistent storage', async () => {
    const file = { storedName: 'stored.js', storageId: 'blob-id', originalName: 'app.js' };
    vi.spyOn(ProjectFile, 'find').mockReturnValue({ sort: vi.fn().mockResolvedValue([file]) });
    fileStorage.readFile.mockResolvedValue(Buffer.from('const persisted = true;'));
    expect(await getFilesContext('project-a')).toContain('const persisted = true;');
    expect(fileStorage.readFile).toHaveBeenCalledWith(file);
  });

  it('keeps checkpoints and uses persistent replacement for edits and restores', async () => {
    const file = { _id: 'file-a', project: 'project-a', storageId: 'blob-id', originalName: 'app.js' };
    vi.spyOn(ProjectFile, 'findOne').mockResolvedValue(file);
    vi.spyOn(Checkpoint, 'create').mockResolvedValue({});
    vi.spyOn(Checkpoint, 'findOne').mockResolvedValue({ content: 'restored content' });
    fileStorage.readFile.mockResolvedValue(Buffer.from('old content'));
    const req = request();
    req.body.newContent = 'new content';
    await applyFileEdit(req, response());
    await restoreCheckpoint(req, response());
    expect(Checkpoint.create).toHaveBeenCalledWith(expect.objectContaining({ content: 'old content' }));
    expect(fileStorage.replaceFile).toHaveBeenNthCalledWith(1, file, 'new content');
    expect(fileStorage.replaceFile).toHaveBeenNthCalledWith(2, file, 'restored content');
  });

  it('keeps the parent project/plan available for retry if blob deletion fails', async () => {
    const parent = { _id: 'parent', deleteOne: vi.fn() };
    vi.spyOn(Project, 'findOne').mockResolvedValue(parent);
    vi.spyOn(StudyPlan, 'findOne').mockResolvedValue(parent);
    vi.spyOn(ProjectFile, 'find').mockResolvedValue([{ storageId: 'code-blob' }]);
    vi.spyOn(StudyMaterial, 'find').mockResolvedValue([{ storageId: 'study-blob' }]);
    fileStorage.deleteFile.mockRejectedValue(new Error('storage unavailable'));
    await expect(deleteProject(request(), response())).rejects.toThrow('storage unavailable');
    await expect(deleteStudyPlan(request(), response())).rejects.toThrow('storage unavailable');
    expect(parent.deleteOne).not.toHaveBeenCalled();
  });
});
