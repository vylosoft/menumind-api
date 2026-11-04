const app = require("./app");
const env = require("./config/env");
const logger = require("./utils/logger");

const server = app.listen(env.PORT, () => {
  logger.info(`MenuMind API listening on port ${env.PORT}`, { env: env.NODE_ENV });
});

server.requestTimeout = 120000;
server.headersTimeout = 125000;

const shutdown = (signal) => {
  logger.info(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => logger.error("Unhandled rejection", { reason: String(reason) }));
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { err: err.message, stack: err.stack });
  process.exit(1);
});
