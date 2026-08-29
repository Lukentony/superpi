# Configuration

All settings are environment variables. Defaults are suitable for a loopback development run, not for shared hosting.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SUPERPI_PORT` | `8787` | TCP port, from 1 to 65535. The host is always `127.0.0.1`. |
| `SUPERPI_AUTH_USER` | unset | Basic-auth username. Must be paired with the password. |
| `SUPERPI_AUTH_PASSWORD` | unset | Basic-auth password. Must be paired with the username. |
| `SUPERPI_LAVORI_DIR` | `~/lavori-superpi` | Parent directory for automatic conversation workspaces. |
| `SUPERPI_PROTECTED_ROOT` | unset | Optional directory tree rejected for new tasks, for example an existing vault. `/riprendi` may use an existing session according to its documented policy. |
| `SUPERPI_MAX_CONVERSAZIONI` | `4` | Maximum normal conversations occupying a slot. |
| `SUPERPI_TASK_TIMEOUT_MS` | `1800000` | Per-turn timeout in milliseconds. |
| `SUPERPI_RIPRESA_ATTESA_MAX_MS` | `60000` | Maximum wait for a busy resume target. |
| `SUPERPI_ROUTER_CONFIG` | `~/.config/superpi/router.json` | Optional local profile-to-model mapping. |
| `SUPERPI_ROUTER_TIMEOUT_MS` | `90000` | Timeout for the optional live router child. |
| `SUPERPI_LOG_MODE` | `metadata` | Persistence of tool-event notes: `metadata`, `full`, or `off`. |
| `SUPERPI_LOG_RETENTION_DAYS` | `0` | Delete old `*.jsonl` notes at startup after this many days; `0` disables cleanup. |

The server creates `~/.local/state/superpi/` for notes, sessions, and conductor state. It applies mode `0700` to managed directories and a restrictive process umask. Do not place source code, credentials, or unrelated persistent data in that directory.

Tool-event notes use `metadata` by default and persist only `ts`, `toolName`, and `isError`. `full` keeps the historical `args` and `result` fields and may contain secrets from tool input or output; use it only when that exposure is acceptable. `off` writes no note file but still returns the metadata event to the live server stream. `SUPERPI_LOG_RETENTION_DAYS` removes only stale regular `*.jsonl` files directly inside the note directory during startup; it never removes workdirs.

## Router configuration

Copy [router.example.json](../router.example.json) to the default configuration path and edit only the provider/model mappings. The file is local configuration, not a credential store. Invalid or missing profile entries fall back to the versioned defaults.

## Authentication

Set both variables for Basic authentication:

```bash
export SUPERPI_AUTH_USER=local-user
export SUPERPI_AUTH_PASSWORD='use-a-local-password'
npm start
```

The server rejects a configuration in which only one variable is set. Basic authentication is optional for loopback development, has no built-in TLS, and must not be treated as authorization for multiple users.

## Tailscale helper

`scripts/serve.sh` is a manual, experimental helper. It requires `SUPERPI_HOSTNAME`, `SUPERPI_AUTH_USER`, and `SUPERPI_AUTH_PASSWORD`, uses normal `tailscale serve --bg --http PORT PORT`, and keeps the server loopback-only. The hostname is informational for the displayed URL. Before changing Serve, it saves the existing configuration in a mode-0600 local snapshot under `.test-run/`. Stop it with `npm run serve:stop`; that command stops only the registered superPi process and restores the snapshot. Tailscale membership is not authentication. See [SECURITY.md](../SECURITY.md) before using it.

## Diagnostics and cleanup

Run `npm run doctor` for a local preflight. Node.js and the Pi CLI are required; tmux, Herdr, Tailscale, state directories, and router configuration are reported as optional capabilities. It never prints configuration values or command output.

After stopping the server, `SUPERPI_CONFIRM_CLEANUP=1 npm run cleanup` removes only the contents of `~/.local/state/superpi/note` and `sessions`. It never touches `SUPERPI_LAVORI_DIR` or any other workdir.

## Test-only variables

`SUPERPI_GATE_QUOTA_FAKE` and `SUPERPI_ROUTER_FAKE` exist for existing local fixtures. They bypass live decisions and must not be enabled for normal operation. `SUPERPI_URL` and `SUPERPI_TOKEN` are internal values used by the conductor extension, not general configuration.

Provider credentials such as `OPENROUTER_API_KEY` are consumed only when a live path needs them. Never commit them, print them, or include them in bug reports.
