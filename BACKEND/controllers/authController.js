const { findUserByEmail, createUser, updateUserPassword } = require("../config/db");

const resetCodes = new Map();

function buildUserPayload(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    handle: user.handle,
    initials: user.initials,
  };
}

function randomCode() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

function register(req, res) {
  const { name, email, password } = req.body || {};

  if (!name || !String(name).trim() || !email || !password) {
    return res.status(400).json({ error: "Name, email, and password are required." });
  }

  if (String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  if (findUserByEmail(normalizedEmail)) {
    return res.status(409).json({ error: "An account with that email already exists." });
  }

  const newUser = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name: String(name).trim(),
    email: normalizedEmail,
    password: String(password),
    handle: String(name).trim().toLowerCase().replace(/\s+/g, ".").replace(/[^a-z0-9.]/g, "") || "neighborly.user",
    initials: String(name).trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "U",
    createdAt: new Date().toISOString(),
  };

  createUser(newUser);
  return res.status(201).json({
    message: "User registered successfully.",
    user: buildUserPayload(newUser),
  });
}

function login(req, res) {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = findUserByEmail(normalizedEmail);

  if (!user || user.password !== String(password)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  return res.json({
    message: "Login successful.",
    user: buildUserPayload(user),
  });
}

function requestReset(req, res) {
  const { email } = req.body || {};

  if (!email) {
    return res.status(400).json({ error: "Email is required." });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = findUserByEmail(normalizedEmail);

  if (!user) {
    return res.status(404).json({ error: "No account was found for that email." });
  }

  const code = randomCode();
  resetCodes.set(normalizedEmail, { code, expiresAt: Date.now() + 10 * 60 * 1000 });

  return res.json({
    message: "Reset code sent.",
    code,
  });
}

function verifyReset(req, res) {
  const { email, code } = req.body || {};

  if (!email || !code) {
    return res.status(400).json({ error: "Email and code are required." });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const resetEntry = resetCodes.get(normalizedEmail);

  if (!resetEntry) {
    return res.status(400).json({ error: "No reset code was found for this email." });
  }

  if (Date.now() > resetEntry.expiresAt) {
    resetCodes.delete(normalizedEmail);
    return res.status(400).json({ error: "The reset code has expired." });
  }

  if (resetEntry.code !== String(code)) {
    return res.status(400).json({ error: "The reset code is invalid." });
  }

  return res.json({ message: "Code verified." });
}

function resetPassword(req, res) {
  const { email, code, password } = req.body || {};

  if (!email || !code || !password) {
    return res.status(400).json({ error: "Email, code, and new password are required." });
  }

  if (String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const resetEntry = resetCodes.get(normalizedEmail);

  if (!resetEntry || resetEntry.code !== String(code)) {
    return res.status(400).json({ error: "The reset code is invalid." });
  }

  if (Date.now() > resetEntry.expiresAt) {
    resetCodes.delete(normalizedEmail);
    return res.status(400).json({ error: "The reset code has expired." });
  }

  const user = updateUserPassword(normalizedEmail, String(password));
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  resetCodes.delete(normalizedEmail);
  return res.json({ message: "Password updated successfully." });
}

module.exports = {
  register,
  login,
  requestReset,
  verifyReset,
  resetPassword,
};
