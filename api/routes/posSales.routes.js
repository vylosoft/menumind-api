const router = require("express").Router();
const ctrl = require("../controllers/posSales.controller");
const v = require("../validations/posSales.validation");
const validate = require("../../middleware/validate");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../utils/asyncHandler");
const { upload, requireFiles } = require("../../middleware/upload");
const { uploadLimiter } = require("../../middleware/rateLimiter");

router.use(auth);

router.post(
  "/upload",
  uploadLimiter,
  upload.array("files"),
  requireFiles,
  validate(v.upload, "body", ["layout", "mapping", "mappings", "outletOverrides", "period"]),
  asyncHandler(ctrl.upload)
);
router.get("/batches", validate(v.listBatches, "query"), asyncHandler(ctrl.listBatches));
router.delete("/batches/:id", validate(v.idParam, "params"), asyncHandler(ctrl.deleteBatch));
router.get("/records", validate(v.listRecords, "query"), asyncHandler(ctrl.listRecords));

module.exports = router;
