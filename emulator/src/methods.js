// Mock nocturned device-local method table.
// Contract: carthing-knowledge/daemon.md §1. Handlers return {result} or {error};
// they may also call emit(topic, data) for side-effect events.

import { SIM_PHONE } from './config.js';

export const deviceState = {
  brightness: 60,
  brightnessAuto: true,
  displayAwake: true,
  wakewordPaused: false,
  discoverable: false,
  recording: false,
  btDevices: SIM_PHONE
    ? [{ address: 'AA:BB:CC:DD:EE:99', name: 'Dev iPhone', paired: true, connected: true }]
    : [],
};

const ok = { status: 'ok' };

export function buildMethods({ emit, firmware }) {
  const timezone = () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return { timezone: tz, offset: -new Date().getTimezoneOffset() };
  };
  const timeNow = () => {
    const d = new Date();
    return {
      datetime: d.toISOString(),
      time: d.toTimeString().slice(0, 5),
    };
  };

  return {
    reset_boot_counter: () => ({ result: ok }),

    'device.info': () => ({
      result: {
        serial: 'EMU0000000001',
        name: 'Nocturne Emulator',
        model: 'superbird',
        bluetoothAddress: 'AA:BB:CC:DD:EE:01',
      },
    }),

    'device.version': () => ({ result: firmware.version }),

    'device.time.get': () => ({ result: timeNow() }),
    'device.timezone.get': () => ({ result: timezone() }),

    'device.brightness.get': () => ({
      result: { brightness: deviceState.brightness, auto: deviceState.brightnessAuto },
    }),
    'device.brightness.set': (params = {}) => {
      const v = params.brightness ?? params.value;
      if (typeof v === 'number') deviceState.brightness = v;
      deviceState.brightnessAuto = false;
      return { result: ok };
    },
    'device.brightness.auto': (params = {}) => {
      deviceState.brightnessAuto = params.enabled !== false;
      return { result: ok };
    },

    'device.display.get': () => ({ result: { awake: deviceState.displayAwake } }),
    'device.display.sleep': () => {
      deviceState.displayAwake = false;
      return { result: ok };
    },
    'device.display.wake': () => {
      deviceState.displayAwake = true;
      return { result: ok };
    },

    'device.power.reboot': () => {
      setTimeout(() => emit('emulator.reboot', {}), 300);
      return { result: ok };
    },
    'device.power.shutdown': () => {
      setTimeout(() => emit('emulator.shutdown', {}), 300);
      return { result: ok };
    },
    'device.factoryreset': () => {
      setTimeout(() => emit('emulator.reboot', {}), 300);
      return { result: ok };
    },

    'device.launchApp': (params = {}) => ({ result: ok }),

    'device.ab.get': () => ({
      result: { activeSlot: firmware.slot, slots: { a: { successful: true }, b: { successful: true } } },
    }),

    'device.ota.check': () => ({ result: { updateAvailable: false } }),

    'bluetooth.devices.list': () => ({ result: { devices: deviceState.btDevices } }),
    'bluetooth.discoverable': (params = {}) => {
      // UI sends {discoverable:bool} and requires result.status === "requested"
      deviceState.discoverable = params.discoverable !== false;
      emit('bluetooth.discoverable', { discoverable: deviceState.discoverable });
      return { result: { status: 'requested' } };
    },
    'bluetooth.device.connect': (params = {}) => {
      const d = deviceState.btDevices.find((x) => x.address === params.address);
      if (d) d.connected = true;
      return { result: ok };
    },
    'bluetooth.device.disconnect': (params = {}) => {
      const d = deviceState.btDevices.find((x) => x.address === params.address);
      if (d) d.connected = false;
      return { result: ok };
    },
    'bluetooth.device.unpair': (params = {}) => {
      deviceState.btDevices = deviceState.btDevices.filter((x) => x.address !== params.address);
      return { result: ok };
    },
    'bluetooth.device.forget': (params = {}) => {
      deviceState.btDevices = deviceState.btDevices.filter((x) => x.address !== params.address);
      return { result: ok };
    },

    'audio.record.start': () => {
      deviceState.recording = true;
      return { result: ok };
    },
    'audio.record.stop': () => {
      deviceState.recording = false;
      return { result: ok };
    },
    'voice.cancel': () => ({ result: ok }),

    'wakeword.pause': () => {
      deviceState.wakewordPaused = true;
      emit('voice.wakeword.state', { paused: true });
      return { result: ok };
    },
    'wakeword.resume': () => {
      deviceState.wakewordPaused = false;
      emit('voice.wakeword.state', { paused: false });
      return { result: ok };
    },
  };
}
