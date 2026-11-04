const Joi = require("joi");

const login = Joi.object({
  email: Joi.string().trim().lowercase().email().max(254).required(),
  password: Joi.string().min(6).max(128).required(),
});

const refresh = Joi.object({
  refreshToken: Joi.string().trim().min(10).max(2048).required(),
});

module.exports = { login, refresh };
