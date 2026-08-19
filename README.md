# superPi

A control plane for AI coding agent sessions. It starts, observes, and manages [Pi](https://github.com/earendil-works/pi-mono) coding agent children from a single point of contact, instead of letting each one run in its own terminal window with no shared record of what happened.

## Why this exists

A headless coding agent left on its own has two recurring problems. It forgets to report what it did, or it invents a summary that does not match what actually happened. And a safety filter written as a pattern match on command text can be recognized and worked around by a model capable enough to notice the pattern, which is a real failure mode confirmed by testing it directly, not an assumption.

superPi is built around keeping two things separate that usually get blended together:

- **Deterministic note taking.** Whatever observes a child session writes down what happened, tool call by tool call, as it happens. The child never gets to summarize its own turn from memory.
- **Structural guardrails.** What a child is allowed to do is decided by which tools it is given access to, not by a list of dangerous patterns to detect and block. An allowlist cannot be talked around the way a text filter can.

## How it works

The core loop is a spawner built on `RpcClient` from `@earendil-works/pi-coding-agent`. Every child gets an explicit session id, a working directory, and a fixed set of tools. Three pieces sit around that loop:

- A **note taker** that writes a structured log of every tool call to disk in real time, so the record survives even if the process is killed mid task.
- A **condenser** that builds a short summary from that log alone, never by asking the child to describe what it did.
- A **gate** that runs before every spawn: the working directory can never be the user's home directory or a small set of protected paths, and a usage quota check has to pass. Every rejection carries a specific reason. Nothing fails silently.

On top of that sits a small web server (plain Node `http` plus server-sent events, no framework) with a terminal-styled page that can be reached from a phone over Tailscale. It supports several conversations at once, each with its own colored tab showing whether the agent is working, waiting on a confirmation, idle, finished, or failed. A conversation stays alive across multiple messages instead of exiting after each turn. An existing tmux session running Pi interactively can be taken over from the page, which hands control to the browser without losing the session's history. A fixed extra tab, the conductor, talks to superPi itself rather than to a coding task, and can read the state of other conversations and send messages into them.

When no working directory is given, superPi creates one automatically under a dedicated folder, a new subfolder per conversation, and asks the child for a short honest summary of what it did before shutting it down. That summary and the tool log are saved next to the code the child touched.

The default model provider is a paid one with a rolling usage quota. If that quota is exhausted or cannot be checked, the gate automatically falls back to OpenRouter, checking the real remaining balance before letting a session start on it. Ordinary use is unaffected by this: the fallback only ever activates when the primary provider says no.

## How it was built

Each piece was planned first and built second, in separate steps that were always re-verified before moving on to the next one. Planning was done by Claude; construction and testing of each phase was carried out by a separate Pi agent working from a written brief, then checked independently rather than taken on trust. Several real bugs, including one where plain text replies from the agent never reached the page at all, were found by actually using the interface, not only by automated tests, and were fixed with the same plan-then-verify approach.

The result is a project built almost entirely through directing AI agents rather than writing code by hand, with a deliberate emphasis on verification at every step: a written brief and a working feature are not the same thing, and this project treats them accordingly.

## Current status

superPi is not part of daily use anymore. After building and using it for a while, the better fit turned out to be fewer, more focused agent sessions rather than juggling many in parallel, so the tool that was built to manage many sessions at once stopped being the thing actually needed day to day. The code is complete, tested, and working as described here. It is published in case the approach, or parts of it, are useful to someone else.

## Getting started

```bash
npm install
npm run verify
```

`npm run verify` runs the core suite (spawner, note taker, condenser, gate). A larger set of end to end tests covers multi-conversation handling, continuous chat, the web server, the conductor tab, and the OpenRouter fallback; each lives in `scripts/` as its own `test-*.mjs` file and can be run directly with `node`.

Requirements: Node 22.19 or later, `@earendil-works/pi-coding-agent` (pinned, since `RpcClient` behavior is not guaranteed stable across versions), and at least one configured Pi model provider. To expose the web page outside localhost, set `TAILSCALE_HOSTNAME` to your machine's MagicDNS name and run `npm run serve`.

## License

MIT. See [LICENSE](LICENSE).
