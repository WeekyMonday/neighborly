const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { io: createClient } = require('socket.io-client');

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const onEvent = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, onEvent);
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Backend exited with code ${child.exitCode}`);
    try {
      await new Promise((resolve, reject) => {
        const request = http.get(`${url}/api`, (response) => {
          response.resume();
          response.statusCode === 200 ? resolve() : reject(new Error('Backend not ready'));
        });
        request.on('error', reject);
        request.setTimeout(500, () => request.destroy());
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('Backend did not start in time');
}

async function main() {
  const port = await reservePort();
  const url = `http://127.0.0.1:${port}`;
  const cwd = path.resolve(__dirname, '..');
  const serverProcess = spawn(process.execPath, ['BACKEND/server.js'], {
    cwd,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore'
  });
  const clients = [];

  try {
    await waitForServer(url, serverProcess);
    const first = createClient(url, { transports: ['websocket'] });
    const second = createClient(url, { transports: ['websocket'] });
    clients.push(first, second);
    await Promise.all([waitForEvent(first, 'connect'), waitForEvent(second, 'connect')]);

    const firstRoster = waitForEvent(first, 'voice:peers');
    first.emit('voice:join', {
      channel: 'server:test:voice-room',
      user: { name: 'First tester', handle: 'first' },
      state: { micMuted: true }
    });
    assert.strictEqual((await firstRoster).peers.length, 0, 'The first voice participant starts alone');

    const firstPeerJoined = waitForEvent(first, 'voice:peer-joined');
    const secondRoster = waitForEvent(second, 'voice:peers');
    second.emit('voice:join', {
      channel: 'server:test:voice-room',
      user: { name: 'Second tester', handle: 'second' },
      state: { micMuted: false }
    });
    const roster = await secondRoster;
    assert.strictEqual(roster.peers.length, 1, 'New participant receives the current voice roster');
    assert.strictEqual(roster.peers[0].name, 'First tester');
    assert.strictEqual((await firstPeerJoined).peer.name, 'Second tester');

    const stateUpdate = waitForEvent(first, 'voice:peer-state');
    second.emit('voice:state', { channel: 'server:test:voice-room', state: { micMuted: true, deafened: true } });
    assert.deepStrictEqual((await stateUpdate).state, {
      micMuted: true,
      deafened: true,
      cameraEnabled: false,
      screenSharing: false
    });

    const offerEvent = waitForEvent(first, 'webrtc:offer');
    second.emit('webrtc:offer', {
      to: first.id,
      channel: 'server:test:voice-room',
      offer: { type: 'offer', sdp: 'test-sdp' }
    });
    assert.strictEqual((await offerEvent).from, second.id, 'WebRTC offers relay to peers in the same voice room');

    const peerLeft = waitForEvent(first, 'voice:peer-left');
    second.emit('voice:leave', { channel: 'server:test:voice-room' });
    assert.strictEqual((await peerLeft).peerId, second.id);

    console.log('Voice-room signaling tests passed.');
  } finally {
    clients.forEach((client) => client.close());
    serverProcess.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
