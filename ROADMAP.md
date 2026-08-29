# Repository Excellence Plan

Status: **active hardening plan; not release-ready**

superPi works in its maintainer's current environment, but the repository is not yet ready for a
public GitHub release. This plan defines the work required to make the repository exemplary without
pretending that the application is already a general-purpose or sandboxed product.

No GitHub push, history rewrite, package publication, deployment, or public release is part of this
plan unless the maintainer explicitly authorizes it.

## Target outcome

The first public release will be `v0.1.0`: a well-engineered **experimental Linux application**,
not a stable `1.0` API and not an npm library.

A fresh clone on a supported Linux system must be able to:

1. understand the product and its security boundaries from the README;
2. install reproducibly with `npm ci`;
3. run all credential-free checks with one command;
4. start locally after a clear preflight, or fail with an actionable message;
5. use no maintainer-specific path, hostname, workspace ID, credential helper, or provider account;
6. pass a documented release checklist and GitHub CI;
7. expose no known credential or personal identifier in the tree or published Git history.

A repository may be exemplary while the application remains experimental. Release quality and
product maturity are separate claims.

## Product contract

These are the recommended defaults for the public release.

| Decision | Public contract |
| --- | --- |
| Distribution | Clone-and-run application. Keep `"private": true`; do not publish to npm. |
| Platform | Linux only for `v0.1.0`. Other platforms are unsupported until tested in CI. |
| Runtime | Node.js `>=22.19`; test the minimum version and the current LTS in CI. |
| Agent runtime | Pi is required and pinned to a verified version. Compatibility upgrades are explicit. |
| Providers | Configurable. No personal account, quota service, or model is a universal default. |
| Herdr | Optional preferred session adapter when installed. |
| tmux | Optional fallback for session discovery/resume; required only by the corresponding feature. |
| Tailscale | Optional deployment example, never required for local operation. |
| Network | Loopback-only by default. Remote exposure requires a documented authentication design. |
| Security boundary | The child has the user's OS permissions. `bash` means superPi is not a sandbox. |
| License | MIT is recommended, but the copyright holder must approve it before `LICENSE` is added. |
| Documentation | Public documentation in English; code identifiers need not be renamed solely for style. |

### Non-goals for `v0.1.0`

- npm package publication;
- Windows support;
- multi-user hosting;
- public-internet exposure;
- a claim that the tool allowlist contains shell execution;
- automatic support for every Pi/provider version;
- perfect secret detection in arbitrary command output;
- a large framework rewrite or a TypeScript migration with no user-facing benefit.

## Findings that change the original plan

1. **`private: true` is appropriate.** It prevents accidental npm publication and does not prevent a
   public GitHub repository.
2. **CSRF and authentication are different controls.** Removing the CSRF token from logs is
   necessary, but it does not authenticate a user. The page and SSE endpoints need one coherent
   access model before remote exposure is advertised.
3. **Raw tool logs cannot be promised safe by regex redaction.** Commands and outputs may contain
   arbitrary secrets. The correct controls are restrictive permissions, explicit logging modes,
   retention, deletion, known-secret redaction, and honest documentation.
4. **The current LLM router has no routing effect.** All four profiles select the same model, so a
   mandatory classifier call adds latency, cost, and a failure mode without changing the result.
5. **The OpenCode quota adapter contains a maintainer-specific workspace ID.** Personal provider
   policy must not be in the portable core.
6. **Correctness gaps precede repository cosmetics.** Slot reservation, PID revalidation, shutdown,
   configuration validation, and UI failure handling must be fixed before badges and templates.
7. **CI and live verification are different products.** Public CI must never require provider
   credentials. Live Codex tests remain explicit and manual or run in a protected workflow.

## Work order and release gates

Work is ordered by dependency. A later gate does not begin until the preceding gate is green,
except for documentation that records already-decided behavior.

---

## Gate 0: Ownership and release decisions

### Deliverables

- Confirm the repository will be public on GitHub.
- Confirm MIT or select another license.
- Confirm Linux-only support for `v0.1.0`.
- Confirm that the application stays private on npm.
- Decide whether the maintainer-specific Gitea repository remains the canonical private upstream,
  becomes a mirror, or is replaced by GitHub.
- Decide whether the existing personal workspace ID is sensitive enough to require history rewrite
  and credential rotation before publication.

### Acceptance

