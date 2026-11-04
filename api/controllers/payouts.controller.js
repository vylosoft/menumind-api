const payoutsService = require("../services/payouts.service");
const reconciliationService = require("../services/reconciliation.service");

const upload = async (req, res) => {
  const data = await payoutsService.uploadPayoutFiles(req.user.id, req.files, req.body);
  return res.success({
    status: 201,
    data,
    message: `Saved ${data.summary.recordCount} payout statement(s) from ${data.files.length} file(s)`,
  });
};

const list = async (req, res) => {
  const data = await payoutsService.listPayouts(req.user.id, req.validatedQuery);
  return res.success({ data });
};

const listBatches = async (req, res) => {
  const data = await payoutsService.listBatches(req.user.id, req.validatedQuery);
  return res.success({ data });
};

const deleteBatch = async (req, res) => {
  const data = await payoutsService.deleteBatch(req.user.id, req.params.id);
  return res.success({ data, message: "Payout upload deleted" });
};

const reconciliation = async (req, res) => {
  const data = await reconciliationService.matchRevenue(req.user.id, req.validatedQuery);
  return res.success({ data });
};

module.exports = { upload, list, listBatches, deleteBatch, reconciliation };
