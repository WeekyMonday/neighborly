const express = require("express");
const { register, login, requestReset, verifyReset, resetPassword } = require("../controllers/authController");

const router = express.Router();

router.post("/register", register);
router.post("/login", login);
router.post("/reset-request", requestReset);
router.post("/reset-verify", verifyReset);
router.post("/reset-password", resetPassword);

module.exports = router;
