window.WebRTCClient = (() => {
  let localStream = null;
  let peerConnections = new Map();
  let socket = null;
  let config = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
    ]
  };

  function setSocket(io) {
    socket = io;
  }

  async function getLocalStream() {
    try {
      if (localStream) return localStream;
      
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true
      });
      
      return localStream;
    } catch (error) {
      alert('Camera access denied. Please enable camera permissions.');
      throw error;
    }
  }

  function stopLocalStream() {
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
    }
  }

  async function startCall(recipientId) {
    try {
      const stream = await getLocalStream();
      const peerConnection = new RTCPeerConnection(config);
      
      stream.getTracks().forEach(track => {
        peerConnection.addTrack(track, stream);
      });

      peerConnection.onicecandidate = (event) => {
        if (event.candidate && socket) {
          socket.emit('webrtc:ice-candidate', {
            to: recipientId,
            candidate: event.candidate
          });
        }
      };

      peerConnection.ontrack = (event) => {
        if (window.onRemoteStreamReceived) {
          window.onRemoteStreamReceived(recipientId, event.streams[0]);
        }
      };

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      peerConnections.set(recipientId, peerConnection);

      if (socket) {
        socket.emit('webrtc:offer', {
          to: recipientId,
          offer: offer
        });
      }

      return peerConnection;
    } catch (error) {
      throw error;
    }
  }

  async function handleOffer(senderId, offer) {
    try {
      const stream = await getLocalStream();
      const peerConnection = new RTCPeerConnection(config);

      stream.getTracks().forEach(track => {
        peerConnection.addTrack(track, stream);
      });

      peerConnection.onicecandidate = (event) => {
        if (event.candidate && socket) {
          socket.emit('webrtc:ice-candidate', {
            to: senderId,
            candidate: event.candidate
          });
        }
      };

      peerConnection.ontrack = (event) => {
        if (window.onRemoteStreamReceived) {
          window.onRemoteStreamReceived(senderId, event.streams[0]);
        }
      };

      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      peerConnections.set(senderId, peerConnection);

      if (socket) {
        socket.emit('webrtc:answer', {
          to: senderId,
          answer: answer
        });
      }

      return peerConnection;
    } catch (error) {
      throw error;
    }
  }

  async function handleAnswer(senderId, answer) {
    try {
      const peerConnection = peerConnections.get(senderId);
      if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      }
    } catch (error) {
      throw error;
    }
  }

  async function addIceCandidate(senderId, candidate) {
    try {
      const peerConnection = peerConnections.get(senderId);
      if (peerConnection && candidate) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      }
    } catch (error) {
    }
  }

  function endCall(userId) {
    const peerConnection = peerConnections.get(userId);
    if (peerConnection) {
      peerConnection.close();
      peerConnections.delete(userId);
    }
  }

  function endAllCalls() {
    peerConnections.forEach(pc => pc.close());
    peerConnections.clear();
    stopLocalStream();
  }

  function getLocalStream_readonly() {
    return localStream;
  }

  return {
    setSocket,
    getLocalStream,
    stopLocalStream,
    startCall,
    handleOffer,
    handleAnswer,
    addIceCandidate,
    endCall,
    endAllCalls,
    getLocalStream: getLocalStream_readonly
  };
})();
