# Contributing

Thank you for helping improve superPi. The project is experimental and Linux-only for the current release candidate.

## Before opening a change

1. Read [the architecture](docs/architecture.md), [the security policy](SECURITY.md), and [the testing guide](docs/testing.md).
2. Keep the change focused and avoid adding dependencies unless the standard library cannot provide the required behavior.
3. Never commit credentials, session files, provider output containing secrets, or machine-specific paths.

## Development

```bash
npm ci
npm test
npm run lint
npm run format:check
```

`npm test` is deliberately offline. Do not make the public gate depend on a provider, Herdr, tmux, Tailscale, a login session, or a personal workstation tool. Manual live and system suites are documented separately.

Use Node's built-in APIs and the repository's existing style. Keep process, filesystem, and HTTP tests deterministic, use unique temporary resources, and clean up owned resources in `finally` blocks.

## Pull requests

Describe the user-visible or operational change, the security impact, and the commands you ran. Add or update documentation when configuration, state, endpoints, support, or test behavior changes. Keep logs and examples synthetic.

A pull request should:

- pass `npm test`;
- include focused tests for behavior changes;
- explain any intentionally untested live capability;
- avoid unrelated formatting or refactors;
- contain no secrets or personal data.

## Reporting security issues

Follow [SECURITY.md](SECURITY.md) instead of posting sensitive details in a public issue.
