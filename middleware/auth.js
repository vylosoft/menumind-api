const { supabaseAdmin } = require("../utils/supabaseClient");
const AppError = require("../utils/AppError");

// Verified tokens are cached so each request does not need a round trip to Supabase Auth.
const CACHE_TTL_MS = 60 * 1000;
const MAX_ENTRIES = 5000;
const cache = new Map(); // token -> { user, expiresAt }

const tokenExpiry = (token) => {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
};

module.exports = async (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) throw new AppError("Authentication required", 401);

    const now = Date.now();
    const hit = cache.get(token);
    if (hit && hit.expiresAt > now) {
      req.user = hit.user;
      req.accessToken = token;
      return next();
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      cache.delete(token);
      throw new AppError("Invalid or expired session", 401);
    }

    const user = { id: data.user.id, email: data.user.email };
    const jwtExp = tokenExpiry(token);
    const expiresAt = Math.min(now + CACHE_TTL_MS, jwtExp || now + CACHE_TTL_MS);
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(token, { user, expiresAt });

    req.user = user;
    req.accessToken = token;
    next();
  } catch (err) {
    next(err);
  }
};

/** Drops a token from the cache (used on logout). */
module.exports.forget = (token) => cache.delete(token);