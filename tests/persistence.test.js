"use strict";

/**
 * Persistence regression tests.
 *
 * These run entirely offline against the file backend -- no Supabase account,
 * network or database required. They cover the behaviour that was broken:
 * friends, requests and DMs must survive a full store teardown and rebuild.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createRealtimeStore } = require("../BACKEND/socketManager");
const {
  createFilePersistence,
  createMemoryPersistence,
  conversationKey,
} = require("../BACKEND/config/persistence");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neighborly-test-"));
  return { dir, persistence: createFilePersistence(dir) };
}

async function addTwoUsers(store) {
  store.registerUser({ id: "u1", name: "Alice", handle: "alice", email: "alice@example.com" });
  store.registerUser({ id: "u2", name: "Bob", handle: "bob", email: "bob@example.com" });
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- conversation keys are symmetric ------------------------------------
assert.strictEqual(conversationKey("Bob", "alice"), "alice:bob", "conversation key must be order-independent");
assert.strictEqual(conversationKey("@Alice", "BOB"), "alice:bob", "conversation key must ignore case and @");

(async () => {
  // ---- friends survive a restart ----------------------------------------
  {
    const { dir } = freshStore();
    const storeA = createRealtimeStore(createFilePersistence(dir));
    await storeA.hydrate();
    await addTwoUsers(storeA);

    const sent = storeA.sendFriendRequest("alice", "bob");
    assert.ok(sent.success, `friend request should succeed: ${sent.message}`);
    assert.ok(storeA.acceptFriendRequest("bob", "alice").success, "bob should accept the request");
    assert.strictEqual(storeA.getFriends("alice").length, 1, "alice should have one friend");
    assert.strictEqual(storeA.getFriends("bob").length, 1, "friendship should be mutual");

    // Simulate a process restart: brand new store over the same directory.
    const storeB = createRealtimeStore(createFilePersistence(dir));
    await storeB.hydrate();

    const aliceFriends = storeB.getFriends("alice");
    assert.strictEqual(aliceFriends.length, 1, "friendship must survive a restart");
    assert.strictEqual(aliceFriends[0].handle, "bob", "the right friend must be restored");
    assert.strictEqual(storeB.getFriends("bob").length, 1, "the reverse direction must be restored too");

    const offlineProfile = storeB.findProfile("bob");
    assert.ok(offlineProfile, "a previously-seen user must be resolvable while offline");
    assert.strictEqual(offlineProfile.online, false, "they should correctly read as offline");

    cleanup(dir);
  }
  // ---- pending requests survive a restart -------------------------------
  {
    const { dir } = freshStore();
    const storeA = createRealtimeStore(createFilePersistence(dir));
    await storeA.hydrate();
    await addTwoUsers(storeA);
    storeA.sendFriendRequest("alice", "bob");

    const storeB = createRealtimeStore(createFilePersistence(dir));
    await storeB.hydrate();
    const state = storeB.getFriendState("bob");
    assert.strictEqual(state.incoming.length, 1, "a pending request must survive a restart");
    assert.strictEqual(state.incoming[0].handle, "alice", "the requester must be restored");
    assert.ok(
      storeB.acceptFriendRequest("bob", "alice").success,
      "a restored request must still be acceptable"
    );
    cleanup(dir);
  }

  // ---- removed friends do not come back --------------------------------
  {
    const { dir } = freshStore();
    const storeA = createRealtimeStore(createFilePersistence(dir));
    await storeA.hydrate();
    await addTwoUsers(storeA);
    storeA.sendFriendRequest("alice", "bob");
    storeA.acceptFriendRequest("bob", "alice");
    storeA.removeFriend("alice", "bob");

    const storeB = createRealtimeStore(createFilePersistence(dir));
    await storeB.hydrate();
    assert.strictEqual(storeB.getFriends("alice").length, 0, "an unfriend must persist across restart");
    cleanup(dir);
  }

  // ---- DM history survives a restart ------------------------------------
  {
    const { dir } = freshStore();
    const storeA = createRealtimeStore(createFilePersistence(dir));
    await storeA.hydrate();
    await addTwoUsers(storeA);

    await storeA.addDmMessage({ from: "alice", to: "bob", text: "hello bob" });
    await storeA.addDmMessage({ from: "bob", to: "alice", text: "hi alice" });
    await storeA.addDmMessage({ from: "alice", to: "bob", text: "private stuff" });

    const storeB = createRealtimeStore(createFilePersistence(dir));
    await storeB.hydrate();
    const history = await storeB.getDmMessages("bob", "alice"); // reverse order on purpose
    assert.strictEqual(history.length, 3, "DM history must survive a restart");
    assert.strictEqual(history[0].text, "hello bob", "history must be in chronological order");
    assert.strictEqual(history[2].sender, "alice", "sender must be preserved");

    const stranger = await storeB.getDmMessages("alice", "carol");
    assert.strictEqual(stranger.length, 0, "a DM room must only ever hold its own pair");
    cleanup(dir);
  }

  // ---- memory backend stays a no-op -------------------------------------
  {
    const store = createRealtimeStore(createMemoryPersistence());
    await store.hydrate();
    store.registerUser({ id: "u1", handle: "alice", name: "Alice" });
    assert.strictEqual(store.getFriends("alice").length, 0, "memory backend still works in-memory");
  }

  console.log("Persistence tests passed.");
})().catch((error) => {
  console.error("Persistence tests FAILED:", error);
  process.exit(1);
});