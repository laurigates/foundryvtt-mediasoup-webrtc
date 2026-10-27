## What and why

<!-- What the change does, and the issue it closes (e.g. "Closes #123"). -->

## Checklist

- [ ] The PR title is a Conventional Commit (`feat:`, `fix:`, `docs:`, `chore:` ...); release-please builds the changelog from it.
- [ ] `just check` passes.
- [ ] `just server-check` passes (only if `server/` changed).
- [ ] Signaling contract in sync: `src/constants/index.ts` and `server/src/server.rs` / `server/src/room.rs` (only if a message type changed).
- [ ] Docs updated (`README.md`, `server/README.md`, `docs/`, `tests/README.md`) where behaviour or commands changed.
- [ ] No `dist/` and no Foundry core or `avclient-livekit` code committed.

See [CONTRIBUTING.md](../CONTRIBUTING.md).
