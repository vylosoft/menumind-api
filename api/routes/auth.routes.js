const router = require("express").Router();
const ctrl = require("../controllers/auth.controller");
const v = require("../validations/auth.validation");
const validate = require("../../middleware/validate");
const auth = require("../../middleware/auth");
const asyncHandler = require("../../utils/asyncHandler");
const { authLimiter } = require("../../middleware/rateLimiter");

router.post("/login", authLimiter, validate(v.login), asyncHandler(ctrl.login));
router.post("/refresh", authLimiter, validate(v.refresh), asyncHandler(ctrl.refresh));
router.get("/me", auth, asyncHandler(ctrl.me));
router.post("/logout", auth, asyncHandler(ctrl.logout));

module.exports = router;
