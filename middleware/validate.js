const AppError = require("../utils/AppError");

/**
 * Validates req[source] against a Joi schema and replaces it with the sanitized value.
 * Multipart text fields that carry JSON are parsed before validation.
 */
module.exports = (schema, source = "body", jsonFields = []) => (req, res, next) => {
  const input = { ...(req[source] || {}) };

  for (const f of jsonFields) {
    if (typeof input[f] === "string" && input[f].trim()) {
      try {
        input[f] = JSON.parse(input[f]);
      } catch {
        return next(new AppError(`Field "${f}" must be valid JSON`, 400));
      }
    }
  }

  const { value, error } = schema.validate(input, { abortEarly: false, stripUnknown: true, convert: true });
  if (error) {
    const invalid = error.details.map((d) => ({ field: d.path.join("."), message: d.message }));
    return next(new AppError("Validation failed", 422, invalid));
  }

  if (source === "query") {
    req.validatedQuery = value; // Express 5: req.query is a getter
  } else {
    req[source] = value;
  }
  next();
};
