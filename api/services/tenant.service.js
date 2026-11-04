const { supabaseAdmin } = require("../../utils/supabaseClient");
const AppError = require("../../utils/AppError");
const env = require("../../config/env");

const cache = new Map(); // userId -> { restaurantId, outlets, expires }
const TTL_MS = 5 * 60 * 1000;

/**
 * Resolves the restaurant a user works on:
 *  1. MENUMIND_RESTAURANT_ID env (single-tenant deployments)
 *  2. restaurant_users membership
 *  3. the only restaurant in the project
 */
const resolveTenant = async (userId) => {
  const hit = cache.get(userId);
  if (hit && hit.expires > Date.now()) return hit;

  let restaurantId = env.MENUMIND_RESTAURANT_ID || null;

  if (!restaurantId) {
    const { data: memberships, error } = await supabaseAdmin
      .from("restaurant_users")
      .select("restaurant_id")
      .eq("user_id", userId);
    if (error) throw new AppError("Could not resolve restaurant for user", 500);
    if (memberships.length === 1) restaurantId = memberships[0].restaurant_id;
    else if (memberships.length > 1) throw new AppError("User belongs to multiple restaurants; set MENUMIND_RESTAURANT_ID", 409);
  }

  if (!restaurantId) {
    const { data: restaurants, error } = await supabaseAdmin.from("restaurants").select("id").eq("is_active", true).limit(2);
    if (error) throw new AppError("Could not resolve restaurant", 500);
    if (restaurants.length !== 1) throw new AppError("No restaurant is linked to this user", 403);
    restaurantId = restaurants[0].id;
  }

  const { data: outlets, error: oErr } = await supabaseAdmin
    .from("restaurant_outlets")
    .select("id, code, name")
    .eq("restaurant_id", restaurantId);
  if (oErr) throw new AppError("Could not load outlets", 500);

  const tenant = { restaurantId, outlets: outlets.map((o) => o.id), expires: Date.now() + TTL_MS };
  cache.set(userId, tenant);
  return tenant;
};

module.exports = { resolveTenant };
