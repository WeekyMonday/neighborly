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
    const alice = createClient(url, { transports: ['websocket'] });
    const bob = createClient(url, { transports: ['websocket'] });
    clients.push(alice, bob);
    await Promise.all([waitForEvent(alice, 'connect'), waitForEvent(bob, 'connect')]);

    const aliceState = await register(alice, { id: 'a1', name: 'Alice Tester', email: 'alice@example.com', handle: 'alice' });
    const bobState = await register(bob, { id: 'b1', name: 'Bob Tester', email: 'bob@example.com', handle: 'bob' });
    assert.strictEqual(aliceState.friends.length, 0, 'New users start with no friends');
    assert.strictEqual(bobState.friends.length, 0, 'New users start with no friends');

    const bobIncoming = waitForFriendState(bob, (state) => state.incoming.some((request) => request.handle === 'alice'));
    const aliceOutgoing = waitForFriendState(alice, (state) => state.outgoing.some((request) => request.handle === 'bob'));
    const bobNotice = waitForEvent(bob, 'friend:notice');
    alice.emit('friend:request', { to: 'bob' });

    assert.strictEqual((await aliceOutgoing).outgoing[0].handle, 'bob', 'Sender sees an outgoing request');
    assert.strictEqual((await bobIncoming).incoming[0].handle, 'alice', 'Recipient sees an incoming request');
    assert.match((await bobNotice).message, /sent you a friend request/, 'Recipient gets a notice');

    const aliceFriends = waitForFriendState(alice, (state) => state.friends.some((friend) => friend.handle === 'bob'));
    const bobFriends = waitForFriendState(bob, (state) => state.friends.some((friend) => friend.handle === 'alice'));
    const aliceAcceptNotice = waitForEvent(alice, 'friend:notice');
    bob.emit('friend:respond', { from: 'alice', accept: true });

    assert.strictEqual((await aliceFriends).friends[0].name, 'Bob Tester', 'Sender becomes a friend');
    assert.strictEqual((await bobFriends).friends[0].name, 'Alice Tester', 'Recipient becomes a friend');
    assert.match((await aliceAcceptNotice).message, /accepted your friend request/, 'Sender is told the request was accepted');

    // Unknown users produce a friendly error instead of a silent failure.
    const unknownError = waitForEvent(bob, 'friend:error');
    bob.emit('friend:request', { to: 'nobody-here' });
    assert.match((await unknownError).message, /could not find/i, 'Unknown handles return an error notice');

    // Ignoring a request clears it from the pending list.
    const carol = createClient(url, { transports: ['websocket'] });
    clients.push(carol);
    await waitForEvent(carol, 'connect');
    await register(carol, { id: 'c1', name: 'Carol Tester', email: 'carol@example.com', handle: 'carol' });

    const aliceHasCarol = waitForFriendState(alice, (state) => state.incoming.some((request) => request.handle === 'carol'));
    carol.emit('friend:request', { to: 'alice' });
    await aliceHasCarol;

    const aliceCleared = waitForFriendState(alice, (state) => !state.incoming.some((request) => request.handle === 'carol'));
    alice.emit('friend:respond', { from: 'carol', accept: false });
    await aliceCleared;

    console.log('Friend request signaling tests passed.');
  } finally {
    clients.forEach((client) => client.close());
    serverProcess.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
