const Joi = require("joi");
const { OUTLETS, PLATFORMS, PERIOD_TYPES } = require("../../config/constant");

const month = Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/).messages({ "string.pattern.base": '"month" must be YYYY-MM' });

const upload = Joi.object({
  platform: Joi.string().valid(...PLATFORMS),
  outletId: Joi.string().valid(...OUTLETS),
  month,
  periodType: Joi.string().valid(...PERIOD_TYPES),
  weekLabel: Joi.string().trim().max(100),
  replace: Joi.boolean().default(false),
});

const list = Joi.object({
  month,
  fromMonth: month,
  toMonth: month,
  outletId: Joi.string().valid(...OUTLETS),
  platform: Joi.string().valid(...PLATFORMS),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(500).default(200),
});

const listBatches = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
});

const reconciliation = Joi.object({
  month: month.required(),
  outletId: Joi.string().valid(...OUTLETS, "consolidated").default("consolidated"),
});

const idParam = Joi.object({ id: Joi.string().trim().min(1).max(80).required() });

module.exports = { upload, list, listBatches, reconciliation, idParam };