All decisions are recorded in this file or an ADR. No destructive history rewrite and no remote
change occurs without explicit maintainer approval.

---

## Gate 1: Portable configuration and product simplification

### BASE-01: bootstrap credential-free checks

Before changing runtime behavior, classify the existing scripts and add the first CI-safe package
commands:

- `test:unit`: deterministic, offline checks;
- `test:integration`: HTTP/process tests with fake adapters and no credentials;
- `check`: syntax and repository consistency;
- `test`: the single public gate aggregating `check`, `test:unit`, and `test:integration`.

Gate 4 expands and standardizes these suites; Gate 1 creates the minimum harness needed to develop
the intervening changes safely.

### CFG-01: centralize configuration

Create one configuration module with schema validation and documented precedence:

1. explicit function/CLI input used by tests;
2. environment variables;
3. user config file;
4. safe built-in defaults.

Validate ports, durations, limits, paths, provider/model pairs, logging mode, and feature flags.
Reject `NaN`, negative durations, impossible limits, and unknown enum values at startup.

### CFG-02: remove personal defaults

- Remove the hardcoded OpenCode workspace ID from `src/quota-go.mjs`.
- Do not assume `~/.config/pi/uso-go.env` or `secret env openrouter` exists.
- Remove personal hostnames, paths, usernames, dated scratch directories, and private-vault references
  from runtime code and public documentation.
- Use `mkdtemp` and `tmpdir()` in tests.
- Keep fixture-only fake paths obviously synthetic.

### CFG-03: make integrations capability-based

Add preflight checks that distinguish:

- required: Node, Pi, writable state/work directories;
- optional feature: Herdr;
- optional fallback: tmux;
- optional deployment: Tailscale;
- optional provider fallback: explicitly configured credentials and model.

The core server must start without Herdr, tmux, Tailscale, OpenCode, OpenRouter, or the maintainer's
credential helper. Features unavailable in that environment must report a precise reason.

### ARC-01: remove the no-op router cost

Keep the profile abstraction only if it changes behavior. Recommended implementation:

- if every profile resolves to the same provider/model/tool policy, select it locally and do not
  call a classifier;
- if profiles differ, enable classification explicitly and fail according to a documented policy;
- support an explicit profile selection that never needs a classifier;
- make provider/model configuration portable and testable.

Do not remove useful routing code merely for aesthetics, but do not impose an LLM call that cannot
change the outcome.

### Gate 1 acceptance

```bash
npm ci
npm test
rg -n '/home/user|node.example|w[r]k_[A-Za-z0-9]|private-notes' src scripts README.md
```

The final search must return no executable default or installation instruction. Synthetic paths in
fixtures should use neutral names and be reviewed explicitly rather than hidden by a broad
allowlist. A clean environment with only Pi configured can pass preflight or get a single
actionable error.

---

## Gate 2: Security model and local data protection

### SEC-01: write a threat model

Add `SECURITY.md` containing:

- trusted user and trusted machine assumptions;
- child process and shell capabilities;
- assets: credentials, working tree, session transcripts, tool logs, CSRF/access tokens;
- local attacker, malicious page, tailnet peer, compromised child, and accidental publication;
- what the tool allowlist does and does not protect;
- supported disclosure process;
- explicit statement that arbitrary tool output may contain secrets.

### SEC-02: separate authentication from CSRF

Before advertising remote access:

- define an authentication mechanism for the initial page and every API/SSE endpoint;
- keep CSRF protection as a separate same-origin control;
- do not put long-lived access credentials in URLs, HTML committed to disk, or logs;
- protect `/eventi-globali` and `/eventi/:id` under the same access model as the REST API;
- set appropriate security headers and cookie attributes if cookies are used;
- test unauthorized, expired, malformed, and cross-origin requests.

Until this exists, document Tailscale exposure as unsupported/experimental rather than secure merely
because it is on a tailnet.

### SEC-03: stop credential persistence

- Never print the CSRF token or access token in normal server logs.
- Ensure `serve.sh` cannot persist credentials accidentally.
- Redact known configured secrets from error messages and structured logs.
- Never include a child credential in returned JSON, SSE payloads, or condensates.

### SEC-04: protect and manage local state

