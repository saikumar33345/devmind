import dotenv from 'dotenv';
import mongoose from 'mongoose';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ProjectFile from '../src/models/ProjectFile.js';
import StudyMaterial from '../src/models/StudyMaterial.js';
import { fileStorage, legacyFilePath } from '../src/utils/fileStorage.js';

// This helper always locates the legacy uploads folder relative to server/.
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
dotenv.config();
const flags = process.argv.slice(2);
const write = flags.includes('--write');

try {
  if (flags.some((flag) => !['--write', '--dry-run'].includes(flag)) || (write && flags.includes('--dry-run'))) {
    throw new Error('Usage: npm run migrate:uploads -- [--dry-run | --write]');
  }
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured');
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000, autoCreate: false, autoIndex: false
  });
  const summary = { alreadyStored: 0, localFiles: 0, bytes: 0, migrated: 0, missing: 0, failed: 0 };
  for (const [Model, kind] of [[ProjectFile, 'code'], [StudyMaterial, 'study']]) {
    for await (const file of Model.find().cursor()) {
      if (file.storageId) { summary.alreadyStored += 1; continue; }
      try {
        const stat = await fs.stat(legacyFilePath(file, kind));
        if (!stat.isFile()) throw new Error('The stored path is not a file');
        summary.localFiles += 1;
        summary.bytes += stat.size;
        if (write) {
          await fileStorage.migrateLocalFile(file, kind);
          summary.migrated += 1;
        }
      } catch (error) {
        if (error.code === 'ENOENT') summary.missing += 1;
        else summary.failed += 1;
        console.error(`${kind} record ${file._id}: ${error.code === 'ENOENT' ? 'local file is missing' : error.message}`);
      }
    }
  }
  console.log(write ? 'GridFS migration finished; copied files were read back and verified.' : 'Read-only upload migration preview; no file data or records were changed.');
  console.log(JSON.stringify(summary));
  console.log('Original local files were kept. Vector indexing is unchanged.');
  if (summary.missing || summary.failed) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  if (error.reason?.servers) {
    const codes = [...new Set([...error.reason.servers.values()]
      .map((server) => server.error?.cause?.code || server.error?.code || server.error?.name)
      .filter(Boolean))];
    if (codes.length) console.error(`Atlas connection detail: ${codes.join(', ')}`);
  }
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
