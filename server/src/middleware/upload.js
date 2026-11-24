import multer from 'multer';
import path from 'path';

const ALLOWED_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.json', '.md', '.txt',
  '.py', '.cpp', '.c', '.h', '.java', '.go', '.rs', '.rb', '.php',
  '.html', '.css', '.scss', '.yml', '.yaml', '.env.example', '.sql'
]);

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return cb(new Error(`File type ${ext || '(none)'} is not allowed`));
  }
  cb(null, true);
};

export const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 1024 * 1024, files: 1 } // 1MB per file
});
