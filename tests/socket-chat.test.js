const assert = require('assert');
const { createRealtimeStore } = require('../BACKEND/socketManager');

const store = createRealtimeStore();

const userA = { id: 'u1', name: 'Alice', email: 'alice@example.com', handle: 'alice' };
const userB = { id: 'u2', name: 'Bob', email: 'bob@example.com', handle: 'bob' };

store.registerUser(userA);
store.registerUser(userB);

assert.strictEqual(store.getOnlineUsers().length, 2, 'Two users should be registered');
assert.strictEqual(store.getOnlineUsers()[0].name, 'Alice', 'First registered user should be Alice');

const msg = store.addMessage({ channel: 'general', author: 'Alice', text: 'Hello everybody!' });
assert.strictEqual(msg.text, 'Hello everybody!', 'Message should preserve text content');

// getMessages reads from the durable store, so it is asynchronous.
store.getMessages('general').then((messages) => {
  assert.strictEqual(messages.length, 1, 'One message should be stored for the channel');
  assert.strictEqual(messages[0].author, 'Alice', 'The stored message keeps its author');
  assert.strictEqual(messages[0].channel, 'general', 'The stored message keeps its channel');
  console.log('Socket chat store tests passed.');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
