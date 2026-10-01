const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
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

/** Records every dm:message this socket receives for the rest of the test. */
function watchDms(socket) {
  const received = [];
  socket.on('dm:message', (message) => received.push(message));
  return received;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const port = await reservePort();
  const url = `http://127.0.0.1:${port}`;
  const serverProcess = spawn(process.execPath, ['BACKEND/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      // Force the durable file backend so DM history is actually stored.
      NEIGHBORLY_PERSISTENCE: 'file',
      DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'neighborly-dm-')),
    },
    stdio: 'ignore',
  });
  const clients = [];

  try {
    await waitForServer(url, serverProcess);
    const alice = createClient(url, { transports: ['websocket'] });
    const bob = createClient(url, { transports: ['websocket'] });
    const eve = createClient(url, { transports: ['websocket'] });
    clients.push(alice, bob, eve);
    await Promise.all([
      waitForEvent(alice, 'connect'),
      waitForEvent(bob, 'connect'),
      waitForEvent(eve, 'connect'),
    ]);

    await register(alice, { id: 'a1', name: 'Alice Tester', handle: 'alice', email: 'alice@example.com' });
    await register(bob, { id: 'b1', name: 'Bob Tester', handle: 'bob', email: 'bob@example.com' });
    await register(eve, { id: 'e1', name: 'Eve Tester', handle: 'eve', email: 'eve@example.com' });

    // Eve is not a friend of Alice: she must not be able to DM her at all.
    const eveDenied = waitForEvent(eve, 'dm:error');
    eve.emit('dm:send', { to: 'alice', text: 'let me in' });
    assert.match((await eveDenied).message, /only message friends/i, 'Non-friends cannot DM');

    // Make Alice and Bob friends.
    const aliceHasBob = waitForFriendState(alice, (s) => s.friends.some((f) => f.handle === 'bob'));
    const bobHasAlice = waitForFriendState(bob, (s) => s.friends.some((f) => f.handle === 'alice'));
    alice.emit('friend:request', { to: 'bob' });
    await waitForFriendState(bob, (s) => s.incoming.some((r) => r.handle === 'alice'));
    bob.emit('friend:respond', { from: 'alice', accept: true });
    await Promise.all([aliceHasBob, bobHasAlice]);

    // Watch every socket for leaks from here on.
    const aliceDms = watchDms(alice);
    const bobDms = watchDms(bob);
    const eveDms = watchDms(eve);

    // Alice opens the conversation; both are placed in the same private room.
    const firstOpen = waitForEvent(alice, 'dm:history');
    alice.emit('dm:open', { to: 'bob' });
    const opened = await firstOpen;
    assert.strictEqual(opened.conversationKey, 'alice:bob', 'Room key is the sorted handle pair');
    assert.strictEqual(opened.peer.handle, 'bob', 'History carries the peer profile');

    // Alice sends. Bob must receive it; Eve must not.
    const bobGot = waitForEvent(bob, 'dm:message');
    alice.emit('dm:send', { to: 'bob', text: 'this is private', clientMessageId: 'dm-1' });
    const delivered = await bobGot;
    assert.strictEqual(delivered.text, 'this is private', 'The recipient receives the DM');
    assert.strictEqual(delivered.sender, 'alice', 'The sender is attributed correctly');

    await pause(300);
    assert.strictEqual(eveDms.length, 0, 'A third party must never receive a DM');

    // Bob replies, proving both directions work.
    const aliceGotReply = waitForEvent(alice, 'dm:message');
    bob.emit('dm:send', { to: 'alice', text: 'got it', clientMessageId: 'dm-2' });
    assert.strictEqual((await aliceGotReply).text, 'got it', 'Replies flow back to the sender');

    // History is replayed from the store when reopening the conversation.
    const reopen = waitForEvent(alice, 'dm:history');
    alice.emit('dm:open', { to: 'bob' });
    const replay = await reopen;
    assert.strictEqual(replay.messages.length, 2, 'Reopening replays stored history');
    assert.deepStrictEqual(
      replay.messages.map((m) => m.text),
      ['this is private', 'got it'],
      'History is returned in order'
    );

    await pause(200);
    assert.strictEqual(eveDms.length, 0, 'Reopening must not leak the conversation either');
    assert.ok(aliceDms.length >= 1 && bobDms.length >= 1, 'Both participants stay in the room');

    console.log('DM privacy tests passed.');
  } finally {
    clients.forEach((client) => client.close());
    serverProcess.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});