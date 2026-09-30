/**
 * Recovery: the SFU process dies mid-session and comes back. The clients'
 * backoff loop reconnects on its own (no AVMaster#reestablish), re-produces the
 * local tracks and re-consumes the others', and media flows again.
 *
 * Uses a dedicated SFU (own port and RTC range) so killing it cannot disturb
 * the shared server of the other specs.
 */

import { type SfuHandle, startSfu } from './support/sfu-server.js';
import { expect, test } from './support/peer.js';

let sfu: SfuHandle | undefined;

test.afterEach(async () => {
  await sfu?.stop();
  sfu = undefined;
});

test('clients reconnect and media resumes after the SFU restarts', async ({ peers }) => {
  sfu = await startSfu({
    token: 'e2e-restart-token',
    rtcMinPort: 40100,
    rtcMaxPort: 40149,
    logName: 'sfu-restart',
  });
  const users = ['alice', 'bob'];
  const opts = { users, sfuUrl: sfu.url, token: sfu.token };
  const a = await peers({ user: 'alice', ...opts });
  const b = await peers({ user: 'bob', ...opts });
  expect(await a.connect()).toBe(true);
  expect(await b.connect()).toBe(true);
  await b.expectConsuming('alice');
  await b.expectReceiving('alice');
  const before = (await b.remoteConsumers('alice')).map((c) => c.consumerId);

  // Hard kill: the sockets drop without a close frame.
  await sfu.kill();
  for (const peer of [a, b]) {
    await expect
      .poll(async () => (await peer.status()).state, { message: `${peer.user} notices the loss` })
      .toBe('reconnecting');
  }
  // The dead server's tracks are dropped, not left frozen in the dock.
  await expect.poll(async () => (await b.remoteConsumers('alice')).length).toBe(0);

  sfu = await sfu.restart();

  for (const peer of [a, b]) {
    await expect
      .poll(async () => (await peer.status()).state, {
        message: `${peer.user} reconnects`,
        timeout: 45_000,
      })
      .toBe('connected');
    expect(await peer.transportStates()).toEqual(
      expect.arrayContaining(['connecting', 'connected', 'reconnecting']),
    );
  }

  await b.expectConsuming('alice');
  await a.expectConsuming('bob');
  const after = (await b.remoteConsumers('alice')).map((c) => c.consumerId);
  // Fresh consumers on the new server, not stale ones.
  expect(after.filter((id) => before.includes(id))).toEqual([]);
  await b.expectVideoTile('alice');
  await b.expectReceiving('alice');
  await a.expectReceiving('bob');
  const notes = (await a.notifications()).map((n) => n.message).join('\n');
  expect(notes).toMatch(/Reconnected to the MediaSoup server/);
});
