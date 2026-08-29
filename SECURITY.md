# Security policy

## Scope and status

superPi is experimental Linux software for supervised local coding-agent sessions. The default network posture is loopback-only. Optional HTTP Basic authentication is available, but it does not add TLS, sandboxing, or process isolation.

The current authentication status is:

- If `SUPERPI_AUTH_USER` and `SUPERPI_AUTH_PASSWORD` are both set and non-empty, Basic authentication is required for the page, REST endpoints, and SSE endpoints.
- If neither variable is set, authentication is disabled for local development.
- Setting only one variable is a configuration error and the server refuses to start.
- Tailscale is experimental transport exposure only. Tailnet membership, `tailscale serve`, and the CSRF token are not user authentication.

Do not expose the server to a shared or untrusted network. Basic authentication is sent with every request and must be protected by a trusted TLS-terminating proxy if traffic leaves the host.

## Threat model

### Assets

- Local working directories and files selected for a conversation.
- Conversation notes, session files, summaries, and model/tool output under `~/.local/state/superpi/`.
- Tool-event notes are metadata-only by default; `full` mode can contain credentials or other secrets from tool arguments and results.
- Provider credentials passed to a child process when an optional provider integration is used.
- The ability to start, continue, resume, and terminate agent processes.

### Relevant threats

- An untrusted local or tailnet user calling the HTTP API.
- A malicious prompt, model response, tool output, dependency, or extension.
- Accidental exposure of credentials through logs, summaries, error messages, or copied output.
- A child process using `bash` to read, change, or delete anything the operating-system user can access in its working directory.
- Symlink, working-directory, process-identity, and shutdown races around task creation or session resume.

### Boundaries and mitigations

- The HTTP listener binds to `127.0.0.1`; authentication is checked before route handling.
- Mutating and state-reading browser requests use a per-process CSRF token. CSRF is a browser-origin control, not authentication.
- The server validates and revalidates working-directory identity and applies restrictive permissions to its state directories and files.
- Child tools are explicitly allowlisted, but the presence of `bash` means the allowlist is not a sandbox.
- Shutdown attempts to close SSE clients and stop children before returning; a timeout prevents shutdown from waiting forever.
- The offline CI gate does not need provider credentials and does not execute live agent tests.

### Known limitations

- There is no built-in TLS, multi-user authorization, OS sandbox, container boundary, or resource isolation for children.
- Basic authentication credentials are configured through the environment; the deployment environment must protect them.
- Tool output is not a trustworthy source of facts and may contain arbitrary or secret-looking text.
- `SUPERPI_LOG_MODE=full` persists tool arguments and results; use `metadata` or `off` when notes are not needed. `off` still exposes metadata to the live SSE stream, but writes no note file.
- `SUPERPI_LOG_RETENTION_DAYS` defaults to `0` (disabled). When enabled, startup cleanup deletes only stale regular `*.jsonl` files directly in the note directory and never workdirs.
- Tailscale exposure does not solve authentication or authorization.
- Live provider, Herdr, tmux, and deployment behavior is outside `npm test` and requires separate review.
- `npm run cleanup` is deliberately gated by `SUPERPI_CONFIRM_CLEANUP=1` and removes only contents of the local `note` and `sessions` state directories. It does not remove workdirs. Stop the server before using it.

## Reporting a vulnerability

Please do not publish credentials, tokens, session files, private working-directory contents, or an exploit reproduction containing sensitive data. Prefer a private GitHub Security Advisory for this repository. If that channel is unavailable, open an issue with the smallest safe description and ask for a private reporting channel before sharing details.

Include the affected version or commit, impact, reproduction steps using synthetic data, and any suggested mitigation. Allow maintainers reasonable time to investigate before public disclosure.

## Local diagnostics

`npm run doctor` checks Node.js, the Pi CLI, optional tmux/Herdr/Tailscale capabilities, and local directory/config presence. It reports statuses without printing environment values, credentials, or command output. A missing required Node.js version or Pi CLI returns exit code 1; optional capabilities may be absent.
