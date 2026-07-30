// Car Thing emulator faceplate.
// Everything here reproduces the device input contract exactly:
//   dial turn  -> WheelEvent {deltaX: ±TICK}   (never deltaY)
//   dial press -> Enter keydown/keyup          (long-press = app-side timer)
//   back       -> Escape
//   presets    -> key "1".."4" / code "Digit1".."Digit4" (both set)
//   settings   -> "m" / "KeyM"
// Events are dispatched into the same-origin firmware iframe using the
// iframe realm's own constructors, keydown on press / keyup on release.

const iframe = document.getElementById('screen');

let cfg = {
  dial: { tickDelta: 90, minTickMs: 20, degPerTick: 15, scrollPerTick: 50 },
};

fetch('/__emulator__/config.json')
  .then((r) => r.json())
  .then((c) => {
    cfg = c;
    document.getElementById('st-version').textContent =
      `firmware: ${(c.version && (c.version.shortVersion || c.version.version)) || 'unknown'}` +
      (c.simPhone ? '' : '  (phone sim OFF)');
    document.getElementById('st-zip').textContent = c.zip || '';
  })
  .catch(() => {});

// ---- synthetic event dispatch ------------------------------------------

function fw() {
  return iframe.contentWindow;
}

function sendKey(type, key, code) {
  const w = fw();
  if (!w) return;
  w.document.dispatchEvent(new w.KeyboardEvent(type, {
    key, code, bubbles: true, cancelable: true,
  }));
}

function sendWheel(deltaX) {
  const w = fw();
  if (!w) return;
  w.document.dispatchEvent(new w.WheelEvent('wheel', {
    deltaX, deltaY: 0, deltaMode: 0, bubbles: true, cancelable: true,
  }));
}

// ---- physical-style buttons (keydown on press, keyup on release) --------

function wireButton(el, key, code) {
  let down = false;
  const press = (e) => {
    e.preventDefault();
    if (down) return;
    down = true;
    el.classList.add('pressed');
    sendKey('keydown', key, code);
  };
  const release = () => {
    if (!down) return;
    down = false;
    el.classList.remove('pressed');
    sendKey('keyup', key, code);
  };
  el.addEventListener('mousedown', press);
  el.addEventListener('touchstart', press, { passive: false });
  el.addEventListener('mouseup', release);
  el.addEventListener('mouseleave', release);
  el.addEventListener('touchend', release);
  el.addEventListener('touchcancel', release);
}

for (const el of document.querySelectorAll('[data-key]')) {
  wireButton(el, el.dataset.key, el.dataset.code);
}

// ---- dial ----------------------------------------------------------------

const dial = document.getElementById('dial');
const knob = document.getElementById('dial-knob');

let knobAngle = 0;
const tickQueue = [];
let tickTimer = null;

function queueTicks(n, dir) {
  for (let i = 0; i < n; i++) tickQueue.push(dir);
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    const d = tickQueue.shift();
    if (d === undefined) {
      clearInterval(tickTimer);
      tickTimer = null;
      return;
    }
    sendWheel(d * cfg.dial.tickDelta);
    knobAngle += d * cfg.dial.degPerTick;
    knob.style.transform = `rotate(${knobAngle}deg)`;
  }, cfg.dial.minTickMs);
}

// drag-to-rotate: accumulate pointer angle around knob center
let dragging = false;
let dragMoved = false;
let lastAngle = 0;
let degAccum = 0;

function pointerAngle(e) {
  const r = dial.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const p = e.touches ? e.touches[0] : e;
  return (Math.atan2(p.clientY - cy, p.clientX - cx) * 180) / Math.PI;
}

function dragStart(e) {
  e.preventDefault();
  dragging = true;
  dragMoved = false;
  degAccum = 0;
  lastAngle = pointerAngle(e);
}

function dragMove(e) {
  if (!dragging) return;
  const a = pointerAngle(e);
  let d = a - lastAngle;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  lastAngle = a;
  degAccum += d;
  if (Math.abs(degAccum) >= 4) dragMoved = true;
  while (Math.abs(degAccum) >= cfg.dial.degPerTick) {
    const dir = degAccum > 0 ? 1 : -1;
    degAccum -= dir * cfg.dial.degPerTick;
    queueTicks(1, dir);
  }
}

function dragEnd() {
  if (!dragging) return;
  dragging = false;
  if (!dragMoved) {
    // treated as dial press: quick Enter down/up
    dial.classList.add('pressed');
    sendKey('keydown', 'Enter', 'Enter');
    setTimeout(() => {
      sendKey('keyup', 'Enter', 'Enter');
      dial.classList.remove('pressed');
    }, 90);
  }
}

