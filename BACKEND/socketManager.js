function normalizeHandle(value) {
  return String(value || '').trim().replace(/^@/, '').toLowerCase();
}

function buildProfile(user = {}) {
  const rawHandle = String(
    user.handle || (user.email ? String(user.email).split('@')[0] : '') || 'guest'
  ).trim().replace(/^@/, '');
  const handle = rawHandle || 'guest';
  const name = String(user.name || handle || 'Neighborly User').trim().slice(0, 60) || 'Neighborly User';
  const initials = String(
    user.initials || name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('') || 'NU'
  ).slice(0, 4) || 'NU';
  const color = /^#[\da-f]{6}$/i.test(user.color || '') ? user.color : '#7c6ff7';
  const avatarImage = typeof user.avatarImage === 'string' && user.avatarImage.length < 100000 ? user.avatarImage : null;
  return {
    id: user.id ? String(user.id) : null,
    name,
    handle,
    initials,
    color,
    avatarImage,
    email: user.email ? String(user.email) : '',
  };
}

function createRealtimeStore(persistence) {
  const users = new Map();
  const messagesByChannel = new Map();
  const friendRequests = new Map(); // handle key -> [{ id, from, to, status, timestamp }]
  const friends = new Map(); // handle key -> [handle key]
  const profiles = new Map(); // handle key -> public profile
  const store = persistence || null; // may be null -> purely in-memory

  // Persistence must never break a socket handler, but it also must not be
  // deferred: a deferred write can still be pending when the next reader runs,
  // which would show a stale (empty) friend list. Call through immediately and
  // only swallow async rejections.
  function persist(action, ...args) {
    if (!store || !store.durable || typeof store[action] !== 'function') return;
    const warn = (error) => console.warn(`[persistence] ${action} failed: ${error.message}`);
    try {
      const result = store[action](...args);
      if (result && typeof result.catch === 'function') result.catch(warn);
    } catch (error) {
      warn(error);
    }
  }

  /**
   * Load durable state into memory at boot. Safe to call once; later calls
   * are ignored so a reconnecting socket cannot wipe live presence.
   */
  let hydrated = false;
  async function hydrate() {
    if (!store || !store.durable || hydrated) return false;
    hydrated = true;
    await store.init();

    const state = await store.loadState();
    for (const profile of state.profiles || []) {
      const handleKey = normalizeHandle(profile.handle_key || profile.handleKey || profile.handle);
      if (!handleKey) continue;
      profiles.set(handleKey, {
        id: profile.id || null,
        name: profile.name || handleKey,
        handle: profile.handle || handleKey,
        initials: profile.initials || '',
        color: profile.color || '#7c6ff7',
        avatarImage: profile.avatarImage || profile.avatar_image || null,
        email: profile.email || '',
      });
      if (!friends.has(handleKey)) friends.set(handleKey, []);
      if (!friendRequests.has(handleKey)) friendRequests.set(handleKey, []);
    }
    for (const edge of state.friendships || []) {
      const ownerKey = normalizeHandle(edge.ownerKey || edge.owner_key);
      const friendKey = normalizeHandle(edge.friendKey || edge.friend_key);
      if (!ownerKey || !friendKey) continue;
      if (!friends.has(ownerKey)) friends.set(ownerKey, []);
      if (!friends.get(ownerKey).includes(friendKey)) friends.get(ownerKey).push(friendKey);
    }
    for (const request of state.requests || []) {
      const toKey = normalizeHandle(request.toKey || request.to_key || request.to);
      if (!toKey) continue;
      const list = friendRequests.get(toKey) || [];
      list.push({
        id: request.id || `${request.from}->${request.to}`,
        from: request.from,
        to: request.to,
        status: request.status || 'pending',
        timestamp: Number(request.timestamp || request.created_at || 0),
      });
      friendRequests.set(toKey, list);
    }

    console.log(
      `[persistence] hydrated ${profiles.size} profiles, ` +
        `${state.friendships?.length || 0} friendships, ` +
        `${state.requests?.length || 0} requests`
    );
    return true;
  }

  function isOnline(handleKey) {
    for (const record of users.values()) {
      if (record.online && normalizeHandle(record.handle) === handleKey) return true;
    }
    return false;
  }

  function profileFor(handleKey) {
    const profile = profiles.get(handleKey);
    if (!profile) return null;
    return { ...profile, online: isOnline(handleKey) };
  }

  /**
   * Look up a handle that may never have connected in this process. With a
   * durable store hydrated at boot, previously-seen users are known even while
   * offline, so "could not find @x" no longer depends on who happens to be
   * connected right now.
   */
  function findProfile(handle) {
    return profileFor(normalizeHandle(handle));
  }

  function rememberProfile(profile) {
    const handleKey = normalizeHandle(profile.handle);
    if (!handleKey) return null;
    const merged = { ...(profiles.get(handleKey) || {}), ...profile, handle: profile.handle };
    profiles.set(handleKey, merged);
    if (!friends.has(handleKey)) friends.set(handleKey, friends.get(handleKey) || []);
    if (!friendRequests.has(handleKey)) friendRequests.set(handleKey, friendRequests.get(handleKey) || []);
    persist('upsertProfile', {
      handle_key: handleKey,
      handle: merged.handle,
      name: merged.name || '',
      email: merged.email || '',
      initials: merged.initials || '',
      color: merged.color || '#7c6ff7',
      avatar_image: merged.avatarImage || null,
      updated_at: new Date().toISOString(),
    });
    return handleKey;
  }

  function registerUser(user) {
    const profile = buildProfile(user);
    const id = profile.id || `guest-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const handleKey = rememberProfile({ ...profile, id });
    const record = {
      id,
      name: profile.name,
      email: profile.email,
      handle: profile.handle,
      initials: profile.initials,
      color: profile.color,
      avatarImage: profile.avatarImage,
      handleKey,
      online: true,
      lastSeen: Date.now(),
    };

    users.set(id, record);
    return record;
  }

  function removeUser(userId) {
    if (!userId) return null;
    const user = users.get(String(userId));
    if (user) {
      user.online = false;
      users.delete(String(userId));
    }
    return user || null;
  }

  function getOnlineUsers() {
    return [...users.values()].filter((user) => user.online);
  }

  function addMessage({ channel, author, text, attachment = null, clientMessageId = null }) {
    const normalizedChannel = channel || 'general';
    const message = {
      id: clientMessageId || `m-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      channel: normalizedChannel,
      author,
      text: String(text || '').trim(),
      attachment,
      clientMessageId: clientMessageId || null,
      createdAt: new Date().toISOString(),
    };

    const list = messagesByChannel.get(normalizedChannel) || [];
    list.push(message);
    messagesByChannel.set(normalizedChannel, list);
    return message;
  }

  function getMessages(channel) {
    return messagesByChannel.get(channel || 'general') || [];
  }

  // --- Direct messages ------------------------------------------------------
  // A DM conversation is identified by the sorted handle pair, so both people
  // always resolve to the same room key without trusting client input.

  function dmRoomKey(handleA, handleB) {
    return [normalizeHandle(handleA), normalizeHandle(handleB)].sort().join(':');
  }

  async function addDmMessage({ from, to, text, attachment = null, clientMessageId = null }) {
    const senderKey = normalizeHandle(from);
    const recipientKey = normalizeHandle(to);
    if (!senderKey || !recipientKey) return null;
    if (senderKey === recipientKey) return null;

    const message = {
      id: clientMessageId || `dm-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      conversationKey: dmRoomKey(senderKey, recipientKey),
      sender: senderKey,
      recipient: recipientKey,
      text: String(text || '').trim().slice(0, 4000),
      attachment,
      createdAt: new Date().toISOString(),
    };
    persist('appendDmMessage', message);
    return message;
  }

  async function getDmMessages(handleA, handleB, limit = 100) {
    const key = dmRoomKey(handleA, handleB);
    if (store && store.durable) {
      const rows = await store.loadDmMessages(key, limit);
      return (rows || []).map((row) => ({
        id: row.id,
        conversationKey: key,
        sender: row.senderKey || row.sender_key || row.sender,
        text: row.text || '',
        attachment: row.attachment || null,
        createdAt: row.created_at || row.createdAt,
      }));
    }
    return [];
  }

  // --- Friend management ---------------------------------------------------
  function addFriendPair(firstKey, secondKey) {
    const firstFriends = friends.get(firstKey) || [];
    if (!firstFriends.includes(secondKey)) firstFriends.push(secondKey);
    friends.set(firstKey, firstFriends);

    const secondFriends = friends.get(secondKey) || [];
    if (!secondFriends.includes(firstKey)) secondFriends.push(firstKey);
    friends.set(secondKey, secondFriends);

    // Both directions are stored so either user's list hydrates correctly.
    persist('addFriendship', firstKey, secondKey);
    persist('addFriendship', secondKey, firstKey);
  }

  function saveRequest(request) {
    const toKey = normalizeHandle(request.to);
    const list = friendRequests.get(toKey) || [];
    const index = list.findIndex((item) => item.id === request.id);
    if (index === -1) list.push(request);
    else list[index] = request;
    friendRequests.set(toKey, list);
    persist('upsertRequest', {
      id: request.id,
      from: request.from,
      to: request.to,
      from_key: normalizeHandle(request.from),
      to_key: toKey,
      status: request.status,
      created_at: new Date(request.timestamp || Date.now()).toISOString(),
    });
  }

  function dropRequest(request) {
    const toKey = normalizeHandle(request.to);
    friendRequests.set(toKey, (friendRequests.get(toKey) || []).filter((item) => item.id !== request.id));
    persist('deleteRequest', request.id);
  }

  function pendingIncoming(handleKey) {
    return (friendRequests.get(handleKey) || []).filter((request) => request.status === 'pending');
  }

  function pendingOutgoing(handleKey) {
    const outgoing = [];
    friendRequests.forEach((list) => {
      list.forEach((request) => {
        if (request.status === 'pending' && normalizeHandle(request.from) === handleKey) outgoing.push(request);
      });
    });
    return outgoing;
  }

  function getFriendState(handle) {
    const handleKey = normalizeHandle(handle);
    const friendList = (friends.get(handleKey) || [])
      .map((friendKey) => profileFor(friendKey))
      .filter(Boolean)
      .map((profile) => ({ ...profile, activity: '', lastMessage: '' }));
    const incoming = pendingIncoming(handleKey)
      .map((request) => {
        const profile = profileFor(normalizeHandle(request.from));
        return profile ? { ...profile, requestedAt: request.timestamp } : null;
      })
      .filter(Boolean);
    const outgoing = pendingOutgoing(handleKey)
      .map((request) => {
        const profile = profileFor(normalizeHandle(request.to));
        return profile ? { ...profile, requestedAt: request.timestamp } : null;
      })
      .filter(Boolean);
    return { handle: handleKey, friends: friendList, incoming, outgoing };
  }

  function sendFriendRequest(fromHandle, toHandle) {
    const fromKey = normalizeHandle(fromHandle);
    const toKey = normalizeHandle(toHandle);
    if (!fromKey || !toKey) return { success: false, message: 'Enter a valid username.' };
    if (fromKey === toKey) return { success: false, message: 'You cannot add yourself as a friend.' };

    const fromProfile = profileFor(fromKey);
    const toProfile = findProfile(toKey);
    if (!toProfile) {
      return {
        success: false,
        message: `We could not find @${toHandle}. They need to have opened Neighborly at least once.`,
      };
    }

    if ((friends.get(fromKey) || []).includes(toKey)) {
      return { success: false, message: `You and @${toProfile.handle} are already friends.` };
    }

    const incoming = pendingIncoming(fromKey).find((request) => normalizeHandle(request.from) === toKey);
    if (incoming) {
      acceptFriendRequest(fromHandle, toProfile.handle);
      return { success: true, autoAccepted: true, message: `You and @${toProfile.handle} are now friends.`, from: fromProfile, to: toProfile };
    }

    if (pendingIncoming(toKey).some((request) => normalizeHandle(request.from) === fromKey)) {
      return { success: false, message: `You already sent @${toProfile.handle} a friend request.` };
    }

    const requests = friendRequests.get(toKey) || [];
    const request = {
      id: `${fromProfile.handle}->${toProfile.handle}`,
      from: fromProfile.handle,
      to: toProfile.handle,
      status: 'pending',
      timestamp: Date.now(),
    };
    saveRequest(request);
    return { success: true, message: `Friend request sent to @${toProfile.handle}.`, from: fromProfile, to: toProfile };
  }

  function acceptFriendRequest(handle, fromHandle) {
    const handleKey = normalizeHandle(handle);
    const fromKey = normalizeHandle(fromHandle);
    if (!handleKey || !fromKey) return { success: false };
    const requests = friendRequests.get(handleKey) || [];
    const request = requests.find((item) => normalizeHandle(item.from) === fromKey && item.status === 'pending');
    if (!request) return { success: false };
    request.status = 'accepted';
    saveRequest(request);
    addFriendPair(handleKey, fromKey);
    return { success: true, friend: profileFor(fromKey) };
  }

  function rejectFriendRequest(handle, fromHandle) {
    const handleKey = normalizeHandle(handle);
    const fromKey = normalizeHandle(fromHandle);
    const requests = friendRequests.get(handleKey) || [];
    const request = requests.find((item) => normalizeHandle(item.from) === fromKey && item.status === 'pending');
    if (!request) return { success: false };
    dropRequest(request);
    return { success: true };
  }

  function cancelFriendRequest(handle, toHandle) {
    const handleKey = normalizeHandle(handle);
    const toKey = normalizeHandle(toHandle);
    const requests = friendRequests.get(toKey) || [];
    const request = requests.find((item) => normalizeHandle(item.from) === handleKey && item.status === 'pending');
    if (!request) return { success: false };
    dropRequest(request);
    return { success: true };
  }

  function removeFriend(handle, otherHandle) {
    const handleKey = normalizeHandle(handle);
    const otherKey = normalizeHandle(otherHandle);
    if (!handleKey || !otherKey) return { success: false };
    friends.set(handleKey, (friends.get(handleKey) || []).filter((item) => item !== otherKey));
    friends.set(otherKey, (friends.get(otherKey) || []).filter((item) => item !== handleKey));
    persist('removeFriendship', handleKey, otherKey);
    persist('removeFriendship', otherKey, handleKey);
    return { success: true };
  }

  function getFriends(handle) {
    const handleKey = normalizeHandle(handle);
    return (friends.get(handleKey) || []).map((friendKey) => profileFor(friendKey)).filter(Boolean);
  }

  function getUserByName(userName) {
    const handleKey = normalizeHandle(userName);
    for (const user of users.values()) {
      if (normalizeHandle(user.handle) === handleKey || String(user.name || '').toLowerCase() === String(userName || '').toLowerCase()) {
        return user;
      }
    }
    return null;
  }

  function getAllUsers() {
    return [...users.values()];
  }

  function clear() {
    users.clear();
    messagesByChannel.clear();
    friendRequests.clear();
    friends.clear();
    profiles.clear();
  }

  return {
    hydrate,
    registerUser,
    removeUser,
    getOnlineUsers,
    addMessage,
    getMessages,
    addDmMessage,
    getDmMessages,
    dmRoomKey,
    findProfile,
    getFriendState,
    sendFriendRequest,
    acceptFriendRequest,
    rejectFriendRequest,
    cancelFriendRequest,
    removeFriend,
    getFriends,
    getUserByName,
    getAllUsers,
    clear,
  };
}

module.exports = {
  createRealtimeStore,
  normalizeHandle,
  buildProfile,
};
