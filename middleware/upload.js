const path = require("path");
const multer = require("multer");
const env = require("../config/env");
const { ALLOWED_EXTENSIONS } = require("../config/constant");
const AppError = require("../utils/AppError");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.MAX_UPLOAD_FILE_MB * 1024 * 1024,
    files: env.MAX_UPLOAD_FILES,
    fields: 30,
    fieldSize: 256 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(new AppError(`Unsupported file type "${ext || "unknown"}". Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`, 415));
    }
    cb(null, true);
  },
});

const requireFiles = (req, res, next) => {
  if (!req.files || req.files.length === 0) {
    return next(new AppError("At least one file is required (field name: files)", 400));
  }
  next();
};

module.exports = { upload, requireFiles };