- state directories: mode `0700`;
- note, summary, session metadata, PID, and log files: mode `0600` unless executable;
- use restrictive creation modes, not a later best-effort chmod alone;
- document state locations and data contents;
- provide retention settings and an explicit cleanup command;
- decide safe defaults for logging: `metadata`, `full`, and `off` are preferable to pretending
  arbitrary results can always be sanitized;
- make the privacy consequence of `full` mode explicit.

### SEC-05: harden HTTP and process boundaries

- validate request content type;
- enforce body-size and field-size limits consistently;
- set timeouts and connection limits;
- add `Cache-Control: no-store` to sensitive responses;
- add CSP, `X-Content-Type-Options`, frame restrictions, and a strict referrer policy;
- do not reflect internal paths or secret-bearing error objects unnecessarily;
- retain loopback binding as the default.

### SEC-06: publication scan

Run secret and dependency scans against both the tree and full history. Review vendored/copied code
for licensing and attribution. If a sensitive historical value exists, rotate it first and then
obtain explicit approval before rewriting unpublished history.

### Gate 2 acceptance

Automated tests prove:

- secrets and CSRF/access tokens are absent from logs and responses;
- files and directories have expected permissions under a controlled umask;
- unauthenticated REST and SSE requests fail;
- an authenticated browser flow still works;
- cleanup and retention do not delete user working directories;
- dependency audit has no unresolved high or critical issue.

---

## Gate 3: Correct lifecycle and concurrency

### COR-01: reserve conversation slots atomically

The current check occurs before asynchronous model selection/session resolution. Reserve a slot
synchronously before the first `await`, release it on every rejection/failure path, and exclude the
conductor according to one documented rule.

Test simultaneous `/task` and `/riprendi` requests with `Promise.all`; the number accepted must
never exceed the configured maximum.

### COR-02: revalidate the working directory before spawn

The current `/task` path validates the working directory before awaiting model selection. Resolve
and validate it again immediately before spawn, then pass the verified canonical path forward.
Reject symlink/directory substitution and delete only an empty automatic directory owned by the
request. Add a test that swaps the path while model selection is pending.

### COR-03: revalidate resume identity before kill

Immediately before sending a signal:

- resolve the target again;
- verify PID, process command, session identity, and expected working directory;
- reject on any mismatch;
- prefer signalling through the session adapter when it can guarantee identity;
- never signal `0`, the server PID, or an unverified reused PID.

Test stale PID, PID reuse simulation, disappearing process, mismatched cwd/session, and normal
resume.

### COR-04: graceful, idempotent shutdown

On `SIGINT` and `SIGTERM`:

- stop accepting HTTP requests;
- close SSE clients;
- stop or detach children according to the documented policy;
- flush/close state safely;
- remove only owned PID/socket files;
- enforce a bounded shutdown timeout;
- make a second signal safe.

### COR-05: define crash and restart semantics

Decide and document whether live children are:

- terminated with the server;
- detached and discoverable for resume;
- reconstructed from persisted metadata.

For `v0.1.0`, a simple documented policy is preferable to unreliable recovery. Add startup cleanup
for stale owned state without touching user work.

### COR-06: cleanup rejected automatic work directories

If `/task` creates an automatic directory and later rejects the request before spawn, remove that
directory only when it is empty and demonstrably owned by the current request.

### COR-07: make task transitions explicit

Represent allowed task-state transitions in one module. Reject duplicate terminate/discard/reply
operations consistently and make operations idempotent where practical.

### Gate 3 acceptance

Credential-free integration tests cover concurrency, shutdown, working-directory substitution,
stale process identity, failed spawn, router failure, queue behavior, and cleanup. No test leaves a
process, tmux session, worktree, temporary branch, PID file, or scratch directory behind.

---

## Gate 4: Test architecture and code quality

### Test tiers

#### `npm run test:unit`

Fast, deterministic, offline, no Pi process, no tmux, no Herdr, no Tailscale, no credentials.
Use Node's test runner where practical so failures, timeouts, and skipped capabilities are standard.

Covers parsers, gates, configuration, router decisions, condenser, state transitions, redaction,
permissions, input validation, and UI helper logic.

#### `npm run test:integration`

Real HTTP/filesystem/process boundaries with fake provider/Pi/session adapters. No network and no
credentials. This is the main GitHub CI suite.

Covers API, SSE, concurrency, graceful shutdown, child failure, session discovery fallback, and
browser-facing state.

#### `npm run test:system`

