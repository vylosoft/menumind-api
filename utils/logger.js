const env = require("../config/env");

const write = (level, msg, meta) => {
  const entry = { level, time: new Date().toISOString(), msg, ...(meta || {}) };
  const line = env.IS_PROD ? JSON.stringify(entry) : `[${entry.time}] ${level.toUpperCase()} ${msg}${meta ? " " + JSON.stringify(meta) : ""}`;
  (level === "error" ? console.error : console.log)(line);
};

module.exports = {
  info: (m, meta) => write("info", m, meta),
  warn: (m, meta) => write("warn", m, meta),
  error: (m, meta) => write("error", m, meta),
};
