const fs = require("fs");
const path = require("path");

const USERS_FILE = path.join(__dirname, "../data/users.json");

function ensureDb() {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2));
  }
}

function readUsers() {
  ensureDb();
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    return JSON.parse(raw || "[]");
  } catch (error) {
    return [];
  }
}

function writeUsers(users) {
  ensureDb();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function findUserByEmail(email) {
  const users = readUsers();
  return users.find((user) => user.email && user.email.toLowerCase() === String(email).trim().toLowerCase()) || null;
}

function createUser(user) {
  const users = readUsers();
  users.push(user);
  writeUsers(users);
  return user;
}

function updateUserPassword(email, newPassword) {
  const users = readUsers();
  const index = users.findIndex((user) => user.email && user.email.toLowerCase() === String(email).trim().toLowerCase());

  if (index === -1) return null;

  users[index].password = newPassword;
  writeUsers(users);
  return users[index];
}

module.exports = {
  readUsers,
  writeUsers,
  findUserByEmail,
  createUser,
  updateUserPassword,
  ensureDb,
};
