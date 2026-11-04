const { createClient } = require("@supabase/supabase-js");
const env = require("../config/env");

const baseOpts = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

// Privileged client: server-side DB writes only. Never expose.
const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, baseOpts);

// Factory for auth operations (sign-in / refresh) – fresh instance per call, no shared session state.
const createAuthClient = () => createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, baseOpts);

module.exports = { supabaseAdmin, createAuthClient };
