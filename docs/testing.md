# Testing

## Public gate

The public gate is credential-free and offline:

```bash
npm test
```

It runs, in order:

1. `npm run check`: syntax checks for tracked JavaScript, shell syntax, JSON parsing, and tracked secret-looking filename checks.
2. `npm run lint`: ESLint flat-config checks for tracked JavaScript and MJS, using only deterministic local rules.
3. `npm run format:check`: checks trailing whitespace, CRLF, final newlines, and canonical two-space JSON formatting.
4. `npm run test:unit`: deterministic suites with no Pi process, provider, Herdr, tmux, Tailscale, or credentials.
5. `npm run test:integration`: a real server child process and HTTP requests for Basic authentication, security headers, SSE response headers, and graceful shutdown. It creates no task and therefore starts no Pi child.

`npm run audit` is a separate dependency check and may need registry access. `npm run doctor` is a local preflight and exits non-zero only when Node.js or the Pi CLI is unavailable. `SUPERPI_CONFIRM_CLEANUP=1 npm run cleanup` is a manual destructive state cleanup; it must be run only after stopping the server and never touches workdirs.

## Unit suites included by `test:unit`

| Suite | Coverage | Duration/cleanup |
| --- | --- | --- |
| `scripts/test-fase4.mjs` | CWD, quota parser, gate decisions with injected fixtures | Fast; `.test-run/` is ignored |
| `scripts/test-config.mjs` | Invalid startup configuration fails closed | Fast; temporary home removed |
| `scripts/test-router.mjs` | Profile parsing and local router configuration | Fast; temporary directory removed |
| `scripts/test-sessioni-herdr.mjs` | Herdr/tmux adapter contract with fake binaries | Fast; temporary fake binaries removed |
| `scripts/test-scheda-vuota.mjs` | Browser helper behavior with a DOM stub | Fast; in-memory only |
| `scripts/test-tre-bug.mjs` | Browser regression helpers with a DOM stub | Fast; in-memory only |

## Integration smoke

`scripts/test-server-smoke.mjs` is launched by `scripts/test-integration.mjs` as a child process. It uses an ephemeral port, a temporary workspace, synthetic Basic-auth values, and a sanitized environment. Its `finally` block removes the temporary workspace and force-stops only the server child if graceful shutdown did not complete.

The smoke checks unauthorized access, authenticated HTML access, security headers, CSRF protection on an API, authenticated SSE headers, and `SIGTERM` shutdown. It never calls a provider and never creates a conversation.

## Script manifest

The following manifest classifies every existing script. A script not listed in `npm test` is manual by design.

