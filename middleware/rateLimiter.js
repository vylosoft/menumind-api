const rateLimit = require("express-rate-limit");

const build = (windowMs, max, message) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) =>
      res.status(429).json({ success: false, error: true, message, retryAfter: Math.ceil(windowMs / 1000) }),
  });

const apiLimiter = build(60 * 1000, 120, "Too many requests, please try again later.");
const authLimiter = build(15 * 60 * 1000, 20, "Too many login attempts, please try again later.");
const uploadLimiter = build(60 * 1000, 15, "Too many uploads, please slow down.");

module.exports = { apiLimiter, authLimiter, uploadLimiter };
