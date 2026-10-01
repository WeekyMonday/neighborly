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

function createRealtimeStore() {
  const users = new Map();
  const messagesByChannel = new Map();
  const friendRequests = new Map(); // handle key -> [{ from, to, status, timestamp }]
  const friends = new Map(); // handle key -> [handle key]
  const profiles = new Map(); // handle key -> public profile

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

  function rememberProfile(profile) {
    const handleKey = normalizeHandle(profile.handle);
    if (!handleKey) return null;
    profiles.set(handleKey, { ...(profiles.get(handleKey) || {}), ...profile, handle: profile.handle });
    if (!friends.has(handleKey)) friends.set(handleKey, friends.get(handleKey) || []);
    if (!friendRequests.has(handleKey)) friendRequests.set(handleKey, friendRequests.get(handleKey) || []);
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

  // --- Friend management ---------------------------------------------------
  function addFriendPair(firstKey, secondKey) {
    const firstFriends = friends.get(firstKey) || [];
    if (!firstFriends.includes(secondKey)) firstFriends.push(secondKey);
    friends.set(firstKey, firstFriends);

    const secondFriends = friends.get(secondKey) || [];
    if (!secondFriends.includes(firstKey)) secondFriends.push(firstKey);
    friends.set(secondKey, secondFriends);
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
    const toProfile = profileFor(toKey);
    if (!toProfile) {
      return { success: false, message: `We could not find @${toHandle}. Ask them to open Neighborly once so they show up online.` };
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
    requests.push({ from: fromProfile.handle, to: toProfile.handle, status: 'pending', timestamp: Date.now() });
    friendRequests.set(toKey, requests);
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
    friendRequests.set(handleKey, requests);
    addFriendPair(handleKey, fromKey);
    return { success: true, friend: profileFor(fromKey) };
  }

  function rejectFriendRequest(handle, fromHandle) {
    const handleKey = normalizeHandle(handle);
    const fromKey = normalizeHandle(fromHandle);
    const requests = friendRequests.get(handleKey) || [];
    const index = requests.findIndex((item) => normalizeHandle(item.from) === fromKey && item.status === 'pending');
    if (index === -1) return { success: false };
    requests.splice(index, 1);
    friendRequests.set(handleKey, requests);
    return { success: true };
  }

  function cancelFriendRequest(handle, toHandle) {
    const handleKey = normalizeHandle(handle);
    const toKey = normalizeHandle(toHandle);
    const requests = friendRequests.get(toKey) || [];
    const index = requests.findIndex((item) => normalizeHandle(item.from) === handleKey && item.status === 'pending');
    if (index === -1) return { success: false };
    requests.splice(index, 1);
    friendRequests.set(toKey, requests);
    return { success: true };
  }

  function removeFriend(handle, otherHandle) {
    const handleKey = normalizeHandle(handle);
    const otherKey = normalizeHandle(otherHandle);
    if (!handleKey || !otherKey) return { success: false };
    friends.set(handleKey, (friends.get(handleKey) || []).filter((item) => item !== otherKey));
    friends.set(otherKey, (friends.get(otherKey) || []).filter((item) => item !== handleKey));
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
    registerUser,
    removeUser,
    getOnlineUsers,
    addMessage,
    getMessages,
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
