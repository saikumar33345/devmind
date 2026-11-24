import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createFileStorage, legacyFilePath } from './fileStorage.js';

const fixture = () => {
  const blobs = new Map();
  const local = new Map();
  let nextId = 1;
  const missing = () => Object.assign(new Error('missing file'), { code: 'ENOENT' });
  const bucket = {
    failUpload: false,
    corruptReads: false,
    openUploadStream: vi.fn((filename, { metadata }) => {
      const parts = [];
      const stream = new Writable({
        write(chunk, _encoding, done) {
          if (bucket.failUpload) return done(new Error('storage quota exceeded'));
          parts.push(Buffer.from(chunk));
          done();
        },
        final(done) { blobs.set(stream.id, { filename, metadata, content: Buffer.concat(parts) }); done(); }
      });
      stream.id = `blob-${nextId++}`;
      stream.abort = vi.fn(async () => blobs.delete(stream.id));
      return stream;
    }),
    openDownloadStream: vi.fn((id) => {
      if (!blobs.has(id)) return Readable.from((async function* () { throw new Error('GridFS file missing'); })());
      return Readable.from([bucket.corruptReads ? Buffer.from('corrupt') : blobs.get(id).content]);
    }),
    delete: vi.fn(async (id) => {
      if (!blobs.delete(id)) throw Object.assign(new Error(`File not found for id ${id}`), { name: 'MongoRuntimeError' });
    })
  };
  const filesystem = {
    readFile: vi.fn(async (name) => { if (!local.has(name)) throw missing(); return local.get(name); }),
    unlink: vi.fn(async (name) => { if (!local.delete(name)) throw missing(); })
  };
  const options = { bucketProvider: () => bucket, filesystem, onCleanupError: vi.fn() };
  return { storage: createFileStorage(options), options, bucket, blobs, local, filesystem };
};

const upload = (content = Buffer.from('const answer = 42;')) => ({
  originalname: 'app.js', mimetype: 'text/javascript', buffer: content
});

describe('persistent uploaded files', () => {
  it('preserves bytes across a new storage instance without reading the local disk', async () => {
    const { storage, options, filesystem, blobs } = fixture();
    const bytes = Buffer.from([0, 255, 1, 10, 128]);
    const file = await storage.saveUpload(upload(bytes), { user: 'owner', project: 'project-a' });
    const afterRestart = createFileStorage(options);
    expect(await afterRestart.readFile(file)).toEqual(bytes);
    expect(filesystem.readFile).not.toHaveBeenCalled();
    expect(blobs.get(file.storageId).metadata).toMatchObject({ user: 'owner', project: 'project-a', originalName: 'app.js' });
  });

  it('keeps the previous version until the new blob and metadata are saved', async () => {
    const { storage, blobs } = fixture();
    const file = { ...await storage.saveUpload(upload()), size: 18, user: 'owner' };
    const previousId = file.storageId;
    file.save = vi.fn(async () => {
      expect(blobs.has(previousId)).toBe(true);
      expect(blobs.get(file.storageId).content.toString()).toBe('updated');
    });
    await storage.replaceFile(file, 'updated');
    expect(file.size).toBe(7);
    expect(blobs.has(previousId)).toBe(false);
    expect(await storage.readFile(file)).toEqual(Buffer.from('updated'));
  });

  it('rolls back a failed metadata save and preserves the last readable version', async () => {
    const { storage, blobs } = fixture();
    const file = { ...await storage.saveUpload(upload(Buffer.from('old'))), size: 3, user: 'owner' };
    const previousId = file.storageId;
    file.save = vi.fn().mockRejectedValue(new Error('database unavailable'));
    await expect(storage.replaceFile(file, 'new version')).rejects.toThrow('database unavailable');
    expect(file.storageId).toBe(previousId);
    expect(file.size).toBe(3);
    expect(blobs.size).toBe(1);
    expect((await storage.readFile(file)).toString()).toBe('old');
  });

  it('aborts failed uploads and leaves existing content untouched', async () => {
    const { storage, bucket, blobs } = fixture();
    const file = { ...await storage.saveUpload(upload()), size: 18, save: vi.fn() };
    bucket.failUpload = true;
    await expect(storage.replaceFile(file, 'new')).rejects.toThrow('storage quota exceeded');
    expect(file.save).not.toHaveBeenCalled();
    expect(bucket.openUploadStream.mock.results.at(-1).value.abort).toHaveBeenCalledOnce();
    expect(blobs.size).toBe(1);
  });

  it('migrates legacy study files with a verified copy while retaining local originals', async () => {
    const { storage, local, filesystem, blobs } = fixture();
    const file = { storedName: 'legacy.pdf', storageId: null, size: 3, save: vi.fn() };
    local.set(legacyFilePath(file, 'study'), Buffer.from('pdf bytes'));
    expect(await storage.migrateLocalFile(file, 'study')).toBe(true);
    expect((await storage.readFile(file, 'study')).toString()).toBe('pdf bytes');
    expect(file.save).toHaveBeenCalledOnce();
    expect(filesystem.unlink).not.toHaveBeenCalled();
    expect(local.size).toBe(1);
    expect(await storage.migrateLocalFile(file, 'study')).toBe(false);
    expect(blobs.size).toBe(1);
  });

  it('does not change a legacy record if verification fails', async () => {
    const { storage, local, bucket, blobs } = fixture();
    const file = { storedName: 'legacy.txt', storageId: null, size: 3, save: vi.fn() };
    local.set(legacyFilePath(file), Buffer.from('old'));
    bucket.corruptReads = true;
    await expect(storage.migrateLocalFile(file)).rejects.toThrow('verification failed');
    expect(file.save).not.toHaveBeenCalled();
    expect(file.storageId).toBeNull();
    expect(blobs.size).toBe(0);
    expect(local.size).toBe(1);
  });

  it('deletes only the requested blob and migration copy, and tolerates repeated deletion', async () => {
    const { storage, local, blobs } = fixture();
    const one = await storage.saveUpload(upload(Buffer.from('one')));
    const two = await storage.saveUpload(upload(Buffer.from('two')));
    local.set(legacyFilePath(one), Buffer.from('retained copy'));
    await storage.deleteFile(one);
    await storage.deleteFile(one);
    expect(blobs.size).toBe(1);
    expect(await storage.readFile(two)).toEqual(Buffer.from('two'));
    expect(local.size).toBe(0);
  });

  it('propagates database deletion failures so records are retained for retry', async () => {
    const { storage, bucket, filesystem } = fixture();
    bucket.delete.mockRejectedValue(new Error('permission denied'));
    await expect(storage.deleteFile({ storageId: 'blob-id', storedName: 'app.js' })).rejects.toThrow('permission denied');
    expect(filesystem.unlink).not.toHaveBeenCalled();
  });

  it('reads legacy code content and rejects paths outside the upload folders', async () => {
    const { storage, local } = fixture();
    const file = { storedName: 'old.js' };
    local.set(legacyFilePath(file), Buffer.from('old code'));
    expect(await storage.readFile(file)).toEqual(Buffer.from('old code'));
    expect(() => legacyFilePath({ storedName: '../secret' })).toThrow('Invalid stored filename');
    expect(() => legacyFilePath({ storedName: '..\\secret' })).toThrow('Invalid stored filename');
  });
});
