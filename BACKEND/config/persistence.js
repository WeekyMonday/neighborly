"use strict";

/**
 * Neighborly persistence layer.
 *
 * The realtime store keeps hot state in memory (fast socket reads), but every
 * durable change is mirrored out through this adapter. On Render the container
 * filesystem is ephemeral and the free tier sleeps/restarts, so in-memory-only
 * data disappears on every deploy. Supabase fixes that.
 *
 * Selection order (first match wins):
 *   1. SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY -> durable across restarts
 *   2. NEIGHBORLY_PERSISTENCE=file (or DATA_DIR) -> survives process restarts
 *                                                   where the disk is real
 *   3. memory -> current legacy behaviour
 *
 * Every method is safe to call when the backend is unavailable: failures are
 * logged once and swallowed, never thrown into the socket handlers.
 */

const fs = require("fs");
const path = require("path");

const TABLES = {
  profiles: "neighborly_profiles",
  friends: "neighborly_friends",
  requests: "neighborly_requests",
  dmMessages: "neighborly_dm_messages",
  channelMessages: "neighborly_channel_messages",
};

function normalizeHandle(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

/** Sorted handle pair -> stable room key shared by both participants. */
function conversationKey(handleA, handleB) {
  return [normalizeHandle(handleA), normalizeHandle(handleB)].sort().join(":");
}

// ---------------------------------------------------------------------------
// Memory (no-op) backend
// ---------------------------------------------------------------------------
function createMemoryPersistence() {
  return {
    mode: "memory",
    durable: false,
    async init() {},
    async loadState() {
      return { profiles: [], friendships: [], requests: [] };
    },
    async upsertProfile() {},
    async addFriendship() {},
    async removeFriendship() {},
    async upsertRequest() {},
    async deleteRequest() {},
    async appendChannelMessage() {},
    async loadChannelMessages() {
      return [];
    },
    async appendDmMessage() {},
    async loadDmMessages() {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// File backend — mirrors the whole state to one JSON document.
// Suitable for local development and for a Render persistent disk.
// ---------------------------------------------------------------------------
function createFilePersistence(dataDir) {
  const stateFile = path.join(dataDir, "realtime-state.json");
  let cache = null;
  let warned = false;

  function warn(error) {
    if (warned) return;
    warned = true;
    console.warn(`[persistence] file backend degraded: ${error.message}`);
  }

  function read() {
    if (cache) return cache;
    cache = { profiles: {}, friendships: [], requests: [], dmMessages: [], channelMessages: [] };
    try {
      if (fs.existsSync(stateFile)) {
        const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8") || "{}");
        cache = {
          profiles: parsed.profiles || {},
          friendships: parsed.friendships || [],
          requests: parsed.requests || [],
          dmMessages: parsed.dmMessages || [],
          channelMessages: parsed.channelMessages || [],
        };
      }
    } catch (error) {
      warn(error);
    }
    return cache;
  }

  /**
   * Writes are atomic (temp file + rename) so a crash mid-write can never
   * leave a truncated state file. They are deliberately synchronous rather
   * than debounced: the friend graph and requests are low-volume but must be
   * durable the instant they change, otherwise a crash in the debounce window
   * silently loses them.
   */
  function flush() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = `${stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
      fs.renameSync(tmp, stateFile);
    } catch (error) {
      warn(error);
    }
  }

  return {
    mode: "file",
    durable: true,

    async init() {
      fs.mkdirSync(dataDir, { recursive: true });
      read();
    },

    async loadState() {
      const state = read();
      return {
        profiles: Object.values(state.profiles),
        friendships: state.friendships,
        requests: state.requests,
      };
    },

    async upsertProfile(profile) {
      // Accepts either casing: the store emits the same snake_case shape the
      // Supabase backend uses, so both backends share one call signature.
      const handleKey = normalizeHandle(profile.handle_key || profile.handleKey || profile.handle);
      if (!handleKey) return;
      read().profiles[handleKey] = {
        handle_key: handleKey,
        handle: profile.handle || handleKey,
        name: profile.name || '',
        email: profile.email || '',
        initials: profile.initials || '',
        color: profile.color || '#7c6ff7',
        avatar_image: profile.avatar_image || profile.avatarImage || null,
        updated_at: profile.updated_at || new Date().toISOString(),
      };
      flush();
    },

    async addFriendship(ownerKey, friendKey) {
      const state = read();
      if (!state.friendships.some((f) => f.ownerKey === ownerKey && f.friendKey === friendKey)) {
        state.friendships.push({ ownerKey, friendKey });
        flush();
      }
    },

    async removeFriendship(ownerKey, friendKey) {
      const state = read();
      state.friendships = state.friendships.filter(
        (f) => !(f.ownerKey === ownerKey && f.friendKey === friendKey)
      );
      flush();
    },

    async upsertRequest(request) {
      const state = read();
      const index = state.requests.findIndex((r) => r.id === request.id);
      if (index === -1) state.requests.push(request);
      else state.requests[index] = request;
      flush();
    },

    async deleteRequest(id) {
      const state = read();
      state.requests = state.requests.filter((r) => r.id !== id);
      flush();
    },

    async appendChannelMessage(message) {
      const state = read();
      state.channelMessages = state.channelMessages || [];
      state.channelMessages.push({
        id: message.id,
        channel: message.channel,
        author: message.author,
        text: message.text,
        attachment: message.attachment || null,
        author_handle: message.authorHandle || null,
        author_color: message.authorColor || null,
        author_avatar: message.authorAvatar || null,
        created_at: message.createdAt,
      });
      if (state.channelMessages.length > 5000) {
        state.channelMessages = state.channelMessages.slice(-5000);
      }
      flush();
    },

    async loadChannelMessages(key, limit = 100) {
      const state = read();
      const all = state.channelMessages || [];
      return all.filter((m) => m.channel === key).slice(-limit);
    },

    async appendDmMessage(message) {
      const state = read();
      // Stored in the same snake_case shape Supabase returns, so
      // getDmMessages() maps rows identically for both backends.
      state.dmMessages = state.dmMessages || [];
      state.dmMessages.push({
        id: message.id,
        conversation_key: message.conversationKey,
        sender_key: message.senderKey || message.sender,
        text: message.text,
        attachment: message.attachment || null,
        created_at: message.createdAt,
      });
      // Keep the tail bounded so the file cannot grow without limit.
      if (state.dmMessages.length > 5000) state.dmMessages = state.dmMessages.slice(-5000);
      flush();
    },

    async loadDmMessages(key, limit = 100) {
      const state = read();
      return state.dmMessages.filter((m) => m.conversation_key === key).slice(-limit);
    },
  };
}

// ---------------------------------------------------------------------------
// Supabase backend
// ---------------------------------------------------------------------------
function createSupabasePersistence(createClient, url, serviceRoleKey, tables = TABLES) {
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let warned = false;

  async function guard(label, promise, fallback = null) {
    try {
      const { data, error } = await promise;
      if (error) throw error;
      return data;
    } catch (error) {
      if (!warned) {
        warned = true;
        console.warn(`[persistence] supabase ${label} failed: ${error.message}`);
      }
      return fallback;
    }
  }

  return {
    mode: "supabase",
    durable: true,

    async init() {
      const { error } = await client.from(tables.profiles).select("handle_key").limit(1);
      if (error) {
        console.warn(
          `[persistence] Supabase query failed: ${error.message}. ` +
            "Did you run BACKEND/supabase-schema.sql?"
        );
      }
    },

    async loadState() {
      const [profiles, friendships, requests] = await Promise.all([
        guard("loadState", client.from(tables.profiles).select("*"), []),
        guard("loadState", client.from(tables.friends).select("*"), []),
        guard("loadState", client.from(tables.requests).select("*"), []),
      ]);
      return { profiles, friendships, requests };
    },

    async upsertProfile(profile) {
      await guard("upsertProfile", client.from(tables.profiles).upsert(profile, { onConflict: "handle_key" }));
    },

    async addFriendship(ownerKey, friendKey) {
      await guard(
        "addFriendship",
        client
          .from(tables.friends)
          .upsert({ owner_key: ownerKey, friend_key: friendKey }, { onConflict: "owner_key,friend_key" })
      );
    },

    async removeFriendship(ownerKey, friendKey) {
      await guard(
        "removeFriendship",
        client
          .from(tables.friends)
          .delete()
          .eq("owner_key", ownerKey)
          .eq("friend_key", friendKey)
      );
    },

    async upsertRequest(request) {
      await guard("upsertRequest", client.from(tables.requests).upsert(request, { onConflict: "id" }));
    },

    async deleteRequest(id) {
      await guard("deleteRequest", client.from(tables.requests).delete().eq("id", id));
    },

    async appendChannelMessage(message) {
      await guard(
        "appendChannelMessage",
        client.from(tables.channelMessages).insert({
          id: message.id,
          channel: message.channel,
          author: message.author,
          text: message.text,
          attachment: message.attachment || null,
          author_handle: message.authorHandle || null,
          author_color: message.authorColor || null,
          author_avatar: message.authorAvatar || null,
          created_at: message.createdAt,
        })
      );
    },

    async loadChannelMessages(key, limit = 100) {
      const rows = await guard(
        "loadChannelMessages",
        client
          .from(tables.channelMessages)
          .select("*")
          .eq("channel", key)
          .order("created_at", { ascending: false })
          .limit(limit),
        []
      );
      return (rows || []).reverse();
    },

    async appendDmMessage(message) {
      await guard(
        "appendDmMessage",
        client.from(tables.dmMessages).insert({
          id: message.id,
          conversation_key: message.conversationKey,
          sender_key: message.senderKey || message.sender,
          text: message.text,
          attachment: message.attachment || null,
          created_at: message.createdAt,
        })
      );
    },

    async loadDmMessages(key, limit = 100) {
      const rows = await guard(
        "loadDmMessages",
        client
          .from(tables.dmMessages)
          .select("*")
          .eq("conversation_key", key)
          .order("created_at", { ascending: false })
          .limit(limit),
        []
      );
      return (rows || []).reverse();
    },
  };
}

// ---------------------------------------------------------------------------
function createPersistence(overrides = {}) {
  const env = overrides.env || process.env;

  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    // Required lazily so the app still boots if the dependency is missing.
    const { createClient } = require("@supabase/supabase-js");
    return createSupabasePersistence(createClient, env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }

  const wantsFile =
    String(env.NEIGHBORLY_PERSISTENCE || "").toLowerCase() === "file" || Boolean(env.DATA_DIR);
  if (wantsFile) {
    return createFilePersistence(env.DATA_DIR || path.join(__dirname, "..", "data"));
  }

  return createMemoryPersistence();
}

module.exports = {
  createPersistence,
  conversationKey,
  normalizeHandle,
  createMemoryPersistence,
  createFilePersistence,
  TABLES,
};