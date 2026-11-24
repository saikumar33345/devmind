import multer from 'multer';
import path from 'path';
import { ALLOWED_MATERIAL_EXTENSIONS } from '../utils/documentParser.js';

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_MATERIAL_EXTENSIONS.has(ext)) {
    return cb(new Error(`File type ${ext || '(none)'} is not allowed. Use PDF, DOCX, TXT, or MD.`));
  }
  cb(null, true);
};

export const studyUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 } // 10MB per file
});
