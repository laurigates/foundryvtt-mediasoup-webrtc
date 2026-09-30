/**
 * Spawn the real Rust SFU (`server/target/release/mediasoup-server`) for the
 * e2e suite. Nothing is built here: CI (and `just test-e2e`) build the release
 * binary beforehand, so a missing binary is a setup error, not a skip.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
export const SFU_BINARY =
  process.env.E2E_SFU_BINARY ?? path.join(REPO_ROOT, 'server/target/release/mediasoup-server');
export const LOG_DIR = path.join(REPO_ROOT, 'test-results/e2e-logs');

export interface SfuOptions {
  /** WebSocket port; a free one is picked when omitted. */
  port?: number;
  /** Shared secret (`MEDIASOUP_AUTH_TOKEN`). */
  token: string;
  /** Inclusive RTC (ICE) port range for the worker. */
  rtcMinPort: number;
  rtcMaxPort: number;
  /** Log file name under test-results/e2e-logs/. */
  logName: string;
}

export interface SfuHandle {
  readonly port: number;
  readonly url: string;
  readonly token: string;
  readonly logFile: string;
  /** Terminate gracefully (SIGTERM, then SIGKILL after a grace period). */
  stop(): Promise<void>;
  /** Kill abruptly (SIGKILL): the clients see an unclean socket close. */
  kill(): Promise<void>;
  /** Start a new server process with the same port, token and RTC range. */
  restart(): Promise<SfuHandle>;
}

/** Ask the OS for a free TCP port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('Could not allocate a free port.'));
      });
    });
  });
}

function canConnectTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Ready = a WebSocket handshake completes (Node 22+ has a global WebSocket);
 * older Node falls back to a TCP connect.
 */
async function isReady(port: number): Promise<boolean> {
  const WebSocketImpl = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WebSocketImpl) return canConnectTcp(port);
  return new Promise((resolve) => {
    const ws = new WebSocketImpl(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      ws.close();
      resolve(false);
    }, 2_000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      resolve(true);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

export async function startSfu(options: SfuOptions): Promise<SfuHandle> {
  if (!existsSync(SFU_BINARY)) {
    throw new Error(
      `SFU binary not found at ${SFU_BINARY}. Build it first: ` +
        '`cd server && cargo build --release` (or `just server-build`).',
    );
  }
  const port = options.port ?? (await freePort());
  mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, `${options.logName}.log`);
  const log = createWriteStream(logFile, { flags: 'a' });
  log.write(`\n=== start ${new Date().toISOString()} port=${port} ===\n`);

  const child = spawn(SFU_BINARY, [], {
    cwd: path.join(REPO_ROOT, 'server'),
    env: {
      ...process.env,
      MEDIASOUP_LISTEN_ADDR: `127.0.0.1:${port}`,
      MEDIASOUP_LISTEN_IP: '127.0.0.1',
      MEDIASOUP_ANNOUNCED_IP: '127.0.0.1',
      MEDIASOUP_RTC_MIN_PORT: String(options.rtcMinPort),
      MEDIASOUP_RTC_MAX_PORT: String(options.rtcMaxPort),
      MEDIASOUP_AUTH_TOKEN: options.token,
      MEDIASOUP_NUM_WORKERS: '1',
      RUST_LOG: process.env.RUST_LOG ?? 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });

  let exitInfo: string | null = null;
  child.once('exit', (code, signal) => {
    exitInfo = `exited (code ${code}, signal ${signal})`;
    log.write(`=== ${exitInfo} ===\n`);
  });

  // Ready once the WebSocket port accepts connections; fail fast on exit.
  const deadline = Date.now() + 30_000;
  while (!(await isReady(port))) {
    if (exitInfo) throw new Error(`SFU ${exitInfo} before becoming ready; see ${logFile}`);
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`SFU did not listen on 127.0.0.1:${port} within 30 s; see ${logFile}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const terminate = async (signal: NodeJS.Signals): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited(child);
    clearTimeout(timer);
  };

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    token: options.token,
    logFile,
    stop: () => terminate('SIGTERM'),
    kill: () => terminate('SIGKILL'),
    restart: async () => {
      await terminate('SIGKILL');
      // The mediasoup worker child may hold the RTC ports briefly after the
      // parent dies; the new worker binds from the same range.
      return startSfu({ ...options, port });
    },
  };
}
