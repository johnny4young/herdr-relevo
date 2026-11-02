# Terminal follow-up — 2026-11-02

The isolated `terminal.run` block is resolved in the MNB test launcher. No permission, security setting, personal profile, installed binary, account or model was changed.

At 16:59 UTC, a clean herdr-core 0.1.17 started from the task's Documents directory and answered `server status` in 9.7 ms. One bounded `/bin/sh` terminal request then timed out at eight seconds; `get` and `status` also timed out at three seconds. No model was involved. A standalone `os.openpty()` allocation succeeded, so the evidence does not support a general inability to allocate a PTY.

Individually verified core PID 89928 and holder 89937 owned only the fixture sockets. A one-second stack sample showed all 745 main-thread samples in `__private_getcwd → __getcwd → open$NOCANCEL → __open_nocancel`; the holder was waiting in accept/recv. `lsof -d cwd` confirmed both inherited the task directory under Documents. The two test processes were stopped after identification. The earlier Operation not permitted messages predated this clean probe and do not establish its cause.

At 17:03 UTC, the same binary, session, HOME, XDG paths, command and target terminal folder were used, with only the daemon's launch cwd and matching PWD set to `/tmp/hmnb-20261102`. `terminal.run` returned `t1` in **52.6 ms**, the shell exited 0 and readback returned `MNB_TERMINAL_PROBE_DONE`. A subsequent status request completed in **6.4 ms**. The underlying macOS cause of the Documents/getcwd stall remains unknown; this is a verified local workaround, not a claim of an upstream release fix.

`scripts/mnb-terminal/launch-isolated.sh` now changes to its existing temporary profile directory before starting the app/core. It fails instead of falling back if that directory is missing. No update or modification of Herdr upstream is required for this test setup.

## Native Inbox continuation, zero models

With the recovered core and the same isolated Relevo profile, `space.new` created one new synthetic terminal. The fixture emitted working → blocked/question through the [documented OSC 7501 encoding](https://github.com/herdrdev/herdr-core/blob/v0.1.17/crates/herdr-core/src/status.rs). A test-only native controller called the unchanged `Inbox.answer/press` methods on a hash-verified copy of the installed PR #4 Inbox source. It selected Beta once; the real PTY received hex `1b5b420d` (Down, Enter), confirmed selection 2 and reported success in **2.02 seconds from fixture start**. This includes readiness/status scanning; it is not a keystroke latency benchmark.

The program then reported done, and the actual Inbox showed uncommitted work for the synthetic checkout. The controller used programmatic invocation, not mouse input or a genuine Claude/Codex question UI. Fixture sources are in `scripts/mnb-terminal/`; copy the installed fixture-only Relevo mod to a new test-only mod, replace only its main entry with `inbox-probe.js`, pass the newly returned terminal address as `props.terminal`, and run `status-agent.py` in the fresh test space. Never point it at a personal profile or another terminal. The test's space/window and isolated core were closed afterward. CPU/RAM measurements were not repeated.

## Remaining user action

Claude Code 2.1.316 and Codex CLI 0.166.0 are installed. Both explicitly isolated CLI profiles report **not logged in**. No existing personal credential, history or session was copied or read, and no model turn was started. Authentication is the remaining prerequisite to real-provider testing, not terminal creation.

From the herdr-relevo checkout root in a normal local terminal, the user can authenticate existing accounts through their own secure CLI flows:

```sh
./scripts/mnb-terminal/login-isolated.sh codex
./scripts/mnb-terminal/login-isolated.sh claude
```

These commands only perform login inside the test profile. They do not create a new account, buy credits, supply an API key, start a task or select a model. Do not paste credentials/tokens into chat. After login, verify a supported lightweight model and minimum effort before any turn; Codex must also use `--no-daemon` to keep execution inside hc. Actual provider questions, review delivery, handoffs, authenticated quotas and long-duration use remain unverified.

Full raw diagnostics, stack samples and local screenshot are retained in the task workspace at `evidence/terminal-diagnostic-20261102/`. `result.json` contains the public result and source proof. The earlier CPU evidence remains unchanged and scoped to its original fixtures.

A cold app launch with the core previously stopped also created terminal t3 and returned the expected marker. The first immediate read preceded program output; a later read of that same terminal confirmed the marker while core status still responded. No duplicate terminal was requested. The test space, window and core were closed normally.
