/**
 * Browser media fakes: MediaStream, navigator.mediaDevices and a mediasoup
 * Device running on mediasoup-client's own FakeHandler.
 *
 * happy-dom has no WebRTC, so the mediasoup Device uses FakeHandler with
 * `testFakeParameters`: it runs the real mediasoup-client Transport / Producer
 * / Consumer state machines (including the `connect` and `produce` events the
 * core answers over signaling) without an RTCPeerConnection.
 */

import { FakeMediaStreamTrack } from 'fake-mediastreamtrack';
import { Device, FakeHandler, testFakeParameters } from 'mediasoup-client';
import type { Device as MediasoupDevice } from 'mediasoup-client/types';
import { vi } from 'vitest';

export { FakeMediaStreamTrack, testFakeParameters };

/**
 * happy-dom's MediaStream plus `getTracks()`, which happy-dom lacks. It stays
 * a real happy-dom MediaStream, so `HTMLMediaElement#srcObject` accepts it,
 * and it holds FakeMediaStreamTrack instances.
 */
function createMediaStreamClass(Base: typeof MediaStream): typeof MediaStream {
  return class FakeMediaStream extends Base {
    override getTracks(): MediaStreamTrack[] {
      return [...this.getAudioTracks(), ...this.getVideoTracks()];
    }
  };
}

export function audioTrack(): MediaStreamTrack {
  return new FakeMediaStreamTrack({ kind: 'audio' }) as unknown as MediaStreamTrack;
}

export function videoTrack(): MediaStreamTrack {
  return new FakeMediaStreamTrack({ kind: 'video' }) as unknown as MediaStreamTrack;
}

export interface FakeMediaDevices {
  /** Every getUserMedia call, with its constraints. */
  readonly getUserMedia: ReturnType<typeof vi.fn>;
  readonly enumerateDevices: ReturnType<typeof vi.fn>;
  /** Every track getUserMedia handed out. */
  readonly created: MediaStreamTrack[];
  /** Make the next calls fail for a kind (simulates a missing device). */
  failKinds: Set<'audio' | 'video'>;
  /** Delay before getUserMedia resolves, in ms. */
  delayMs: number;
}

export const FAKE_DEVICES: MediaDeviceInfo[] = [
  { kind: 'audioinput', deviceId: 'mic-1', label: 'Desk Mic', groupId: 'g1' },
  { kind: 'audioinput', deviceId: 'mic-2', label: '', groupId: 'g2' },
  { kind: 'videoinput', deviceId: 'cam-1', label: 'Webcam', groupId: 'g3' },
  { kind: 'audiooutput', deviceId: 'spk-1', label: 'Speakers', groupId: 'g4' },
].map((d) => ({ ...d, toJSON: () => d }) as MediaDeviceInfo);

/** Install `MediaStream` and `navigator.mediaDevices` fakes. */
export function installMediaFakes(): FakeMediaDevices {
  const g = globalThis as any;
  if (!g.MediaStream.prototype.getTracks) g.MediaStream = createMediaStreamClass(g.MediaStream);
  const Stream: typeof MediaStream = g.MediaStream;
  const state: FakeMediaDevices = {
    created: [],
    failKinds: new Set(),
    delayMs: 0,
    getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      const tracks: MediaStreamTrack[] = [];
      if (constraints.audio) {
        if (state.failKinds.has('audio')) throw new DOMException('No microphone', 'NotFoundError');
        tracks.push(audioTrack());
      }
      if (constraints.video) {
        if (state.failKinds.has('video')) throw new DOMException('No camera', 'NotFoundError');
        tracks.push(videoTrack());
      }
      state.created.push(...tracks);
      return new Stream(tracks);
    }),
    enumerateDevices: vi.fn(async () => FAKE_DEVICES),
  };
  Object.defineProperty(g.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: state.getUserMedia, enumerateDevices: state.enumerateDevices },
  });
  return state;
}

export interface FakeHandlerRecord {
  direction: 'send' | 'recv';
  handler: { setConnectionState(state: string): void };
}

/**
 * A mediasoup Device factory backed by FakeHandler. The returned `handlers`
 * list records every transport handler created, so a test can drive a
 * transport's ICE/DTLS connection state (`handler.setConnectionState`).
 */
export function fakeDeviceFactory(): {
  factory: () => MediasoupDevice;
  handlers: FakeHandlerRecord[];
  devices: MediasoupDevice[];
} {
  const handlers: FakeHandlerRecord[] = [];
  const devices: MediasoupDevice[] = [];
  const base = FakeHandler.createFactory(testFakeParameters);
  const handlerFactory = {
    ...base,
    factory: (options: any) => {
      const handler = base.factory(options);
      handlers.push({ direction: options.direction, handler: handler as any });
      return handler;
    },
  };
  return {
    handlers,
    devices,
    factory: () => {
      const device = new Device({ handlerFactory });
      devices.push(device);
      return device;
    },
  };
}
