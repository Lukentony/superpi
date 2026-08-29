# Troubleshooting

## The server does not start

Check that the Node version satisfies `>=22.19.0` and that dependencies are installed with `npm ci`. A port error usually means another process owns `SUPERPI_PORT`; choose a different port or stop the process you own. Configuration errors are printed without provider credentials.

```bash
SUPERPI_PORT=8877 npm start
```

## The browser gets 401

When Basic authentication is enabled, send the configured username and password. Both `SUPERPI_AUTH_USER` and `SUPERPI_AUTH_PASSWORD` must be present. A missing or stale CSRF token is a separate `401` response for API requests; reload the page to obtain the token for the current server process.

## The browser gets 400 or 409 when creating a task

The working directory must exist, resolve to a directory, not be exactly the home directory, and pass the application gate. A `409` can also mean that the conversation limit is full or that a target is still working. Read the JSON error without copying sensitive paths into a public report.

## A task does not progress

The Pi child and its provider are part of the live path, not the offline test gate. Check provider setup only in the environment where you intentionally run a live task. Do not add credentials to the repository. For a stuck local process, use the normal `POST /termina` action first, then send `SIGTERM` to the server you started if necessary.

## Shutdown leaves a process

The server handles `SIGTERM` and `SIGINT` and bounds child shutdown. Confirm that the PID belongs to the server you started before taking further action. The integration smoke exercises this path without creating a Pi child.

## Tailscale access fails

Tailscale support is experimental. Confirm that the local server responds on loopback first, that `SUPERPI_HOSTNAME` is set for the helper, and that the route belongs to the test instance. Stop a server with `npm run serve:stop`; it restores the exact Serve configuration saved at startup. Do not use a global reset command as routine cleanup and do not assume a tailnet route authenticates users.

If stopping reports that the Tailscale configuration could not be restored, leave `.test-run/superpi-serve.state` and its mode-0600 snapshot in place. Do not delete them: fix Tailscale access and rerun `npm run serve:stop`. A malformed or unprotected state is also left untouched for inspection.

## Tests fail offline

Run the public gate from a clean working tree with dependencies installed:

```bash
npm ci
npm test
```

`npm test` must not need provider credentials, Pi, Herdr, tmux, or Tailscale. Consult [docs/testing.md](testing.md) to select a manual system or live script when the failure is outside the public gate.

## State needs inspection or cleanup

State is under `~/.local/state/superpi/`. Stop the server first, preserve files needed for diagnosis, and remove only state you understand to be owned by this installation. Treat notes, session files, and tool output as potentially sensitive.

Run `npm run doctor` to check required Node/Pi capabilities without printing command output or configuration values. For intentional cleanup, stop the server and run `SUPERPI_CONFIRM_CLEANUP=1 npm run cleanup`; the command lists entries before removing them, and is restricted to the `note` and `sessions` state directories. It never removes `SUPERPI_LAVORI_DIR` workdirs.

If notes unexpectedly contain tool arguments or results, check `SUPERPI_LOG_MODE`. `metadata` is the server default, `off` disables persistence, and `full` deliberately persists the historical full event and can contain secrets. `SUPERPI_LOG_RETENTION_DAYS=0` disables startup retention; a positive integer removes only old regular `*.jsonl` files in `note`.
