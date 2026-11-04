const router = require("express").Router();
const ctrl = require("../controllers/payouts.controller");
const v = require("../validations/payouts.validation");
const validate = require("../../middleware/validate");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../utils/asyncHandler");
const { upload, requireFiles } = require("../../middleware/upload");
const { uploadLimiter } = require("../../middleware/rateLimiter");

router.use(auth);

router.post("/upload", uploadLimiter, upload.array("files"), requireFiles, validate(v.upload), asyncHandler(ctrl.upload));
router.get("/", validate(v.list, "query"), asyncHandler(ctrl.list));
router.get("/batches", validate(v.listBatches, "query"), asyncHandler(ctrl.listBatches));
router.delete("/batches/:id", validate(v.idParam, "params"), asyncHandler(ctrl.deleteBatch));
router.get("/reconciliation", validate(v.reconciliation, "query"), asyncHandler(ctrl.reconciliation));

module.exports = router;
