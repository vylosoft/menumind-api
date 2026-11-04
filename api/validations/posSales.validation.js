const Joi = require("joi");
const { OUTLETS, POS_LAYOUT_PRESETS } = require("../../config/constant");

const columnName = Joi.string().trim().max(200);

const mappingSchema = Joi.object({
  itemName: columnName,
  variantName: columnName.allow(""),
  quantity: columnName,
  revenue: columnName,
  date: columnName.allow(""),
  category: columnName.allow(""),
  orderType: columnName.allow(""),
  salesChannel: columnName.allow(""),
  discount: columnName.allow(""),
  returns: columnName.allow(""),
  outlet: columnName.allow(""),
});

const layoutSchema = Joi.object({
  headerRow: Joi.number().integer().min(1).max(500).required(),
  dataStartRow: Joi.number().integer().min(2).max(1000).required(),
  sheetIndex: Joi.number().integer().min(0).max(50).default(0),
  skipFooterRows: Joi.number().integer().min(0).max(100).default(0),
});

const upload = Joi.object({
  presetId: Joi.string().trim().max(100),
  layout: layoutSchema,
  // Either one mapping for every file, or { "<fileName>": mapping }
  mapping: mappingSchema,
  mappings: Joi.object().pattern(Joi.string().max(255), mappingSchema),
  outletOverrides: Joi.object().pattern(Joi.string().max(300), Joi.string().valid(...OUTLETS)).max(5000),
  defaultOutlet: Joi.string().valid(...OUTLETS),
  posSystem: Joi.string().trim().lowercase().max(50).default("petpooja"),
  uploadType: Joi.string().valid("outlet", "highest_selling"),
  replace: Joi.boolean().default(false),
  period: Joi.object({ from: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(), to: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required() }),
}).custom((v, helpers) => {
  if (v.presetId && !v.layout && !POS_LAYOUT_PRESETS[v.presetId]) {
    return helpers.message(`"layout" is required for preset "${v.presetId}"`);
  }
  return v;
});

const listRecords = Joi.object({
  from: Joi.date().iso(),
  to: Joi.date().iso(),
  outlet: Joi.string().valid(...OUTLETS),
  channel: Joi.string().valid("swiggy", "zomato", "ownly", "direct"),
  batchId: Joi.string().guid(),
  includeReturns: Joi.boolean().default(false),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(5000).default(1000),
});

const listBatches = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
});

const idParam = Joi.object({ id: Joi.string().guid().required() });

module.exports = { upload, listRecords, listBatches, idParam };
