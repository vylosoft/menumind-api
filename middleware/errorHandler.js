const multer = require("multer");
const logger = require("../utils/logger");

// eslint-disable-next-line no-unused-vars
module.exports = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({ success: false, error: true, message: err.message, code: err.code });
  }

  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ success: false, error: true, message: "Payload too large" });
  }

  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) {
    logger.error("Unhandled error", { path: req.originalUrl, method: req.method, err: err.message, stack: err.stack });
  }

  res.status(status).json({
    success: false,
    error: true,
    message: status >= 500 && !err.expose ? "Internal server error" : err.message,
    invalid: err.details,
  });
};
