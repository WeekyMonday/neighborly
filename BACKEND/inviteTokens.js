const crypto = require("crypto");
const zlib = require("zlib");

const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function cleanText(value, fallback, maxLength) {
  return String(value || fallback).trim().slice(0, maxLength);
}

function cleanChannels(channels, fallbackName, type) {
  if (!Array.isArray(channels)) return [{ id: `${type}-general`, name: fallbackName }];
  return channels.slice(0, 50).map((channel, index) => ({
    id: cleanText(channel?.id, `${type}-${index + 1}`, 100),
    name: cleanText(channel?.name, fallbackName, 100),
    ...(channel?.category ? { category: cleanText(channel.category, "GENERAL", 50) } : {}),
    ...(channel?.description ? { description: cleanText(channel.description, "", 300) } : {})
  }));
}

function normalizeServer(server) {
  if (!server || typeof server !== "object") return null;
  const id = cleanText(server.id, "", 100);
  const name = cleanText(server.name, "", 100);
  if (!id || !name) return null;

  return {
    id,
    name,
    initials: cleanText(server.initials, name.slice(0, 2).toUpperCase(), 4),
    color: /^#[\da-f]{6}$/i.test(server.color || "") ? server.color : "#7c6ff7",
    textChannels: cleanChannels(server.textChannels, "general", "channel"),
    voiceChannels: cleanChannels(server.voiceChannels, "General", "voice"),
    primaryChannelId: cleanText(server.primaryChannelId, "channel-general", 100)
  };
}

function sign(encodedPayload, secret) {
  return crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function createServerInviteToken(server, secret, now = Date.now()) {
  const normalizedServer = normalizeServer(server);
  if (!normalizedServer || !secret) return null;
  const payload = zlib.deflateRawSync(Buffer.from(JSON.stringify({ server: normalizedServer, expiresAt: now + INVITE_TTL_MS }))).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

function verifyServerInviteToken(token, secret, now = Date.now()) {
  if (typeof token !== "string" || !secret) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;

  const expected = Buffer.from(sign(payload, secret));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;

  try {
    const decoded = JSON.parse(zlib.inflateRawSync(Buffer.from(payload, "base64url")).toString("utf8"));
    const server = normalizeServer(decoded.server);
    if (!server || !Number.isFinite(decoded.expiresAt) || decoded.expiresAt <= now) return null;
    return server;
  } catch (error) {
    return null;
  }
}

module.exports = { createServerInviteToken, verifyServerInviteToken };