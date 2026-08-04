// Singleton WebSocket to nocturned (ws://localhost:5000), per the
// useNocturned.js pattern: id-correlated requests (responses are broadcast to
// every client — filter by our own pending ids), exponential-backoff
// reconnect. This app never sends reset_boot_counter — the boot UI owns that.

import { unbool, observeProbe, shouldUnbool } from './numbers.js';

var socket = null;
var pending = {};            // id -> {resolve, reject, timer}
var topicListeners = {};     // topic -> [fn]
var openListeners = [];
var attempts = 0;

function uuid() {
  // no crypto.randomUUID on Chrome 69
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function connect() {
  socket = new WebSocket('ws://localhost:5000');

  socket.onopen = function () {
    attempts = 0;
    for (var i = 0; i < openListeners.length; i++) openListeners[i]();
  };

  socket.onmessage = function (m) {
    var f;
    try { f = JSON.parse(m.data); } catch (e) { return; }
    // Walk every frame only while the link is known (or suspected) to coerce
    // ints — snapshots carry an intProbe that says either way. See numbers.js.
    var body = f.type === 'response' ? f.result : f.data;
    if (body && body.intProbe !== undefined) observeProbe(body.intProbe);
    if (shouldUnbool()) unbool(body);
    if (f.type === 'event' && f.topic) {
      var fns = topicListeners[f.topic] || [];
      for (var i = 0; i < fns.length; i++) fns[i](f.data, f);
      return;
    }
    if ((f.type === 'response' || f.type === 'error') && pending[f.id]) {
      var p = pending[f.id];
      delete pending[f.id];
      clearTimeout(p.timer);
      if (f.type === 'response') p.resolve(f.result);
      else p.reject(new Error(f.error || 'request failed'));
    }
  };

  socket.onclose = function () {
    attempts++;
    var delay = Math.min(1000 * Math.pow(2, attempts - 1), 30000);
    setTimeout(connect, delay);
  };
  socket.onerror = function () {
    try { socket.close(); } catch (e) {}
  };
}

export function request(method, params, timeoutMs) {
  return new Promise(function (resolve, reject) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return reject(new Error('socket not open'));
    }
    var id = uuid();
    var timer = setTimeout(function () {
      delete pending[id];
      reject(new Error('timeout: ' + method));
    }, timeoutMs || 10000);
    pending[id] = { resolve: resolve, reject: reject, timer: timer };
    socket.send(JSON.stringify({ type: 'request', id: id, method: method, params: params || {} }));
  });
}

export function on(topic, fn) {
  (topicListeners[topic] = topicListeners[topic] || []).push(fn);
}

export function onOpen(fn) {
  openListeners.push(fn);
  if (socket && socket.readyState === WebSocket.OPEN) fn();
}

connect();
