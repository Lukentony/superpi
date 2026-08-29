# superPi

superPi is an experimental Linux application that supervises Pi coding-agent conversations from a local web UI.

> **Experimental software.** It is not a sandbox and is not an npm package. Review the security model before using it with a real working directory.

## Supported environment

- Linux only for this release candidate.
- Node.js `>=22.19.0`.
- A local installation of `@earendil-works/pi-coding-agent` from `npm ci`.
- A configured Pi provider is needed only for live conversations, not for the public test gate.

## Quick start

```bash
npm ci
npm start
```

Open <http://127.0.0.1:8787/>. The default server listens on loopback and has optional HTTP Basic authentication.

> **Security warning:** a coding-agent child can use `bash` with the operating-system permissions of the user running superPi. The tool allowlist is not a sandbox. Keep the server on loopback, choose working directories deliberately, and do not expose it to an untrusted network.

For a local authenticated run:

```bash
SUPERPI_AUTH_USER=local-user \
SUPERPI_AUTH_PASSWORD='use-a-local-password' \
npm start
```

Both authentication variables must be set together. Do not put real credentials in tracked files or issue reports.

## What it does

- Runs multiple supervised Pi conversations behind one HTTP server.
- Streams tool activity, replies, dialogs, and state changes through Server-Sent Events.
- Keeps append-only per-conversation notes and derives a deterministic summary.
- Supports explicit working directories and a safe default workspace below `~/lavori-superpi`.
- Provides a conductor conversation and an optional session-resume panel when the required local adapters are available.
- Applies input validation, CSRF protection, security headers, restrictive local-state permissions, and optional Basic authentication.

The server itself uses Node's built-in HTTP implementation. Tailscale exposure is an experimental convenience only; Tailscale is **not** an authentication mechanism and is not supported as a security boundary.

## Configuration

The main variables are documented in [docs/configuration.md](docs/configuration.md). A minimal example is:

```bash
SUPERPI_PORT=8787 \
SUPERPI_LAVORI_DIR="$HOME/lavori-superpi" \
SUPERPI_MAX_CONVERSAZIONI=4 \
npm start
```

The optional local router mapping can start from [router.example.json](router.example.json) and is read from `~/.config/superpi/router.json` by default. It contains model names, never credentials.

## Tests and quality gates

`npm test` is the single offline gate. It runs repository checks, deterministic unit suites, and the HTTP/process integration smoke. It does not contact a provider and does not run Pi, Herdr, tmux, or Tailscale.

```bash
npm test
npm run check
npm run lint
npm run format:check
npm run audit
```

The older scripts under `scripts/` include manual system and live checks. They are intentionally not part of `npm test`; their tier, prerequisites, and cleanup behavior are listed in [docs/testing.md](docs/testing.md).

## Local state and operations

Runtime state is stored under `~/.local/state/superpi/` with restrictive permissions. The server writes notes and session data there; it does not make that state a backup or a security boundary. Stop a foreground server with `Ctrl-C` or `SIGTERM` and inspect [docs/troubleshooting.md](docs/troubleshooting.md) if a process remains.

## Documentation

- [Architecture and trust boundaries](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Security policy and threat model](SECURITY.md)
- [Testing tiers and script manifest](docs/testing.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)
- [Release roadmap](ROADMAP.md)

## Project status

This repository is a release candidate for an experimental Linux application. APIs, configuration names, the router integration, and session adapters may change before a stable release. Remote exposure, cross-platform support, and sandboxing are not promised by this release candidate.
