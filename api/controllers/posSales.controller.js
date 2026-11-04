const posSalesService = require("../services/posSales.service");

const upload = async (req, res) => {
  const data = await posSalesService.uploadPosFiles(req.user.id, req.files, req.body);
  const inserted = data.batches.reduce((s, b) => s + b.insertedRows, 0);
  return res.success({
    status: 201,
    data,
    message: `Saved ${inserted} POS sales row(s) from ${data.batches.length} file(s)`,
  });
};

const listBatches = async (req, res) => {
  const data = await posSalesService.listBatches(req.user.id, req.validatedQuery);
  return res.success({ data });
};

const listRecords = async (req, res) => {
  const data = await posSalesService.listRecords(req.user.id, req.validatedQuery);
  return res.success({ data });
};

const deleteBatch = async (req, res) => {
  const data = await posSalesService.deleteBatch(req.user.id, req.params.id);
  return res.success({ data, message: "POS upload deleted" });
};

module.exports = { upload, listBatches, listRecords, deleteBatch };
