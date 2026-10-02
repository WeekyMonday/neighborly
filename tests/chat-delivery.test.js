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

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const port = await reservePort();
  const url = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neighborly-chat-'));
  const serverProcess = spawn(process.execPath, ['BACKEND/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NEIGHBORLY_PERSISTENCE: 'file',
      DATA_DIR: dataDir,
    },
    stdio: 'ignore',
  });
  const clients = [];

  try {
    await waitForServer(url, serverProcess);
    const alice = createClient(url, { transports: ['websocket'] });
    const bob = createClient(url, { transports: ['websocket'] });
    clients.push(alice, bob);
    await Promise.all([waitForEvent(alice, 'connect'), waitForEvent(bob, 'connect')]);

    await register(alice, { id: 'a1', name: 'Alice', handle: 'alice', email: 'alice@example.com' });
    await register(bob, { id: 'b1', name: 'Bob', handle: 'bob', email: 'bob@example.com' });

    const bobHasAlice = waitForFriendState(bob, (s) => s.friends.some((f) => f.handle === 'alice'));
    alice.emit('friend:request', { to: 'bob' });
    await waitForFriendState(bob, (s) => s.incoming.some((r) => r.handle === 'alice'));
    bob.emit('friend:respond', { from: 'alice', accept: true });
    await bobHasAlice;

    // ---- 1. A DM arrives even when the recipient never opened the chat ----
    const bobReceives = waitForEvent(bob, 'dm:message');
    alice.emit('dm:send', { to: 'bob', text: 'you never opened this', clientMessageId: 'dm-late' });
    const late = await bobReceives;
    assert.strictEqual(late.text, 'you never opened this', 'A DM reaches a recipient who has not opened the chat');
    assert.strictEqual(late.conversationKey, 'alice:bob', 'It lands in the right conversation');

    // ---- 2. History survives closing and reopening the conversation ----
    alice.emit('dm:send', { to: 'bob', text: 'first', clientMessageId: 'dm-1' });
    alice.emit('dm:send', { to: 'bob', text: 'second', clientMessageId: 'dm-2' });
    await pause(300);

    // Bob closes the chat (a client-side action), then reopens it.
    const reopened = waitForEvent(bob, 'dm:history');
    bob.emit('dm:open', { to: 'alice' });
    const history = await reopened;
    const texts = history.messages.map((m) => m.text);
    assert.ok(texts.includes('first'), 'Reopening the chat still shows the first message');
    assert.ok(texts.includes('second'), 'Reopening the chat still shows the second message');
    assert.ok(texts.includes('you never opened this'), 'Messages sent while closed are in the history');
    assert.ok(
      history.messages.every((m, i, arr) => i === 0 || arr[i - 1].createdAt <= m.createdAt),
      'History comes back in chronological order'
    );

    // The server tells the client the conversation has been read.
    const cleared = waitForEvent(bob, 'dm:unread-clear');
    bob.emit('dm:open', { to: 'alice' });
    assert.strictEqual((await cleared).conversationKey, 'alice:bob', 'Opening clears the unread flag');

    // ---- 3. DM feature parity with #general: media, replies, deletes ----
    const PHOTO = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const VIDEO = { url: 'data:video/mp4;base64,AAAA', type: 'video', name: 'clip.mp4' };

    // A photo/GIF.
    const bobGetsPhoto = waitForEvent(bob, 'dm:message');
    alice.emit('dm:send', {
      to: 'bob', text: '', clientMessageId: 'dm-photo',
      attachment: { url: PHOTO, type: 'image', name: 'sticker.gif' },
    });
    const photo = await bobGetsPhoto;
    assert.ok(photo.attachment, 'A photo/GIF is delivered to the recipient');
    assert.strictEqual(photo.attachment.type, 'image', 'The attachment keeps its type');
    assert.strictEqual(photo.text, '', 'A media-only message can have no text');

    // A video.
    const bobGetsVideo = waitForEvent(bob, 'dm:message');
    alice.emit('dm:send', {
      to: 'bob', text: 'look', clientMessageId: 'dm-video', attachment: VIDEO,
    });
    const video = await bobGetsVideo;
    assert.strictEqual(video.attachment.type, 'video', 'A video is delivered');
    assert.strictEqual(video.attachment.name, 'clip.mp4', 'The video keeps its filename');

    // A reply quoting an earlier message.
    const bobGetsReply = waitForEvent(bob, 'dm:message');
    alice.emit('dm:send', {
      to: 'bob', text: 'agreed', clientMessageId: 'dm-reply',
      replyTo: { msgId: 'dm-photo', author: 'Bob', text: 'nice' },
    });
    const reply = await bobGetsReply;
    assert.ok(reply.replyTo, 'The reply reference is delivered');
    assert.strictEqual(reply.replyTo.author, 'Bob', 'The reply names who was replied to');
    assert.strictEqual(reply.replyTo.text, 'nice', 'The reply keeps the quoted text');

    // History keeps the media and the reply after a reload.
    const afterFeatures = waitForEvent(bob, 'dm:history');
    bob.emit('dm:open', { to: 'alice' });
    const featureHistory = await afterFeatures;
    const photoMessage = featureHistory.messages.find((m) => m.id === 'dm-photo');
    assert.ok(photoMessage && photoMessage.attachment, 'Attachments survive in history');
    const replyMessage = featureHistory.messages.find((m) => m.id === 'dm-reply');
    assert.ok(replyMessage && replyMessage.replyTo, 'Replies survive in history');

    // Deleting a message removes it for both people.
    const bobSawDelete = waitForEvent(bob, 'dm:deleted');
    alice.emit('dm:delete', { to: 'bob', messageId: 'dm-photo' });
    const deleted = await bobSawDelete;
    assert.strictEqual(deleted.messageId, 'dm-photo', 'The delete is broadcast to the pair');
    assert.strictEqual(deleted.conversationKey, 'alice:bob', 'The delete names the conversation');

    // A third party still cannot see any of it.
    const eve = createClient(url, { transports: ['websocket'] });
    clients.push(eve);
    await waitForEvent(eve, 'connect');
    await register(eve, { id: 'e1', name: 'Eve', handle: 'eve', email: 'eve@example.com' });
    let leaked = false;
    eve.on('dm:message', () => { leaked = true; });
    alice.emit('dm:send', { to: 'bob', text: 'still private', clientMessageId: 'dm-priv' });
    await pause(300);
    assert.strictEqual(leaked, false, 'A non-friend never receives any of this');

    // ---- 4. Server channel chat works like a DM ----
    const CHANNEL = 'srv:server-1:chan:general';
    const joined = waitForEvent(alice, 'chat:history');
    alice.emit('join-channel', { channel: CHANNEL, serverId: 'server-1', channelId: 'general' });
    const initialHistory = await joined;
    assert.strictEqual(initialHistory.channel, CHANNEL, 'Joining acknowledges the channel');
    assert.deepStrictEqual(initialHistory.messages, [], 'A new channel starts empty');

    bob.emit('join-channel', { channel: CHANNEL, serverId: 'server-1', channelId: 'general' });
    await pause(200);

    // A message sent by Alice must reach Bob in the channel.
    const bobSeesChannel = waitForEvent(bob, 'chat:message');
    alice.emit('chat:send', { channel: CHANNEL, author: 'Alice', text: 'hello channel', clientMessageId: 'c-1' });
    const channelMessage = await bobSeesChannel;
    assert.strictEqual(channelMessage.text, 'hello channel', 'Channel messages reach other members');
    assert.strictEqual(channelMessage.channel, CHANNEL, 'The channel message is tagged with its channel');

    // Alice sees her own echo exactly once (same id, no duplicate).
    const aliceEchoes = [];
    alice.on('chat:message', (m) => aliceEchoes.push(m));
    alice.emit('chat:send', { channel: CHANNEL, author: 'Alice', text: 'second line', clientMessageId: 'c-2' });
    await pause(400);
    assert.strictEqual(
      aliceEchoes.filter((m) => m.id === 'c-2').length,
      1,
      'The sender receives their own message exactly once'
    );

    // ---- 4. Channel history is stored and replayed ----
    const replay = waitForEvent(bob, 'chat:history');
    bob.emit('join-channel', { channel: CHANNEL, serverId: 'server-1', channelId: 'general' });
    const replayed = await replay;
    const channelTexts = replayed.messages.map((m) => m.text);
    assert.ok(channelTexts.includes('hello channel'), 'Channel history is replayed when reopening');
    assert.ok(channelTexts.includes('second line'), 'The newest channel message is replayed too');

    // ---- 5. History survives a server restart ----
    serverProcess.kill();
    await pause(700);

    const restart = spawn(process.execPath, ['BACKEND/server.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PORT: String(port), NEIGHBORLY_PERSISTENCE: 'file', DATA_DIR: dataDir },
      stdio: 'ignore',
    });
    try {
      await waitForServer(url, restart);
      const carol = createClient(url, { transports: ['websocket'] });
      clients.push(carol);
      await waitForEvent(carol, 'connect');
      await register(carol, { id: 'c9', name: 'Carol', handle: 'carol', email: 'carol@example.com' });

      const afterRestart = waitForEvent(carol, 'chat:history');
      carol.emit('join-channel', { channel: CHANNEL, serverId: 'server-1', channelId: 'general' });
      const restored = await afterRestart;
      const restoredTexts = restored.messages.map((m) => m.text);
      assert.ok(restoredTexts.includes('hello channel'), 'Channel history survives a server restart');
      assert.ok(restoredTexts.includes('second line'), 'The newest channel message survives too');
    } finally {
      restart.kill();
    }

    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log('Chat delivery tests passed.');
  } finally {
    clients.forEach((client) => client.close());
    serverProcess.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});