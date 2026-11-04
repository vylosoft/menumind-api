const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const env = require("../config/env");
const routes = require("../api/routes");
const notFound = require("../middleware/notFound");
const errorHandler = require("../middleware/errorHandler");
const { apiLimiter } = require("../middleware/rateLimiter");

module.exports = ({ app }) => {
  if (env.TRUST_PROXY) app.set("trust proxy", env.TRUST_PROXY);
  app.disable("x-powered-by");

  app.use(helmet());
  app.use(compression());
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (env.CORS_ORIGINS.length === 0 && !env.IS_PROD) return cb(null, true);
        return cb(null, env.CORS_ORIGINS.includes(origin));
      },
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      maxAge: 86400,
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(require("../middleware/response"));

  app.get("/health", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

  app.use("/api", apiLimiter, routes);
  app.use(notFound);
  app.use(errorHandler);
};
