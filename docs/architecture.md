# Architecture

## System boundary

superPi is a Linux-local web application. A Node.js HTTP server binds to `127.0.0.1`, serves a small browser UI, manages conversation state, and starts Pi child processes when a user creates or resumes a conversation.

The application is a supervisor, not a sandbox. A child can use the tools in its explicit allowlist; `bash` still has the operating-system permissions of the user and can act on the selected working directory.

## Components

- `src/server.mjs` owns HTTP routing, Basic authentication, CSRF checks, security headers, task lifecycle, SSE streams, and graceful shutdown.
- `src/spawner.mjs` wraps the Pi RPC client and applies session identity, provider/model selection, timeouts, and stop behavior.
- `src/scriba.mjs` records completed tool calls as append-only JSONL.
- `src/condensatore.mjs` derives a deterministic summary from those notes; it does not ask a model to summarize tool activity.
- `src/gate.mjs` validates working-directory boundaries and quota decisions before a child is started.
- `src/router.mjs` validates a routing profile and maps it to configured provider/model values.
- `src/sessioni.mjs` adapts optional session discovery capabilities. Herdr is preferred and tmux is a fallback for the resume panel.
- `src/pagina.html` is the browser UI. It uses normal HTTP requests and SSE; it is not a separate build artifact.

## Main flows

### Start and create a conversation

1. The browser obtains the HTML page and its per-process CSRF token.
2. A task request passes Basic authentication, JSON/body validation, CSRF validation, and working-directory checks.
3. The router selects a validated profile or accepts an explicit validated profile.
4. The server revalidates the directory identity before creating a task and spawning Pi.
5. Pi events update the task state and append completed tool calls to the conversation note file.
6. The browser receives state, dialog, raw-tool, reply, and final-summary events through SSE.

### Continue and terminate

A conversation remains alive after a turn and enters `in_attesa`. New messages are queued when a turn is active. `POST /termina` marks the task finished, derives a final summary, stops the child, closes SSE clients, and writes automatic-workspace artifacts when applicable.

### Resume

The session adapter identifies a supported Pi session and its working directory. The server checks the target again immediately before sending a termination signal, then starts a new supervised task with the existing session identity. A changed PID, command, session, or directory fails closed.

## Trust boundaries

1. **Browser to HTTP server:** Basic authentication, where enabled, and CSRF checks protect requests. SSE is read-only but still passes the HTTP authentication check.
2. **Server to filesystem:** the server owns state below `~/.local/state/superpi/` and applies restrictive permissions. User-selected working directories remain an explicit trust decision.
3. **Server to Pi child:** RPC and environment variables cross a process boundary. Tool allowlists reduce available interfaces but do not provide OS isolation.
4. **Server to optional integrations:** provider APIs, Herdr, tmux, Tailscale, and local router configuration are capabilities outside the offline CI gate.

## Data and exposure

Runtime state is stored below `~/.local/state/superpi/` in note and session subdirectories. Automatic workspaces are created below `SUPERPI_LAVORI_DIR`. Provider credentials, when used, must arrive through the runtime environment and must not be written to repository files or logs.

The default network exposure is loopback. `scripts/serve.sh` can place an experimental Tailscale route in front of the server, but that route is not authentication and must not be used as a substitute for a reviewed authenticated deployment.

## Failure and recovery

Configuration errors fail during startup. Invalid input and failed gates return explicit HTTP errors. Child failures transition the task to an error state and stop the child. Shutdown closes streams, requests child termination, and uses bounded waits so a stuck child cannot block the server forever.

See [configuration.md](configuration.md), [SECURITY.md](../SECURITY.md), and [troubleshooting.md](troubleshooting.md) for operational details.
