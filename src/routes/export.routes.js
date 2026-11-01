const router = require("express").Router();
const ctrl = require("../controllers/export.controller");

router.get("/pdf", ctrl.pdf);
router.post("/pdf", ctrl.pdf);
router.get("/:username.pdf", ctrl.pdf);

module.exports = router;
