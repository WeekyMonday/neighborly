function createRealtimeStore() {
  const users = new Map();
  const messagesByChannel = new Map();
  const friendRequests = new Map(); // { "userId": [{ from, to, status }] }
  const friends = new Map(); // { "userId": [friendUsernames] }

  function registerUser(user) {
    const userId = user && user.id ? String(user.id) : `guest-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const record = {
      id: userId,
      name: user && user.name ? user.name : 'Guest',
      email: user && user.email ? user.email : '',
      handle: user && user.handle ? user.handle : 'guest',
      online: true,
      lastSeen: Date.now(),
    };

    users.set(userId, record);
    if (!friends.has(userId)) friends.set(userId, []);
    if (!friendRequests.has(userId)) friendRequests.set(userId, []);
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

  // Friend Management Functions
  function sendFriendRequest(fromUserName, toUserName) {
    if (fromUserName === toUserName) {
      return { success: false, message: 'Cannot add yourself' };
    }

    // Find toUser
    let toUserId = null;
    for (const [userId, user] of users) {
      if (user.name === toUserName) {
        toUserId = userId;
        break;
      }
    }

    if (!toUserId) {
      return { success: false, message: 'User not found' };
    }

    // Check if already friends
    const userFriends = friends.get(toUserId) || [];
    if (userFriends.includes(fromUserName)) {
      return { success: false, message: 'Already friends' };
    }

    // Check for existing request
    const toUserRequests = friendRequests.get(toUserId) || [];
    const existingRequest = toUserRequests.find(r => r.from === fromUserName && r.status === 'pending');
    if (existingRequest) {
      return { success: false, message: 'Request already sent' };
    }

    // Add request
    const request = {
      from: fromUserName,
      to: toUserName,
      status: 'pending',
      timestamp: Date.now()
    };
    toUserRequests.push(request);
    friendRequests.set(toUserId, toUserRequests);

    return { success: true, message: 'Friend request sent', request };
  }

  function getPendingRequests(userName) {
    let userId = null;
    for (const [uid, user] of users) {
      if (user.name === userName) {
        userId = uid;
        break;
      }
    }
    if (!userId) return [];
    return (friendRequests.get(userId) || []).filter(r => r.status === 'pending');
  }

  function acceptFriendRequest(userName, fromUserName) {
    let userId = null;
    let fromUserId = null;

    for (const [uid, user] of users) {
      if (user.name === userName) userId = uid;
      if (user.name === fromUserName) fromUserId = uid;
    }

    if (!userId || !fromUserId) return { success: false };

    // Update request status
    const toUserRequests = friendRequests.get(userId) || [];
    const requestIdx = toUserRequests.findIndex(r => r.from === fromUserName && r.status === 'pending');
    if (requestIdx === -1) return { success: false };

    toUserRequests[requestIdx].status = 'accepted';

    // Add to friends lists
    const userFriends = friends.get(userId) || [];
    const fromUserFriends = friends.get(fromUserId) || [];

    if (!userFriends.includes(fromUserName)) userFriends.push(fromUserName);
    if (!fromUserFriends.includes(userName)) fromUserFriends.push(userName);

    friends.set(userId, userFriends);
    friends.set(fromUserId, fromUserFriends);

    return { success: true, message: 'Friend request accepted' };
  }

  function rejectFriendRequest(userName, fromUserName) {
    let userId = null;
    for (const [uid, user] of users) {
      if (user.name === userName) {
        userId = uid;
        break;
      }
    }

    if (!userId) return { success: false };

    const toUserRequests = friendRequests.get(userId) || [];
    const requestIdx = toUserRequests.findIndex(r => r.from === fromUserName && r.status === 'pending');
    if (requestIdx === -1) return { success: false };

    toUserRequests.splice(requestIdx, 1);
    return { success: true };
  }

  function getFriends(userName) {
    let userId = null;
    for (const [uid, user] of users) {
      if (user.name === userName) {
        userId = uid;
        break;
      }
    }
    if (!userId) return [];
    return friends.get(userId) || [];
  }

  function getUserByName(userName) {
    for (const [userId, user] of users) {
      if (user.name === userName) return user;
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
  }

  return {
    registerUser,
    removeUser,
    getOnlineUsers,
    addMessage,
    getMessages,
    sendFriendRequest,
    getPendingRequests,
    acceptFriendRequest,
    rejectFriendRequest,
    getFriends,
    getUserByName,
    getAllUsers,
    clear,
  };
}

module.exports = {
  createRealtimeStore,
};
