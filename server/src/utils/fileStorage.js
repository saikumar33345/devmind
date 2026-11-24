import mongoose from 'mongoose';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

let bucket;
let bucketDb;
const getBucket = () => {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB must be connected before accessing uploaded files');
  if (db !== bucketDb) {
    bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: 'devmind_uploads' });
    bucketDb = db;
  }
  return bucket;
};

export const legacyFilePath = (file, kind = 'code') => {
  if (!['code', 'study'].includes(kind)) throw new Error('Unknown upload kind');
  const name = file.storedName;
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
    throw new Error('Invalid stored filename');
  }
  return path.join(process.cwd(), 'uploads', ...(kind === 'study' ? ['study'] : []), name);
};

export const createFileStorage = ({ bucketProvider = getBucket, filesystem = fs, onCleanupError = console.error } = {}) => {
  const discardBlob = async (id) => {
    try {
      await bucketProvider().delete(id);
    } catch (error) {
      // An already removed blob is harmless; connection/permission errors are not.
      if (error.name !== 'MongoRuntimeError' || !error.message.startsWith('File not found for id ')) throw error;
    }
  };

  const writeBuffer = async (storedName, data, metadata) => {
    const stream = bucketProvider().openUploadStream(storedName, { metadata });
    try {
      await pipeline(Readable.from([data]), stream);
    } catch (error) {
      // Remove partially uploaded chunks as well as failed file metadata.
      await stream.abort().catch(() => {});
      await discardBlob(stream.id).catch((cleanupError) => onCleanupError('Partial upload cleanup failed:', cleanupError.message));
      throw error;
    }
    return { storedName, storageId: stream.id };
  };

  const readBlob = async (id) => {
    const chunks = [];
    for await (const chunk of bucketProvider().openDownloadStream(id)) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };

  const saveUpload = (upload, metadata = {}) => {
    if (!Buffer.isBuffer(upload.buffer)) throw new Error('Uploaded file content is missing');
    const storedName = `${randomUUID()}${path.extname(upload.originalname).toLowerCase()}`;
    return writeBuffer(storedName, upload.buffer, {
      ...metadata, originalName: upload.originalname, mimeType: upload.mimetype
    });
  };

  const readFile = (file, kind = 'code') => file.storageId
    ? readBlob(file.storageId)
    : filesystem.readFile(legacyFilePath(file, kind));

  const replaceFile = async (file, content, { verify = false } = {}) => {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const previousId = file.storageId;
    const previousSize = file.size;
    const blob = await writeBuffer(file.storedName, data, {
      originalName: file.originalName, mimeType: file.mimeType, user: String(file.user)
    });
    try {
      if (verify && !(await readBlob(blob.storageId)).equals(data)) throw new Error('Uploaded file verification failed');
      file.storageId = blob.storageId;
      file.size = data.length;
      await file.save();
    } catch (error) {
      file.storageId = previousId;
      file.size = previousSize;
      await discardBlob(blob.storageId).catch((cleanupError) => onCleanupError('Upload rollback cleanup failed:', cleanupError.message));
      throw error;
    }
    // Metadata now points to the new complete blob; only then remove the old one.
    if (previousId) {
      await discardBlob(previousId).catch((error) => onCleanupError('Old upload cleanup failed:', error.message));
    }
    // A legacy disk copy is kept during migration and never used once storageId is set.
  };

  const deleteFile = async (file, kind = 'code') => {
    if (file.storageId) await discardBlob(file.storageId);
    // Also remove a retained migration copy when the user deletes the file itself.
    try {
      await filesystem.unlink(legacyFilePath(file, kind));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };

  const migrateLocalFile = async (file, kind = 'code') => {
    if (file.storageId) return false;
    const data = await filesystem.readFile(legacyFilePath(file, kind));
    await replaceFile(file, data, { verify: true });
    return true;
  };

  return { saveUpload, readFile, replaceFile, deleteFile, discardBlob, migrateLocalFile };
};

export const fileStorage = createFileStorage();