Requires local Pi and may require tmux/Herdr. Uses temporary directories and an explicitly selected
provider. It is not required for untrusted pull requests.

#### `npm run test:live`

Costs provider quota and requires credentials. It must require an explicit opt-in environment flag,
print the selected provider/model before starting, and never run from ordinary CI. A protected
manual GitHub workflow may run a bounded smoke subset.

#### `npm run test:deployment`

Optional Tailscale smoke test. It must use discovered/configured names and remove only the route it
created; it must never call a global `tailscale serve reset` as normal teardown.

### TST-01: classify every existing script

No script may be implicitly included in `verify`. Maintain one documented manifest that names its
tier, capabilities, expected duration class, and cleanup behavior.

### TST-02: replace dated global scratch names

Use unique temporary resources per process. Cleanup must be in `finally`, scoped to resources owned
by the test, and verified.

### TST-03: browser behavior

Add browser-level coverage for:

- task creation;
- SSE reconnect/snapshot deduplication;
- dialog reply success and failure;
- terminate/discard failure handling;
- keyboard and focus basics;
- escaped untrusted output;
- narrow/mobile viewport smoke test.

### QUA-01: standard checks

Provide:

```bash
npm test
npm run test:integration
npm run check
npm run lint
npm run format:check
npm run audit
```

`npm test` is the single credential-free public gate and must aggregate `check`, `test:unit`, and
`test:integration`. The individual commands remain available for focused development. `check`
should include syntax/type diagnostics appropriate to the JavaScript codebase, JSON checks, shell
syntax, and repository consistency. Prefer JSDoc plus `checkJs` over a wholesale TypeScript
migration unless types demonstrate a concrete benefit.

### QUA-02: modularize high-risk code

Split `src/server.mjs` by responsibility while preserving behavior:

- validated configuration;
- authentication/security headers;
- HTTP routing and body parsing;
- task manager/state machine;
- child/session adapters;
- persistence/logging;
- graceful shutdown.

Do this incrementally behind tests. File size alone is not a reason to rewrite working code.

### Gate 4 acceptance

A fresh clone runs `npm ci && npm test` offline and without secrets; that one command includes the
integration and repository checks. Coverage thresholds should target security and lifecycle modules
first; a global percentage must not encourage low-value tests.

---

## Gate 5: User experience, operations, and documentation

### UX-01: pessimistic UI actions

For message, dialog reply, terminate, discard, and resume:

- check `response.ok`;
- change local state only after success;
- show the server's safe error message;
- keep controls retryable after failure;
- prevent duplicate submissions while a request is pending.

### OPS-01: separate local run from remote exposure

Provide distinct commands:

- `npm start`: foreground, loopback-only server;
- optional service example: systemd user unit with safe permissions and shutdown;
- optional Tailscale guide/script: scoped setup and scoped teardown, no machine-specific hostname.

Add a `doctor` or `preflight` command that reports capabilities without printing secrets.

### DOC-01: task-oriented README

The README should contain:

- one-sentence value proposition;
- honest experimental status;
- screenshot/demo;
- supported environment;
- five-minute local quick start;
- configuration example;
- security warning near the first run command;
- feature overview;
- links to architecture, security, contributing, changelog, and troubleshooting;
- test-tier commands;
- no references to private notes, personal decisions, or commit archaeology.

Move historical implementation commentary to changelog entries or ADRs only when it helps future
maintenance.

### DOC-02: supporting documents

Add:

- `LICENSE` after approval;
- `SECURITY.md`;
- `CONTRIBUTING.md`;
- `CODE_OF_CONDUCT.md` if external contributions are invited;
- `CHANGELOG.md` following Keep a Changelog conventions;
- `docs/architecture.md` with trust boundaries and data flow;
- `docs/configuration.md`;
- `docs/testing.md`;
- `docs/troubleshooting.md`;
- `.env.example` only if environment files are officially supported, with placeholders only;
- ADRs for authentication, child shutdown/recovery, and router policy.

### DOC-03: package metadata

Set `version` to `0.1.0` only for the release candidate. Update description, license, repository,
issues, homepage, engines, and scripts. Keep `private: true`. Do not add `bin` or `files` unless an
installation/distribution design needs them.

### Gate 5 acceptance

A reviewer unfamiliar with the maintainer's environment can identify prerequisites, start locally,
understand the risk of `bash`, run offline tests, locate state, clean up, and report a vulnerability
without reading source code or private notes.

