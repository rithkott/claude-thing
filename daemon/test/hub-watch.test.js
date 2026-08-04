// claude.session.watch narrows one socket's claude.session.update stream to a
// single session. Everything else — snapshots, asks, other sockets — must be
// untouched by it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHub } from '../src/hub.js';

function fakeSocket() {
  const sock = new EventEmitter();
  sock.OPEN = 1;
  sock.readyState = 1;
  sock.bufferedAmount = 0;
  sock.frames = [];
  sock.send = (raw) => sock.frames.push(JSON.parse(raw));
  return sock;
}

function connect(hub, role) {
  const sock = fakeSocket();
  hub.wss.emit('connection', sock);
  sock.emit('message', Buffer.from(JSON.stringify({
    type: 'request', id: 'hello', method: 'bridge.hello', params: { role },
  })));
  sock.frames.length = 0; // drop the hello response + bridge.clients noise
  return sock;
}

function watch(sock, id) {
  sock.emit('message', Buffer.from(JSON.stringify({
    type: 'request', id: 'w', method: 'claude.session.watch', params: { id },
  })));
}

function eventsOf(sock, topic) {
  return sock.frames.filter((f) => f.type === 'event' && f.topic === topic);
}

test('a socket that never watches receives every detail', () => {
  const hub = createHub();
  const sock = connect(hub, 'webpage');
  hub.emit('claude.session.update', { id: 'a' });
  hub.emit('claude.session.update', { id: 'b' });
  assert.equal(eventsOf(sock, 'claude.session.update').length, 2);
});

test('a watching socket receives only its session, and the ack', () => {
  const hub = createHub();
  const sock = connect(hub, 'emulator');
  watch(sock, 'a');
  const ack = sock.frames.find((f) => f.type === 'response' && f.id === 'w');
  assert.deepEqual(ack.result, { ok: true });
  hub.emit('claude.session.update', { id: 'a' });
  hub.emit('claude.session.update', { id: 'b' });
  const got = eventsOf(sock, 'claude.session.update');
  assert.equal(got.length, 1);
  assert.equal(got[0].data.id, 'a');
});

test('watching null suppresses every detail', () => {
  const hub = createHub();
  const sock = connect(hub, 'emulator');
  watch(sock, null);
  hub.emit('claude.session.update', { id: 'a' });
  assert.equal(eventsOf(sock, 'claude.session.update').length, 0);
});

test('watch never filters snapshots or asks', () => {
  const hub = createHub();
  const sock = connect(hub, 'emulator');
  watch(sock, 'a');
  hub.emit('claude.sessions.update', { sessions: [{ id: 'b' }] });
  hub.emit('claude.permission.request', { requestId: 'r', sessionId: 'b' });
  assert.equal(eventsOf(sock, 'claude.sessions.update').length, 1);
  assert.equal(eventsOf(sock, 'claude.permission.request').length, 1);
});

test('one socket watching leaves another unfiltered', () => {
  const hub = createHub();
  const watcher = connect(hub, 'emulator');
  const bystander = connect(hub, 'webpage');
  watch(watcher, 'a');
  hub.emit('claude.session.update', { id: 'b' });
  assert.equal(eventsOf(watcher, 'claude.session.update').length, 0);
  assert.equal(eventsOf(bystander, 'claude.session.update').length, 1);
});

test('a re-watch moves the filter; a reconnect clears it', () => {
  const hub = createHub();
  let sock = connect(hub, 'emulator');
  watch(sock, 'a');
  watch(sock, 'b');
  hub.emit('claude.session.update', { id: 'a' });
  hub.emit('claude.session.update', { id: 'b' });
  let got = eventsOf(sock, 'claude.session.update');
  assert.equal(got.length, 1);
  assert.equal(got[0].data.id, 'b');

  // A new connection is a new socket: no watch until it says so.
  sock.emit('close');
  sock = connect(hub, 'emulator');
  hub.emit('claude.session.update', { id: 'a' });
  assert.equal(eventsOf(sock, 'claude.session.update').length, 1);
});
