const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { io: createClient } = require('socket.io-client');

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
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

function waitForFriendState(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('friend:state', onState);
      reject(new Error('Timed out waiting for a matching friend:state'));
    }, timeoutMs);
    const onState = (state) => {
      if (!state || !predicate(state)) return;
      clearTimeout(timer);
      socket.off('friend:state', onState);
      resolve(state);
    };
    socket.on('friend:state', onState);
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

function register(socket, user) {
  socket.emit('register-user', { user });
  return waitForFriendState(socket, (state) => state.handle === user.handle.toLowerCase());
}

// A 1x1 transparent GIF, standing in for an uploaded profile photo.
const TINY_PHOTO =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

async function main() {
  const port = await reservePort();
  const url = `http://127.0.0.1:${port}`;
  const serverProcess = spawn(process.execPath, ['BACKEND/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NEIGHBORLY_PERSISTENCE: 'file',
      DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'neighborly-profile-')),
    },
    stdio: 'ignore',
  });
  const clients = [];

  try {
    await waitForServer(url, serverProcess);
    const alice = createClient(url, { transports: ['websocket'] });
    const bob = createClient(url, { transports: ['websocket'] });
    const carol = createClient(url, { transports: ['websocket'] });
    clients.push(alice, bob, carol);
    await Promise.all([
      waitForEvent(alice, 'connect'),
      waitForEvent(bob, 'connect'),
      waitForEvent(carol, 'connect'),
    ]);

    await register(alice, { id: 'a1', name: 'Alice', handle: 'alice', email: 'alice@example.com' });
    await register(bob, { id: 'b1', name: 'Bob', handle: 'bob', email: 'bob@example.com' });
    await register(carol, { id: 'c1', name: 'Carol', handle: 'carol', email: 'carol@example.com' });

    // Alice and Bob become friends; Carol stays a stranger.
    const aliceHasBob = waitForFriendState(alice, (s) => s.friends.some((f) => f.handle === 'bob'));
    const bobHasAlice = waitForFriendState(bob, (s) => s.friends.some((f) => f.handle === 'alice'));
    alice.emit('friend:request', { to: 'bob' });
    await waitForFriendState(bob, (s) => s.incoming.some((r) => r.handle === 'alice'));
    bob.emit('friend:respond', { from: 'alice', accept: true });
    const [initialAlice, initialBob] = await Promise.all([aliceHasBob, bobHasAlice]);

    assert.ok(!initialBob.friends[0].avatarImage, 'Nobody has a photo to start with');
    assert.strictEqual(initialBob.friends[0].handle, 'alice', 'Bob starts with Alice as a friend');

    // Alice changes her display name and uploads a profile picture.
    const bobSeesChange = waitForFriendState(
      bob,
      (state) => state.friends[0] && state.friends[0].avatarImage === TINY_PHOTO
    );
    const aliceSaved = waitForEvent(alice, 'profile:saved');
    alice.emit('profile:update', {
      name: 'Alice Updated',
      initials: 'AU',
      avatarImage: TINY_PHOTO,
      bio: 'Hello there',
    });

    const saved = await aliceSaved;
    assert.strictEqual(saved.avatarImage, TINY_PHOTO, 'The sender is told their profile saved');
    assert.strictEqual(saved.name, 'Alice Updated', 'The new display name is accepted');

    const updated = await bobSeesChange;
    const friend = updated.friends[0];
    assert.strictEqual(friend.avatarImage, TINY_PHOTO, 'The friend receives the new profile picture');
    assert.strictEqual(friend.name, 'Alice Updated', 'The friend receives the new display name');

    // Carol is not a friend, so she must never receive Alice's profile.
    let carolLeaked = false;
    carol.on('friend:state', (state) => {
      if (JSON.stringify(state).includes('AU') || JSON.stringify(state).includes(TINY_PHOTO)) {
        carolLeaked = true;
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.strictEqual(carolLeaked, false, 'Profile changes are not leaked to non-friends');

    // A profile edit must never rewrite the account handle.
    const bobStillHasAlice = waitForFriendState(bob, (s) => s.friends.some((f) => f.name === 'Renamed'));
    alice.emit('profile:update', { name: 'Renamed', handle: 'hijacked' });
    const afterRename = await bobStillHasAlice;
    const stillAlice = afterRename.friends.find((f) => f.name === 'Renamed');
    assert.strictEqual(stillAlice.handle, 'alice', 'The handle cannot be changed via a profile edit');
    assert.strictEqual(stillAlice.avatarImage, TINY_PHOTO, 'The photo survives a rename');

    // Removing a friend closes the DM and updates both sides.
    const bobLostAlice = waitForFriendState(bob, (s) => !s.friends.some((f) => f.handle === 'alice'));
    const aliceLostBob = waitForFriendState(alice, (s) => !s.friends.some((f) => f.handle === 'bob'));
    alice.emit('friend:remove', { from: 'bob' });
    await Promise.all([bobLostAlice, aliceLostBob]);

    console.log('Profile sync tests passed.');
  } finally {
    clients.forEach((client) => client.close());
    serverProcess.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});