| Script | Tier | Capabilities | Duration | Cleanup/notes |
| --- | --- | --- | --- | --- |
| `scripts/check.mjs` | check | Node/bash/JSON/repository checks | Fast | Read-only; tracked files only |
| `scripts/lint.mjs` | lint | ESLint flat-config checks for JS/MJS | Fast | Read-only; local dependency only |
| `scripts/format-check.mjs` | format | Whitespace, newline, and JSON invariants | Fast | Read-only; tracked and non-ignored working-tree files |
| `scripts/test-ci.mjs` | unit harness | Runs the six offline unit suites | Fast | Delegates cleanup to suites |
| `scripts/test-integration.mjs` | integration harness | Runs the HTTP smoke | Seconds | Child smoke owns cleanup |
| `scripts/test-server-smoke.mjs` | integration | HTTP auth, headers, SSE, shutdown | Seconds | Ephemeral port/temp dir; SIGKILL fallback only for owned child |
| `scripts/_paths.mjs` | support | Shared local fixture paths | N/A | Not a test entry point |
| `scripts/passo0-rpcclient.mjs` | live | Real Pi RPC/provider event ordering | Minutes | Stops its child; requires live provider |
| `scripts/test-fase1.mjs` | live | Real spawner and assistant response | Minutes | Stops child; requires live provider |
| `scripts/test-fase2.mjs` | live | Real scribe and forced child kill | Minutes | Uses `.test-run/`; kills/stops owned child |
| `scripts/test-fase4.mjs` | unit | Gate and quota fixtures | Fast | Included in `test:unit` |
| `scripts/test-fase5.mjs` | live | Real Pi tool allowlist and adversarial prompt | Minutes | Stops children; requires live provider |
| `scripts/test-fase6.mjs` | live | Real child error and condenser result | Minutes | Stops child; requires live provider |
| `scripts/test-fase9.mjs` | live | Full HTTP/SSE flow with real Pi children | Long | Stops server/children; requires live provider |
| `scripts/test-allowlist-figli-reali.mjs` | system | In-process server, real tmux and gcc fixtures | Minutes | Removes test tmux session, build, and session fixture |
| `scripts/test-cartella-default.mjs` | live | Automatic workspace and summary flow | Long | Uses temporary workspace and owned server/child |
| `scripts/test-chat.mjs` | live/system | Continuous chat and resume behavior | Long | Uses server, children, and test tmux |
| `scripts/test-conduttore.mjs` | live | Conductor conversation and extension | Long | Stops owned server/children |
| `scripts/test-conferme.mjs` | live | Real confirmation broker and extension UI | Long | Stops child; uses live Pi |
| `scripts/test-f-conferma-hive-safety.mjs` | live/system | Confirmation behavior with external safety extension | Long | Creates and removes an external test worktree; review before use |
| `scripts/test-fix-risposta.mjs` | live | Text reply and conductor regressions | Long | Stops owned server/children |
| `scripts/test-multi.mjs` | live/system | Multi-conversation, limits, and session behavior | Long | Uses test server/children and a test window |
| `scripts/test-openrouter-riserva.mjs` | live | OpenCode/OpenRouter fallback paths | Variable | May contact external providers; credentials prohibited in CI |
| `scripts/test-quota-openrouter.mjs` | live | OpenRouter credential and credit checks | Variable | May use runtime credential/network; never public CI |
| `scripts/test-rifiniture.mjs` | live/system | Resume, waiting, and UI navigation flows | Long | Uses owned test server/children/window |
| `scripts/test-router.mjs` | unit | Deterministic router decisions | Fast | Included in `test:unit` |
| `scripts/test-scheda-vuota.mjs` | unit | DOM-stub browser regression | Fast | Included in `test:unit` |
| `scripts/test-sessioni-herdr.mjs` | fixture/integration | Fake Herdr/tmux/claude adapters | Seconds | Temporary fake binaries; excluded from unit by policy |
| `scripts/test-sessioni.mjs` | live/system | Real session discovery and resume | Long | Uses owned server and local adapters |
| `scripts/test-tre-bug.mjs` | unit | DOM-stub browser regressions | Fast | Included in `test:unit` |
| `scripts/test-g-tailscale.sh` | deployment | Optional Tailscale reachability | Variable | Requires operator access/network; manual only |
| `scripts/serve.sh` | deployment | Experimental Tailscale route helper | Persistent | Manual setup; never part of CI or `npm test` |
| `scripts/stop-serve.sh` | deployment | Stop the registered server and restore the saved Tailscale configuration | Fast | Validates owned state; never part of CI or `npm test` |
| `scripts/doctor.mjs` | diagnostic | Node, Pi CLI, optional integrations, state/config presence | Fast | Read-only; never prints secrets |
| `scripts/cleanup-state.mjs` | maintenance | Explicit note/session state cleanup | Fast | Requires `SUPERPI_CONFIRM_CLEANUP=1`; never touches workdirs |
| `scripts/test-operations.mjs` | unit | Logging modes, state cleanup confinement, doctor output | Fast | Included in `test:unit`; synthetic temporary home |

## Live and system rules

Run manual suites only with synthetic working directories, explicit provider selection, and credentials supplied by the runtime environment. Do not run them from ordinary CI or a forked pull request. Inspect cleanup behavior before using a deployment or external-integration script.
