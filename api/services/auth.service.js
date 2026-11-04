const { createAuthClient, supabaseAdmin } = require("../../utils/supabaseClient");
const AppError = require("../../utils/AppError");
const logger = require("../../utils/logger");
const env = require("../../config/env");

const toSession = (session, user) => ({
  accessToken: session.access_token,
  refreshToken: session.refresh_token,
  expiresAt: session.expires_at,
  expiresIn: session.expires_in,
  user: {
    id: user.id,
    email: user.email,
    name: user.user_metadata?.full_name || user.user_metadata?.name || null,
  },
});

const login = async ({ email, password }) => {
  const client = createAuthClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data?.session) {
    logger.warn("Login rejected by Supabase", { email, status: error?.status, code: error?.code, reason: error?.message });
    if (error?.code === "email_not_confirmed") throw new AppError("Email not confirmed. Confirm the user in Supabase.", 401);
    if (!env.IS_PROD && error && error.code !== "invalid_credentials") {
      throw new AppError(`Login failed: ${error.message}`, error.status || 401);
    }
    throw new AppError("Invalid email or password", 401);
  }
  return toSession(data.session, data.user);
};

const refresh = async ({ refreshToken }) => {
  const client = createAuthClient();
  const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data?.session) throw new AppError("Session expired, please sign in again", 401);
  return toSession(data.session, data.user);
};

const logout = async (accessToken) => {
  const { error } = await supabaseAdmin.auth.admin.signOut(accessToken, "local");
  if (error && error.status !== 401 && error.status !== 403) throw new AppError("Logout failed", 500);
};

module.exports = { login, refresh, logout };
