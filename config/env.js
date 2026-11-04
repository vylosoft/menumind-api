require("dotenv").config();

const required = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}

const toInt = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

module.exports = {
  NODE_ENV: process.env.NODE_ENV || "development",
  IS_PROD: process.env.NODE_ENV === "production",
  PORT: toInt(process.env.PORT, 4000),
  CORS_ORIGINS: (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  MAX_UPLOAD_FILE_MB: toInt(process.env.MAX_UPLOAD_FILE_MB, 20),
  MAX_UPLOAD_FILES: toInt(process.env.MAX_UPLOAD_FILES, 10),
  TRUST_PROXY: toInt(process.env.TRUST_PROXY, 0),
  MENUMIND_RESTAURANT_ID: process.env.MENUMIND_RESTAURANT_ID || null,
};
