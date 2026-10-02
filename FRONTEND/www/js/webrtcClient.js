window.WebRTCClient = (() => {
  const peerConnections = new Map();
  const remoteStreams = new Map();
  const knownPeers = new Map();
  const queuedCandidates = new Map();
  // Public STUN is enough for most home networks. Behind strict
  // corporate/ISP NATs a TURN relay is required; a deployer can supply one
  // by defining window.NEIGHBORLY_ICE_SERVERS (an iceServers array) or
  // window.NEIGHBORLY_TURN_CREDENTIALS_URL (a URL returning such an array).
  const extraIceServers = Array.isArray(window.NEIGHBORLY_ICE_SERVERS) ? window.NEIGHBORLY_ICE_SERVERS : [];
  const rtcConfig = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:stun.cloudflare.com:3478' },
      ...extraIceServers
    ],
    iceCandidatePoolSize: 4,
    bundlePolicy: 'max-bundle'
  };

  let socket = null;
  let localAudioStream = null;
  let cameraStream = null;
  let screenStream = null;
  let activeChannel = null;
  let localProfile = null;
  let isDeafened = false;
  let callbacks = {};
  let connectPromise = null;
  let iceServersLoaded = false;

  async function loadConfiguredIceServers() {
    if (iceServersLoaded) return;
    iceServersLoaded = true;
    const endpoint = typeof window.NEIGHBORLY_TURN_CREDENTIALS_URL === 'string' ? window.NEIGHBORLY_TURN_CREDENTIALS_URL : '';
    if (!endpoint) return;
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) return;
      const servers = await response.json();
      if (Array.isArray(servers) && servers.length) rtcConfig.iceServers = [...rtcConfig.iceServers, ...servers];
    } catch {
      /* Keep the default STUN configuration if TURN credentials cannot load. */
    }
  }

  const sharePresets = {
    '480p15': { width: 854, height: 480, fps: 15, maxBitrate: 900000 },
    '720p30': { width: 1280, height: 720, fps: 30, maxBitrate: 2500000 },
    '1080p30': { width: 1920, height: 1080, fps: 30, maxBitrate: 4500000 },
    '1080p60': { width: 1920, height: 1080, fps: 60, maxBitrate: 6000000 }
  };

  function emitNotice(message, isError = false) {
    if (callbacks.onNotice) callbacks.onNotice(message, isError);
  }

  function displayNameForProfile(profile = {}) {
    return {
      name: String(profile.name || 'Neighborly User').slice(0, 60),
      handle: String(profile.handle || '').slice(0, 60),
      initials: String(profile.initials || '').slice(0, 4),
      color: /^#[\da-f]{6}$/i.test(profile.color || '') ? profile.color : '#7c6ff7',
      avatarImage: typeof profile.avatarImage === 'string' ? profile.avatarImage : null
    };
  }

  function notifyParticipants() {
    if (!callbacks.onParticipants) return;
    callbacks.onParticipants(Array.from(knownPeers, ([peerId, profile]) => ({
      id: peerId,
      ...profile,
      stream: remoteStreams.get(peerId) || null
    })));
  }

  function updateRemoteStream(peerId, stream, profile) {
    remoteStreams.set(peerId, stream);
    const pc = peerConnections.get(peerId);
    if (pc && profile) pc.profile = profile;
    if (profile) knownPeers.set(peerId, { ...(knownPeers.get(peerId) || {}), ...displayNameForProfile(profile) });
    if (callbacks.onRemoteStream) callbacks.onRemoteStream(peerId, stream, profile || pc?.profile || {});
    notifyParticipants();
  }

  function createSocket() {
    if (socket) return socket;
    if (typeof window.io !== 'function') {
      throw new Error('The realtime connection could not start. Reload Neighborly and try again.');
    }

    socket = window.io({ autoConnect: true, transports: ['websocket', 'polling'] });
    socket.on('voice:peers', ({ peers = [] } = {}) => {
      peers.forEach((peer) => {
        if (!peer.id || peer.id === socket.id) return;
        knownPeers.set(peer.id, { ...displayNameForProfile(peer), ...(peer.state || {}) });
        connectToPeer(peer, true).catch((error) => emitNotice(error.message, true));
      });
      notifyParticipants();
    });
    socket.on('voice:peer-joined', ({ peer } = {}) => {
      if (!peer?.id || peer.id === socket.id) return;
      knownPeers.set(peer.id, { ...displayNameForProfile(peer), ...(peer.state || {}) });
      if (callbacks.onPeerJoined) callbacks.onPeerJoined(peer);
      notifyParticipants();
    });
    socket.on('voice:peer-state', ({ peerId, state } = {}) => {
      if (!peerId || !state) return;
      knownPeers.set(peerId, { ...(knownPeers.get(peerId) || {}), ...state });
      notifyParticipants();
    });
    socket.on('voice:peer-left', ({ peerId } = {}) => {
      if (peerId) closePeer(peerId);
    });
    socket.on('webrtc:offer', ({ from, offer, profile } = {}) => {
      if (from && offer) handleOffer(from, offer, profile).catch((error) => emitNotice(error.message, true));
    });
    socket.on('webrtc:answer', ({ from, answer } = {}) => {
      if (from && answer) handleAnswer(from, answer).catch((error) => emitNotice(error.message, true));
    });
    socket.on('webrtc:ice-candidate', ({ from, candidate } = {}) => {
      if (from && candidate) addIceCandidate(from, candidate).catch(() => {});
    });
    socket.on('connect_error', () => emitNotice('Could not connect to the voice service. Check your connection.', true));
    return socket;
  }

  async function waitForSocket() {
    const activeSocket = createSocket();
    if (activeSocket.connected) return activeSocket;
    if (connectPromise) return connectPromise;

    connectPromise = new Promise((resolve, reject) => {
      const finish = (error, result) => {
        clearTimeout(timeout);
        activeSocket.off('connect', onConnect);
        activeSocket.off('connect_error', onError);
        connectPromise = null;
        if (error) reject(error);
        else resolve(result);
      };
      const onConnect = () => finish(null, activeSocket);
      const onError = (error) => finish(error || new Error('Could not connect to the voice service.'));
      const timeout = setTimeout(() => finish(new Error('Timed out connecting to the voice service.')), 10000);
      activeSocket.once('connect', onConnect);
      activeSocket.once('connect_error', onError);
      activeSocket.connect();
    });
    return connectPromise;
  }

  async function ensureAudioInput(muted = true) {
    if (localAudioStream?.getAudioTracks().some((track) => track.readyState === 'live')) {
      localAudioStream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
      return localAudioStream;
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access is not available in this browser.');

    localAudioStream = await navigator.mediaDevices.getUserMedia({
      // Echo cancellation is what stops hearing yourself through the speakers,
      // so it is requested explicitly (some devices ignore the default) and
      // pinned to mono, which removes most of the remaining feedback loop.
      audio: {
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true },
        channelCount: { ideal: 1 },
      },
      video: false
    });
    localAudioStream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    if (callbacks.onLocalStream) callbacks.onLocalStream(getLocalPreviewStream());
    return localAudioStream;
  }

  /**
   * The local preview stream is VIDEO ONLY.
   *
   * It exists purely to draw your own camera tile. Including the microphone
   * track here meant any element that ever rendered it unmuted would play your
   * mic back into the room and be picked up again — the echo that got worse
   * the longer the call ran. The audio track is sent over the peer connection
   * instead, never through a preview element.
   */
  function getLocalPreviewStream() {
    const tracks = screenStream?.getVideoTracks() || cameraStream?.getVideoTracks() || [];
    return new MediaStream(tracks);
  }

  function getOrCreatePeer(peerId, profile = {}) {
    let pc = peerConnections.get(peerId);
    if (pc) {
      pc.profile = { ...pc.profile, ...displayNameForProfile(profile) };
      return pc;
    }

    pc = new RTCPeerConnection(rtcConfig);
    pc.profile = displayNameForProfile(profile);
    const audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
    const audioTrack = localAudioStream?.getAudioTracks()[0];
    const videoTrack = screenStream?.getVideoTracks()[0] || cameraStream?.getVideoTracks()[0];
    if (audioTrack) audioTransceiver.sender.replaceTrack(audioTrack).catch(() => {});
    if (videoTrack) videoTransceiver.sender.replaceTrack(videoTrack).catch(() => {});

    pc.onicecandidate = (event) => {
      if (event.candidate && socket?.connected) {
        socket.emit('webrtc:ice-candidate', { to: peerId, channel: activeChannel, candidate: event.candidate });
      }
    };
    pc.ontrack = (event) => {
      if (event.track.kind === 'audio') event.track.enabled = !isDeafened;
      let stream = event.streams?.[0];
      if (!stream) {
        stream = remoteStreams.get(peerId) || new MediaStream();
        if (!stream.getTracks().some((track) => track.id === event.track.id)) stream.addTrack(event.track);
      }
      updateRemoteStream(peerId, stream, pc.profile);
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) closePeer(peerId);
    };

    peerConnections.set(peerId, pc);
    return pc;
  }

  async function connectToPeer(peer, shouldOffer = false) {
    const peerId = typeof peer === 'string' ? peer : peer.id;
    if (!peerId || peerId === socket?.id) return null;
    const profile = typeof peer === 'string' ? {} : peer;
    const pc = getOrCreatePeer(peerId, profile);
    if (shouldOffer && !pc.localDescription) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('webrtc:offer', {
        to: peerId,
        channel: activeChannel,
        offer: pc.localDescription,
        profile: displayNameForProfile(localProfile)
      });
    }
    return pc;
  }

  async function handleOffer(peerId, offer, profile = {}) {
    const pc = getOrCreatePeer(peerId, profile);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await flushCandidates(peerId, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc:answer', {
      to: peerId,
      channel: activeChannel,
      answer: pc.localDescription,
      profile: displayNameForProfile(localProfile)
    });
  }

  async function handleAnswer(peerId, answer) {
    const pc = peerConnections.get(peerId);
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    await flushCandidates(peerId, pc);
  }

  async function addIceCandidate(peerId, candidate) {
    const pc = peerConnections.get(peerId);
    if (!pc || !pc.remoteDescription) {
      if (!queuedCandidates.has(peerId)) queuedCandidates.set(peerId, []);
      queuedCandidates.get(peerId).push(candidate);
      return;
    }
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  async function flushCandidates(peerId, pc) {
    const candidates = queuedCandidates.get(peerId) || [];
    queuedCandidates.delete(peerId);
    for (const candidate of candidates) await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  async function joinVoiceChannel(channel, profile, options = {}) {
    const nextChannel = String(channel);
    if (activeChannel && activeChannel !== nextChannel) await leaveVoiceChannel();
    activeChannel = nextChannel;
    localProfile = displayNameForProfile(profile);
    callbacks = options;
    await loadConfiguredIceServers();
    const activeSocket = await waitForSocket();
    try {
      await ensureAudioInput(options.muted !== false);
    } catch (error) {
      emitNotice(`Joined listen-only: ${error.message}`, true);
    }
    activeSocket.emit('register-user', { user: { ...localProfile, id: profile?.uid || profile?.id } });
    activeSocket.emit('voice:join', {
      channel: activeChannel,
      user: localProfile,
      state: { micMuted: options.muted !== false, deafened: options.deafened === true, cameraEnabled: false, screenSharing: false }
    });
    return { connected: true, hasMicrophone: !!localAudioStream };
  }

  function updateVoiceState(state = {}) {
    if (!socket?.connected || !activeChannel) return;
    socket.emit('voice:state', { channel: activeChannel, state });
  }

  async function setMicrophoneMuted(muted) {
    let track = localAudioStream?.getAudioTracks().find((item) => item.readyState === 'live');
    if (!muted && !track && activeChannel) {
      await ensureAudioInput(false);
      track = localAudioStream?.getAudioTracks()[0];
      if (track) {
        await Promise.all(Array.from(peerConnections.values()).map((pc) => {
        const transceiver = findAudioTransceiver(pc);
        return transceiver ? transceiver.sender.replaceTrack(track) : Promise.resolve();
      }));
      }
    }
    localAudioStream?.getAudioTracks().forEach((item) => { item.enabled = !muted; });
    return !!localAudioStream?.getAudioTracks().some((item) => item.enabled);
  }

  function setDeafened(deafened) {
    isDeafened = !!deafened;
    peerConnections.forEach((pc) => {
      pc.getReceivers().forEach((receiver) => {
        if (receiver.track?.kind === 'audio') receiver.track.enabled = !isDeafened;
      });
    });
    if (callbacks.onDeafened) callbacks.onDeafened(deafened);
  }

  async function applyShareBitrate(sender, preset) {
    if (!preset || !sender.getParameters || !sender.setParameters) return;
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) return;
    parameters.encodings[0].maxBitrate = preset.maxBitrate;
    try { await sender.setParameters(parameters); } catch { /* Some browsers lock display-capture encoding controls. */ }
  }

  /**
   * Finds the video transceiver on a connection.
   *
   * Matching only on `receiver.track.kind` fails before negotiation in some
   * browsers, which is why turning the camera on appeared to do nothing: the
   * track was never attached to a sender. Try both ends, then the sender list.
   */
  function findVideoTransceiver(pc) {
    const transceivers = pc.getTransceivers();
    const match = transceivers.find(
      (item) => item.receiver?.track?.kind === 'video' || item.sender?.track?.kind === 'video'
    );
    if (match) return match;
    const direction = transceivers.find((item) => item.direction?.includes('video'));
    if (direction) return direction;
    // Last resort: rebuild the transceiver list from the senders.
    return transceivers.find((item) => pc.getSenders().includes(item.sender) && item.sender.track?.kind === 'video') || null;
  }

  function findAudioTransceiver(pc) {
    const transceivers = pc.getTransceivers();
    return (
      transceivers.find((item) => item.receiver?.track?.kind === 'audio' || item.sender?.track?.kind === 'audio') ||
      null
    );
  }

  /**
   * Keeps the outgoing video sender alive.
   *
   * Without an explicit degradation preference and bitrate cap, browsers can
   * stall a video track instead of scaling it down, which shows up as a frozen
   * picture rather than a dropped one.
   */
  async function tuneVideoSender(sender, track, preset) {
    if (!sender) return;
    if (track) {
      // 'motion' for camera (drops frames under pressure), 'detail' for text.
      if ('contentHint' in track) track.contentHint = preset ? 'detail' : 'motion';
    }
    if (!sender.getParameters || !sender.setParameters) return;
    try {
      const parameters = sender.getParameters();
      parameters.degradationPreference = 'balanced';
      if (parameters.encodings?.length) {
        parameters.encodings[0].degradationPreference = 'balanced';
        // Cap the camera so a weak uplink downscales instead of freezing.
        parameters.encodings[0].maxBitrate = preset
          ? preset.maxBitrate
          : Math.min(parameters.encodings[0].maxBitrate || Infinity, 1200000);
        parameters.encodings[0].maxFramerate = preset ? preset.fps : 30;
      }
      await sender.setParameters(parameters);
    } catch { /* Encoding parameters are best-effort across browsers. */ }
  }

  async function replaceOutgoingVideoTrack(track) {
    const preset = track && screenStream ? sharePresets[callbacks.quality || '720p30'] : null;
    await Promise.all(Array.from(peerConnections.values()).map(async (pc) => {
      const transceiver = findVideoTransceiver(pc);
      if (!transceiver) return;
      // A transceiver can end up send-only after renegotiation, which silently
      // stops the camera reaching the other person.
      if (!String(transceiver.direction || '').includes('send')) {
        try { transceiver.direction = 'sendrecv'; } catch { /* Some browsers lock this. */ }
      }
      await transceiver.sender.replaceTrack(track || null);
      await tuneVideoSender(transceiver.sender, track, preset);
    }));
    if (callbacks.onLocalStream) callbacks.onLocalStream(getLocalPreviewStream());
  }

  async function toggleCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
      await replaceOutgoingVideoTrack(screenStream?.getVideoTracks()[0] || null);
      return false;
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is not available in this browser.');
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
    });
    if (!screenStream) await replaceOutgoingVideoTrack(cameraStream.getVideoTracks()[0]);
    else if (callbacks.onLocalStream) callbacks.onLocalStream(getLocalPreviewStream());
    return true;
  }

  async function startScreenShare(quality = '720p30') {
    if (screenStream) return true;
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen sharing is not supported in this browser.');
    const preset = sharePresets[quality] || sharePresets['720p30'];
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    callbacks.quality = quality;
    const track = screenStream.getVideoTracks()[0];
    if (!track) {
      screenStream.getTracks().forEach((item) => item.stop());
      screenStream = null;
      throw new Error('No screen or window was selected.');
    }
    track.contentHint = 'detail';
    try {
      await track.applyConstraints({
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: preset.fps, max: preset.fps }
      });
    } catch { /* Keep native capture size if the browser rejects scaling. */ }
    track.addEventListener('ended', () => stopScreenShare(), { once: true });
    await replaceOutgoingVideoTrack(track);
    if (callbacks.onScreenShare) callbacks.onScreenShare(true, quality);
    return true;
  }

  async function setScreenShareQuality(quality) {
    const preset = sharePresets[quality];
    if (!preset) throw new Error('Choose a supported screen-share quality.');
    callbacks.quality = quality;
    const track = screenStream?.getVideoTracks()[0];
    if (!track) return false;
    try {
      await track.applyConstraints({
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: preset.fps, max: preset.fps }
      });
    } catch { /* Browser capture constraints are best-effort. */ }
    await Promise.all(Array.from(peerConnections.values()).map((pc) => {
      const sender = pc.getSenders().find((item) => item.track?.kind === 'video');
      return sender ? applyShareBitrate(sender, preset) : Promise.resolve();
    }));
    return true;
  }

  async function stopScreenShare() {
    if (!screenStream) return false;
    const stream = screenStream;
    screenStream = null;
    stream.getTracks().forEach((track) => track.stop());
    await replaceOutgoingVideoTrack(cameraStream?.getVideoTracks()[0] || null);
    if (callbacks.onScreenShare) callbacks.onScreenShare(false, null);
    return false;
  }

  function closePeer(peerId) {
    const pc = peerConnections.get(peerId);
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
      peerConnections.delete(peerId);
    }
    remoteStreams.delete(peerId);
    knownPeers.delete(peerId);
    queuedCandidates.delete(peerId);
    if (callbacks.onPeerLeft) callbacks.onPeerLeft(peerId);
    notifyParticipants();
  }

  async function leaveVoiceChannel() {
    if (socket?.connected && activeChannel) socket.emit('voice:leave', { channel: activeChannel });
    peerConnections.forEach((pc) => pc.close());
    peerConnections.clear();
    remoteStreams.clear();
    knownPeers.clear();
    queuedCandidates.clear();
    [screenStream, cameraStream, localAudioStream].forEach((stream) => stream?.getTracks().forEach((track) => track.stop()));
    screenStream = null;
    cameraStream = null;
    localAudioStream = null;
    activeChannel = null;
    isDeafened = false;
    if (callbacks.onParticipants) callbacks.onParticipants([]);
    if (callbacks.onLocalStream) callbacks.onLocalStream(null);
    if (callbacks.onScreenShare) callbacks.onScreenShare(false, null);
  }

  function getLocalStream() {
    return getLocalPreviewStream();
  }

  return {
    joinVoiceChannel,
    leaveVoiceChannel,
    setMicrophoneMuted,
    setDeafened,
    updateVoiceState,
    toggleCamera,
    startScreenShare,
    setScreenShareQuality,
    stopScreenShare,
    getLocalStream,
    getRemoteStreams: () => new Map(remoteStreams),
    isScreenSharing: () => !!screenStream,
    isCameraEnabled: () => !!cameraStream,
    sharePresets
  };
})();