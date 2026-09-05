---
name: test-t3-app
description: Launch, retain, and test the T3 Code web app in isolated development environments, including first-try browser authentication with one-time pairing URLs, pairing-token recovery, worktree-safe state directories, cross-turn dev server lifecycle, and direct SQLite inspection or fixture seeding. Use when an agent needs to run T3 locally, iteratively test UI behavior with a human, recover from an expired or consumed pairing token, isolate dev state, or prepare test data in state.sqlite.
---

# Test T3 App

Use this skill for the web client. For iOS Simulator, Android Emulator, or physical-device testing against an isolated T3 backend, use the sibling [`test-t3-mobile`](../test-t3-mobile/SKILL.md) skill.

## Start the shared isolated app

Run the launcher from the checkout whose code must be tested:

- `vp run dev:app --preview` starts web for a native T3 agent. After the launcher prints the actual ready URL, open that URL with `preview_open`.
- `vp run dev:app --external` starts web and opens the ready app in the external browser.
- `vp run dev:app --desktop` starts Electron with DevTools disabled and a recorded CDP endpoint. Add `--workspace <+1|-1|id|none>` only when explicit placement is required.

The command-line default is `--external`; T3's **Dev Web** project action spells `--preview` explicitly. When the current client has no integrated preview, that action uses the external browser instead. The launcher owns startup pairing, uses the checkout's `.t3` as its isolated home, and creates or reuses the editable fixture repository at `.t3/test-project`. It prints the actual ports and ready endpoint after startup; do not infer a port or open an earlier URL.

These convenience commands launch on the checkout's machine. **Dev Web** requires the primary local environment; secondary desktop backends, remote, relay, and SSH environments are outside this convenience action. Use the existing shared-development workflow for remote testing. After attaching to its terminal, the action gives a cold build ten minutes to emit its ready URL. Terminal exit or leaving the thread cancels the listener. If startup times out, inspect the terminal and stop the owned run before retrying.

Choose the checkout deliberately:

- Use the base checkout for exploratory work against the current fork trunk.
- Use the implementation worktree while building and verifying a feature.
- Use a checkout at the exact candidate UAT SHA for release acceptance, and verify `git rev-parse HEAD` before launch.

Keep one backend for one checkout home running at a time. Stop the owned launcher before changing surface for that checkout, then start the new selection against the same retained home. A different checkout has its own `.t3` home and may run concurrently when the test needs it. The fixture repository, edits, registered project, threads, and authentication survive restarts. Do not reset the fixture or copy state from the stable T3 installation.

`t3.json` project actions are imported into T3 once and then stored as project-owned copies. After changing a checked-in action, update its imported copy before testing it. **Setup Worktree** only prepares dependencies, environment links, and caches; it does not launch the app or reset test state.

The checkout-local home deliberately excludes ambient T3 runner ports and the shared `~/.t3` state. Shared browser dev remains single-origin, so never set `VITE_HTTP_URL` or `VITE_WS_URL`.

### Verify a shared environment before human handoff

When another person will use a printed pairing URL, first open the shared origin without the pairing path or fragment in the controlled browser and confirm the T3 Code app loads. This browser navigation is required even when curl succeeds because browsers block some otherwise reachable ports before making a network request.

Do not open the other person's complete pairing URL during this reachability check; doing so consumes its one-time token. If the agent also needs an authenticated browser, create and consume a separate pairing token, then leave a fresh token for the other person.

## Preserve the environment while iterating

Treat the overall testing or implementation loop—not an assistant turn or one verification pass—as the environment lifecycle boundary.

- Keep the dev process, base directory, selected ports, authenticated browser tab, registered projects, and seeded fixtures alive while the user may inspect the result or request follow-up changes.
- Do not stop the server merely because one verification pass completed or because you are yielding a response to the user.
- Before starting another environment, check whether the existing process and browser tab still serve the task. Reuse them when healthy instead of discarding useful state.
- On a later turn, verify that the existing process is alive and reuse its printed ports and base directory. If it exited, restart with the same base directory; create a new pairing token only when the browser session is no longer valid.
- Tell the user when a test environment remains available, including its non-secret web URL when useful. Include a pairing token only when the user still needs to pair (see below).

## Authenticate the browser on the first navigation

1. Wait for the server log that says authentication is required and includes a URL ending in `/pair#token=...`.
2. Use the controlled in-app browser or browser-automation surface available to the agent. Do not use a system-browser launch command during automated testing.
3. Open that complete URL exactly once as the controlled browser's first navigation. Preserve the fragment and token verbatim.
4. Wait for the pairing exchange and redirect to finish before navigating elsewhere.
5. Continue in the same browser context so its stored bearer session remains available.

Keep pairing URLs out of screenshots, committed files, and durable logs. When the user asked for a shared environment, the deliverable IS the full pairing URL — paste it in your reply, token and all; a bare origin is useless to them. A pairing token is short-lived and single-use; opening the URL in another browser or opening it twice can consume it, so never open a URL you handed to the user.

## Recover a consumed or expired pairing token

Run `node apps/server/src/bin.ts pair --base-dir "$PWD/.t3"` from the same checkout root. The explicit home is required in the base checkout as well as worktrees; it prevents the pair command from selecting the installed app's home. It prints a fresh `Pair URL` against the running dev server's web origin.

Tokens from `pair` carry standard client scopes. The startup pairing URL carries admin scopes; if the user needs Settings → Connections management (`access:write`), restart the server and hand over the new startup URL instead.

## Inspect or seed SQLite state

Read [references/sqlite-fixtures.md](references/sqlite-fixtures.md) before changing the database.

- Use `node apps/server/scripts/t3-sqlite-state.ts query` for schema discovery and read-only checks.
- Stop the dev server before using `node apps/server/scripts/t3-sqlite-state.ts exec`, then restart it with the same base directory.
- Seed projection tables only for disposable UI fixtures. Use application commands and APIs when testing business behavior or projection correctness.
- Use the auth CLI, not direct `auth_*` table edits, for pairing and sessions.

The helper refuses to write to the shared `~/.t3` directory by default and creates a database backup before each mutation.

## Tear down only when the testing loop is finished

Tear down when the user explicitly asks, confirms the iteration is finished, or the overall task is genuinely complete with no pending human review. Do not infer completion from the end of an assistant turn.

When teardown is appropriate:

1. Stop the dev process with its terminal interrupt.
2. Preserve the checkout's `.t3` home and `.t3/test-project`; they carry the retained test state for the next run.

If completion is uncertain, keep the environment alive and mention that it is retained for further iteration. When authentication, migrations, or fixture state becomes ambiguous, inspect the retained home and name the problem; do not replace it with a fresh home as an implicit reset.

## Troubleshoot predictably

- If the browser shows an unauthenticated pairing screen, issue a new token instead of retrying the consumed URL.
- If the pairing URL is no longer visible, use the explicit-home `pair` command above. It reads the running server's endpoint; `pair` does not accept `--dev-url` or `--base-url`.
- If the replacement token is rejected, verify that the pair command and launcher ran from the identical checkout and use the printed web URL.
- If the UI shows unexpected data, verify that every command uses that checkout's `.t3` home before editing anything.
- If ports move because another instance is running, trust the current dev-runner output rather than assuming ports `13773` and `5733`.
