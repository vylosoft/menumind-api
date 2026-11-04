const AppError = require("../../utils/AppError");
const logger = require("../../utils/logger");
const { DB_INSERT_CHUNK } = require("../../config/constant");

const chunk = (arr, size = DB_INSERT_CHUNK) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const dbError = (context, error) => {
  logger.error(`DB error: ${context}`, { code: error?.code, message: error?.message, details: error?.details });
  return new AppError(`Database error while ${context}`, 500);
};

const paginate = (page, perPage) => {
  const from = (page - 1) * perPage;
  return { from, to: from + perPage - 1 };
};

const assertUniqueInRequest = (files) => {
  const seen = new Set();
  for (const f of files) {
    if (seen.has(f.hash)) throw new AppError(`"${f.originalname}" was included more than once in this upload`, 400);
    seen.add(f.hash);
  }
};

module.exports = { chunk, dbError, paginate, assertUniqueInRequest };
