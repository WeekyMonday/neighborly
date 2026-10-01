function createWebRTCManager() {
  const activeCalls = new Map();

  function initCall(callId, initiatorId, recipientId) {
    const call = {
      id: callId,
      initiator: initiatorId,
      recipient: recipientId,
      status: 'ringing',
      startTime: null,
      candidates: {
        [initiatorId]: [],
        [recipientId]: [],
      },
    };
    activeCalls.set(callId, call);
    return call;
  }

  function getCall(callId) {
    return activeCalls.get(callId) || null;
  }

  function updateCallStatus(callId, status) {
    const call = activeCalls.get(callId);
    if (call) {
      call.status = status;
      if (status === 'active') {
        call.startTime = Date.now();
      }
    }
    return call;
  }

  function addCandidate(callId, userId, candidate) {
    const call = activeCalls.get(callId);
    if (call && call.candidates[userId]) {
      call.candidates[userId].push(candidate);
    }
    return call;
  }

  function endCall(callId) {
    activeCalls.delete(callId);
    return true;
  }

  function getActiveCalls() {
    return Array.from(activeCalls.values());
  }

  return {
    initCall,
    getCall,
    updateCallStatus,
    addCandidate,
    endCall,
    getActiveCalls,
  };
}

module.exports = {
  createWebRTCManager,
};