dial.addEventListener('mousedown', dragStart);
dial.addEventListener('touchstart', dragStart, { passive: false });
window.addEventListener('mousemove', dragMove);
window.addEventListener('touchmove', dragMove, { passive: false });
window.addEventListener('mouseup', dragEnd);
window.addEventListener('touchend', dragEnd);

// long dial press: hold mouse >=250ms without moving = hold Enter until release
let holdTimer = null;
dial.addEventListener('mousedown', () => {
  holdTimer = setTimeout(() => {
    if (dragging && !dragMoved) {
      // switch to held-Enter mode; dragEnd's click path is suppressed
      dragMoved = true;
      dial.classList.add('pressed');
      sendKey('keydown', 'Enter', 'Enter');
      const up = () => {
        sendKey('keyup', 'Enter', 'Enter');
        dial.classList.remove('pressed');
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mouseup', up);
    }
  }, 250);
});
window.addEventListener('mouseup', () => clearTimeout(holdTimer));

// scroll over knob turns the dial
let scrollAccum = 0;
dial.addEventListener('wheel', (e) => {
  e.preventDefault();
  scrollAccum += e.deltaY + e.deltaX;
  while (Math.abs(scrollAccum) >= cfg.dial.scrollPerTick) {
    const dir = scrollAccum > 0 ? 1 : -1;
    scrollAccum -= dir * cfg.dial.scrollPerTick;
    queueTicks(1, dir);
  }
}, { passive: false });

// ---- keyboard passthrough ------------------------------------------------

const PASS_KEYS = {
  1: 'Digit1', 2: 'Digit2', 3: 'Digit3', 4: 'Digit4',
  m: 'KeyM', M: 'KeyM',
  Enter: 'Enter', Escape: 'Escape',
};
const heldKeys = new Set();

window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    queueTicks(1, e.key === 'ArrowRight' ? 1 : -1);
    return;
  }
  const code = PASS_KEYS[e.key];
  if (!code || e.repeat || heldKeys.has(code)) return;
  heldKeys.add(code);
  sendKey('keydown', e.key === 'M' ? 'm' : e.key, code);
}, { capture: true });

window.addEventListener('keyup', (e) => {
  const code = PASS_KEYS[e.key];
  if (!code || !heldKeys.has(code)) return;
  heldKeys.delete(code);
  sendKey('keyup', e.key === 'M' ? 'm' : e.key, code);
}, { capture: true });

// The firmware hides the pointer (`cursor: none`) because the real device has
// no mouse. In the emulator you are using one, so put it back — same-origin, so
// we can just add a stylesheet to the iframe.
function restoreCursor() {
  const w = fw();
  if (!w || !w.document || !w.document.head) return;
  if (w.document.getElementById('emu-cursor')) return;
  const style = w.document.createElement('style');
  style.id = 'emu-cursor';
  style.textContent =
    'html,body,*{cursor:default !important}' +
    '[data-action],.card,.tile,.qrow,.qopt,.pbtn{cursor:pointer !important}';
  w.document.head.appendChild(style);
}

// Arrow keys must also work when the iframe has focus (after clicking the
// screen). Same-origin, so bridge them inside the iframe realm.
iframe.addEventListener('load', () => {
  const w = fw();
  if (!w) return;
  restoreCursor();
  w.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    queueTicks(1, e.key === 'ArrowRight' ? 1 : -1);
  }, { capture: true });
});

// ---- emulator control channel (same mock-nocturned socket) ---------------

const powerOverlay = document.getElementById('power-overlay');
const stWs = document.getElementById('st-ws');
let ws = null;
let everConnected = false;

function connectWs() {
  ws = new WebSocket('ws://localhost:5000');
  ws.onopen = () => {
    stWs.textContent = 'ws: connected';
    stWs.className = 'ws-state ok';
    if (everConnected) {
      // server restarted (e.g. redeploy with new firmware) -> fresh boot
      iframe.src = '/';
      powerOverlay.classList.add('hidden');
    }
    everConnected = true;
  };
  ws.onmessage = (m) => {
    let f;
    try { f = JSON.parse(m.data); } catch { return; }
    if (f.type !== 'event') return;
    if (f.topic === 'emulator.reboot') {
      powerOverlay.classList.add('hidden');
      iframe.src = '/';
    } else if (f.topic === 'emulator.shutdown') {
      powerOverlay.classList.remove('hidden');
    }
  };
  ws.onclose = () => {
    stWs.textContent = 'ws: disconnected';
    stWs.className = 'ws-state bad';
    setTimeout(connectWs, 1000);
  };
  ws.onerror = () => ws.close();
}
connectWs();

powerOverlay.addEventListener('click', () => {
  powerOverlay.classList.add('hidden');
  iframe.src = '/';
});
