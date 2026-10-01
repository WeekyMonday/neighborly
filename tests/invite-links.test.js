const assert = require("assert");
const { createServerInviteToken, verifyServerInviteToken } = require("../BACKEND/inviteTokens");

const secret = "test-invite-secret";
const now = 1_800_000_000_000;
const server = {
  id: "server-123",
  name: "Study Group",
  initials: "SG",
  color: "#336699",
  textChannels: [{ id: "general", name: "general", category: "GENERAL" }],
  voiceChannels: [{ id: "voice", name: "Study Room" }],
  primaryChannelId: "general"
};

const token = createServerInviteToken(server, secret, now);
assert.ok(token, "valid server should create an invite token");
assert.deepStrictEqual(verifyServerInviteToken(token, secret, now + 1), server, "invite should resolve on another client or process with the same secret");
assert.strictEqual(verifyServerInviteToken(token, "wrong-secret", now + 1), null, "invite signed with another secret should be rejected");
assert.strictEqual(verifyServerInviteToken(`${token}x`, secret, now + 1), null, "tampered invite should be rejected");
assert.strictEqual(verifyServerInviteToken(token, secret, now + 30 * 24 * 60 * 60 * 1000), null, "expired invite should be rejected");
assert.strictEqual(createServerInviteToken({}, secret, now), null, "invalid server should not create an invite");

console.log("Server invite link tests passed.");