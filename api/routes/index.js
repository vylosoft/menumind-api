const router = require("express").Router();

router.use("/auth", require("./auth.routes"));
router.use("/pos-sales", require("./posSales.routes"));
router.use("/payouts", require("./payouts.routes"));

module.exports = router;