---

## Gate 6: GitHub repository engineering

### Repository files

Add only useful community files:

- `.github/workflows/ci.yml`;
- `.github/workflows/codeql.yml` if its signal is useful for this JavaScript application;
- `.github/dependabot.yml` with bounded update frequency;
- issue forms for bugs and feature requests;
- pull-request template with test/security checklist;
- `CODEOWNERS` only if ownership rules are real;
- funding, citation, governance, and elaborate templates only if the project actually needs them.

Avoid badge collecting and policy boilerplate that nobody will maintain.

### CI design

For pushes and pull requests:

- minimal `permissions`;
- pinned action major versions (or commit SHAs if the maintenance policy supports updating them);
- Node minimum + current LTS matrix;
- `npm ci` with cache;
- offline unit/integration/check suites;
- dependency audit and secret scan;
- no repository/provider credentials for forked PRs;
- concurrency cancellation for superseded runs;
- uploaded logs only after secret-safe review and with short retention.

Protected manual workflow:

- explicit environment approval;
- bounded live smoke tests;
- no execution of untrusted pull-request code with secrets.

### Branch and release settings

After the local repository is release-ready and only with maintainer authorization:

- create/configure the GitHub repository;
- protect `main`;
- require CI and resolved review conversations;
- disable force push and branch deletion;
- enable secret scanning and dependency alerts where available;
- configure topics, description, social preview, and issue links;
- decide Gitea/GitHub canonical and mirror behavior;
- do not push until history scanning and release review pass.

---

## Gate 7: Release candidate and publication

### Clean-clone rehearsal

From a new temporary clone, with no maintainer dotfiles implicitly available:

```bash
npm ci
npm test
npm run test:integration
npm run check
npm run audit
npm start
```

Verify startup, local UI, preflight failures, state permissions, graceful shutdown, cleanup, and the
optional system test according to the documented support matrix.

### Release checklist

- all previous gates accepted;
- working tree clean;
- CI green from the candidate commit;
- no unresolved P0/P1 issue;
- no high/critical known vulnerability without a documented exception;
- full-tree and full-history secret scans reviewed;
- third-party licenses and copied code reviewed;
- version and changelog aligned;
- README screenshot/demo current;
- rollback instructions tested;
- release notes state experimental status and known limitations;
- maintainer explicitly authorizes remote creation/push/tag/release.

Then, and only then:

1. create or select the GitHub remote;
2. push the reviewed history;
3. create signed/annotated tag `v0.1.0` according to the chosen policy;
4. publish GitHub release notes;
5. verify links and clean installation from GitHub;
6. open a `v0.1.x` milestone for issues discovered after release.

## Definition of done

superPi's repository is exemplary when all statements below are true:

- **Truthful:** claims match tested behavior and limitations are prominent.
- **Portable:** no personal infrastructure is required by default.
- **Secure by default:** loopback-only, authenticated before remote exposure, restrictive local
  permissions, explicit retention, and no tokens in logs.
- **Correct under failure:** concurrency, shutdown, stale process identity, network failure, and
  rejected actions are tested.
- **Reproducible:** one offline command runs the public CI suite from a clean clone.
- **Maintainable:** high-risk responsibilities are separated, checks are standard, and tests explain
  capabilities rather than relying on dated local fixtures.
- **Welcoming:** installation, architecture, security reporting, and contribution paths are clear.
- **Governed:** license, release process, dependency updates, branch protection, and disclosure policy
  are real and maintained.
- **Cleanly released:** history is reviewed, CI is green, version/changelog/tag agree, and no push or
  publication occurs without explicit maintainer approval.

## Immediate implementation sequence

The first implementation batch should be deliberately narrow and testable:

1. confirm the Gate 0 ownership and license decisions;
2. classify tests and add CI-safe `npm test` plus `npm run check`;
3. add validated central configuration;
4. remove personal workspace, hostname, path, and credential-helper defaults;
5. write the threat model and authentication ADR;
6. fix state permissions and token logging;
7. implement the chosen authentication model for page, REST, and SSE;
8. fix slot reservation, cwd revalidation, PID revalidation, and graceful shutdown;
9. only then add the GitHub workflow and final public-facing documentation.

This order prevents a polished README and green-looking workflow from hiding unsafe or
maintainer-specific runtime behavior.
