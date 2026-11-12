# Fork sync

> Runbook for `RSI-Software/t3code-hyprws`. Using T3 Code? See [docs/user](../user/).

The `hyprws upstream sync` workflow is the **normal operator**; a maintainer steps in only to **unblock a run** or **cut a release**.
This runbook owns the **driver, its report, and the land run**.
The [`fork-sync`](../../../.agents/skills/fork-sync/SKILL.md) skill owns the **session procedure**: target, start order, resolving, tip work, hand-off.
[Fork development](../internals/fork-development.md) owns stack discipline.

## Model

`hyprws` is the **single fork trunk**; `scripts/fork-sync.ts` runs **one upstream release tag** per run, with one exit code and one report.

- `fork:sync [<tag>]`: a **session**; rebases only
- `fork:sync --land`: the **land run**; workflow only
- `fork:sync <tag> --refold`: **folds** an **applied tag**

A session **writes no trunk**, candidate, or issue; `--land` **refuses to run** unless `GITHUB_ACTIONS=true`.
The **lease** is the `origin/hyprws` sha the stack replays; the trunk push is **`--force-with-lease=hyprws:<lease>`**.

The rebase **never merges** upstream and **never drops** a commit:

- Only a **`fixup!` moves**, beneath its owner
- A fixup **names exactly one** fork commit
- A squash's ` (#N)` **counts** in that name
- Its owner **gains the fixup's PR link**
- A tip that **drops a PR link** is refused

The owner's new link joins its `Squashes:` list.
The link guard exempts a commit **the target carries**: patch-identical, or superseded with every path it touched identical to the target.
Typecheck and tests miss a dropped hook, so the `hooks` step **counts marked lines per key**; a tip commit's **`Fork-Hook-Retired: domain/name`** trailer retires one the target made obsolete.

| Step    | Does                                           | Fails when               |
| ------- | ---------------------------------------------- | ------------------------ |
| fetch   | `upstream` tags, `origin/hyprws`, the marker   | fetch error              |
| target  | named, kept, marker's, or newest tag           | not a release tag        |
| rebase  | `git rebase -i --autosquash <tag>`             | a seam no resolver fixes |
| carry   | cherry-picks trunk commits since the lease     | a pick conflicts         |
| hooks   | each trunk hook keeps its marked lines         | a hook lost lines        |
| check   | session: `vp run fork:ci` on the tip           | the battery is red       |
| ci      | land: [candidate CI](#candidate-ci) on the tip | the run is not green     |
| push    | land: the leased trunk push                    | lease refused            |
| blocked | land: the [attention issue](#attention-issue)  | `gh` refuses the write   |
| report  | `.t3/fork-sync/<tag>.json`, before any post    |                          |

An applied run **cuts the nightly** by itself: `hyprws-release.yml` runs on `hyprws CI` completion and needs a **green run on the current trunk tip**.

## Candidate CI

The land run pushes the trunk directly, so **`sync/candidate` runs `hyprws CI`** in place of a pull request.

1. A sha with a candidate run **reuses it**
2. A new sha **passes `vp run fork:ci`** first
3. It **force-pushes** to `sync/candidate`
4. The driver **waits out the whole run**
5. Only **that green sha** reaches the trunk

`sync/candidate` has **no ruleset**; waiting out the run makes **every red job show**.
A run that **never starts or never finishes** inside its deadline is red; `candidateCi` in `scripts/fork-sync.ts` owns the deadlines.
On red, **`hyprws` stays** and `ci.jobs` names each red job.
`fork:ci` **skips stale-delete** on a candidate: every commit is a replay.
A `hyprws` push of a sha **already green on `sync/candidate`** skips every `hyprws CI` job.

The land run is the **only trunk writer**; a [`fork-fold`](../../../.agents/skills/fork-fold/SKILL.md) fold lands through the **same marker and gate**.

### Workflow copies

Each `hyprws-*.yml` copy of an upstream workflow **pins** the upstream file and commit it last matched: `# fork-mirror: <path>@<full sha>`.
Each `.rsi-agent/workflows/` conversion of an upstream `.macroscope/check-run-agents/` file **pins the same way**; one without a pin is fork-only.
Convert by rsi-pr-agent's [conversion guide](https://github.com/RSI-Software/rsi-pr-agent/blob/main/docs/repo-workflows.md#convert-another-bots-definitions).
On a candidate, **`fork:scan --mirror-pins` fails**:

- A copy whose **upstream file changed** since its pin
- A `hyprws-*.yml` copy with **no pin**
- An upstream check agent with **no pinned copy**

Review each commit at the tip: **adapt the copy**, or **record a one-line no-change reason** in the commit that **moves the pin** to the target's commit.

## Local trunk

The land run **force-pushes** `origin/hyprws`, so `git pull --ff-only` cannot follow it.
**Reset local `hyprws`** in the canonical checkout, then rerun whatever refused:

```bash
git fetch origin hyprws
git reset --hard origin/hyprws
```

Worktree setup **refuses a branch** cut from the stale history.

## The report

The typed report is the **only run authority**; the printed Markdown is output and **never read back**.
`ForkSyncReport` in `scripts/fork-sync.ts` **owns its fields**.
Issue comments are **projections**: never parse one, and **never treat an edit** to one as a decision.

| Outcome           | Exit | Run     | Means                                 |
| ----------------- | ---- | ------- | ------------------------------------- |
| `already-applied` | 0    | both    | the trunk contains the tag            |
| `rebased`         | 0    | session | finished marker; tip passes `fork:ci` |
| `applied`         | 0    | land    | trunk moved to a green candidate      |
| `blocked`         | 1    | both    | manual seam; partial marker written   |
| `failed`          | 1    | both    | any other red step; see `error`       |

The report **persists before any comment** posts.
**Never edit** a report; a rerun supersedes it.

## Automatic resolution

Conflict resolution is **machine-owned**, in this order:

1. **Rerere** replays this checkout's earlier resolutions
2. **Hook re-apply** moves marked hooks onto upstream
3. A **net-zero fork edit** takes upstream's delete
4. [Regenerable files](#regenerable-files) **regenerate**
5. Anything left is **`manual`** and stops the run

- **Rerere data** never leaves its checkout
- A **hook goes back verbatim**, shifted for re-indent
- **Net-zero** means trunk blob equals base blob
- A **regenerable file waits** for the other paths

There is **no "upstream superseded this" rule**: retirement is a traced verdict in [fork-delta](../internals/fork-delta.md), never a merge rule.
**Rerere records nothing** for a delete/modify conflict: the fix is a driver rule or a pre-adopt commit on `hyprws`.

### Reshape

Resolve **minimally** in the rebase: upstream's text plus **marked hooks verbatim**.
Adaptation **never lands inside a replayed commit**; the hook guard (`scripts/lib/fork-hook-guard.ts`, run by `fork:ci`) refuses it.
Commit it at the **tip of the kept sync worktree**, then rerun so the marker covers it.

- Adapt an owner in **`fixup! <owner subject>`**
- The fixup **copies the owner's trailers**
- The **owner** is the newest fork commit on the lines
- With **no single owner**, one `upstream-fixes` commit
- A **retirement** is its own commit, never a fixup

The next sync **folds each fixup** into its owner; `fork:ci` proves it folds there and **names the right owner** when the fixup names the wrong one.
Autosquash **discards a fixup's body**, so a reason worth keeping goes in its own commit.

### Kept sync worktree

It lives in the **main checkout's `.t3/fork-sync/`**, as `worktree/` and `worktree.json`, whichever checkout runs the sync.

- `fork:sync` **waits for the caller's setup**
- **`t3.json` setup** installs its dependencies
- The gate **reinstalls the frozen lockfile**
- It **keeps every stop's rows** between runs

## Resolution marker

A session hands its tip to the land run as **one marker commit**, `refs/fork-sync/resolution`, pushed to the **`sync/resolution` branch**.

- Its **parent** is the rebased tip
- Its **tree is the lease's**: a push runs trunk files
- Finished subject: **`fork-sync finished <tag>`**
- Partial: **`fork-sync partial <tag>: N commits left`**
- A **partial body** holds the remaining todo
- **`Fork-Sync-Tag`, `Fork-Sync-Lease`** trailers
- A **`Fork-Sync-Decision`** per item before them
- **Every rebased or blocked run** writes one
- An **unchanged rerun reuses** the commit

A marker is **ignored**, with a printed note and a fresh rebase, when:

- its **tag** is not the target
- its **lease** is not in `origin/hyprws`
- its **tree** is not its lease's
- its **tip** lacks the target
- its **todo** names commits outside the stack

**Anything else** on the branch is ignored with a note.

A push to `sync/resolution` runs `hyprws-sync-resolution.yml`, which **dispatches `hyprws-upstream-sync.yml`** on `hyprws`.
An rsi-pr-agent **sticky that settles without a push** fires the same workflow; a pod killed mid-job leaves it `running`, and the **sync schedule** covers that.

### The land run

1. **Fetch**, read the marker, pick the target
2. Trunk has the tag: **close stale sync issues**
3. A **partial marker** marks the issue blocked; exit 1
4. A **finished marker** opens a worktree at its tip
5. With **no marker**, a fresh rebase; a stop blocks
6. **Carry** new trunk commits; link guard
7. [Candidate CI](#candidate-ci), then the **lease push**
8. **Close** the attention issues
9. **File** the [decision issue](#decision-issue)

A partial marker's issue **names the commits left**; the next `vp run fork:sync <tag>` resumes.

### Decision issue

A job decides every seam alone, so each **user-visible call** must outlive the attention issue the land closes.
The marker's `Fork-Sync-Decision` trailers come from the skill's [decisions](../../../.agents/skills/fork-sync/SKILL.md#decisions) file.
The land run files them as **one `hyprws sync landed <tag>` issue**, a task per item.

- **No items**, no issue
- **A human closes it**, never a sync run
- **An answer** is a normal follow-up fix
- **A refused post** fails into the report's `error`

## Attention issue

Every **red land run** rewrites **one standing attention issue** through plain `gh`, after writing its report.
Its title names the **step and target**, so reruns never rename it; its body carries the conflict or failure details and recent runs.
The run **adopts the newest open `ci` issue** titled `hyprws sync blocked` or `hyprws sync failed`.

- **Older matches close**, pointing at the kept one
- A **new one files** only when none match
- A **clean run closes** every match
- A **refused write** or close **fails the run**
- **Sessions never** publish or close issues
- **Never post** a sync issue to `pingdotgg/t3code`

A blocked run, or one failed at **`carry`, `hooks`, or `ci`**, adds **`rsi:fork-sync`**, which starts rsi-pr-agent's `fork-sync` job; it labels on create or on a **new key line** (`sync-failure` or `blocking-sha`).
A rerun on the **same key relabels once**, after the job budget (`AGENT_RETRY_AFTER_MS` in `scripts/fork-sync.ts`); a **second miss waits for a human**.
While the issue carries **`rsi:agent-halted`**, the driver adds no label and the body says a human must act.

The land run also keeps **one driver comment**, `<!-- hyprws:sync-driver -->`, edited in place at each step.
It **never starts a job**: `hyprws-sync-resolution.yml` reacts only to rsi-pr-agent's comments.

## Regenerable files

On a conflict, the driver **resolves each path** and stages it, in table order.
A **generator reruns** over the resolved sources, from the path's `HEAD` copy.
The **package-name merge keeps both sides**: upstream's order, then the fork's additions.
A **failed resolver** leaves a `manual` row naming the failure.

| Path                               | Resolver                            | Runs from                    |
| ---------------------------------- | ----------------------------------- | ---------------------------- |
| `pnpm-lock.yaml`                   | `vp install --lockfile-only`        | The sync worktree            |
| `third-party-licenses.config.json` | merge by package name               | The driver, then `vp fmt`    |
| `apps/web/src/routeTree.gen.ts`    | `vp run fork:regenerate-route-tree` | The trunk checkout's install |

`REGENERATION_ROUTES` in `scripts/fork-sync.ts` **owns the rows**; a test fails when this table drifts, or when the fork carries a **generated path neither routes**.
On a branch that changes a package manifest, **regenerate the lockfile before pushing**.

## Reading a bot run

```bash
gh run list --workflow hyprws-upstream-sync.yml --limit 1 -R RSI-Software/t3code-hyprws
gh run view <run-id> [--log-failed] -R RSI-Software/t3code-hyprws
```

The **Sync job summary** carries the rendered report; **conflict tables** live in the attention issue.

## One-time repository setup

### Bot token

Create a **fine-grained token** owned by the automation actor, scoped to this repository, with read-and-write **Contents** and **Workflows**.
Store it as the **`HYPRWS_MIRROR_TOKEN` secret** of the `hyprws-sync` environment, which **only `hyprws` can deploy** to.
**Only its `sync/candidate` push starts `hyprws CI`**; a `GITHUB_TOKEN` push starts no workflow.
A `sync/resolution` push **runs only trunk files**, so a resolver never reaches the token.
**Never widen** the job's own `GITHUB_TOKEN`.

### Required checks

The `hyprws` ruleset requires **two `hyprws-ci.yml` contexts**: `CI` and `merge-tree`.
`CI` **fails unless every other job passed**, or skipped because `Changes` found it unaffected.
`hyprws-body.yml` stays **advisory**: no ruleset requires its `Body` context.
Each workflow's `on:` block and comments **own its triggers**.

### Upstream workflows and merge settings

**Keep only the `hyprws-*.yml` workflows enabled**; disable every other with `gh workflow disable`, since they expect upstream secrets and runners.
A sync can add an upstream workflow, which **arrives enabled**: disable it, or adapt it as a `hyprws-*.yml` copy.

```bash
gh repo edit RSI-Software/t3code-hyprws \
  --enable-squash-merge --enable-rebase-merge=false --enable-merge-commit=false \
  --delete-branch-on-merge
gh api -X PATCH repos/RSI-Software/t3code-hyprws \
  -f squash_merge_commit_title=COMMIT_OR_PR_TITLE \
  -f squash_merge_commit_message=COMMIT_MESSAGES
```

### Applied rulesets

Applied **by hand** in **Settings > Rules > Rulesets**, all `active`; **nothing changes them unattended**.

- `hyprws`: **pull request**, 0 approvals, both checks
- `main`: **pull request**; only the **mirror job** writes
- Both trunks: **admin bypass**, no force-push rule
- `no trunk deletion`: both trunks, **no bypass**
- `stable tags`: **`v*-hyprws.*`** minus nightlies
- `stable tags`: **blocks delete and update**

### Release workflow

`hyprws-release.yml` **publishes a nightly** on every trunk landing that passes the release gate, with a **scheduled fallback**.
It **prunes old nightlies** with their tags; **stable is never pruned**.

`hyprws-stable.yml` **cuts stable automatically** after every sync run:

1. **Newest upstream stable** without a fork stable
2. **Fork nightly on exactly its commit**, newest first
3. **Dispatch** the release from the trunk
4. **File** a `hyprws refold` issue, unless one is open

`hyprws-release.yml` takes the tag and sha as inputs; **publishing creates the tag**, so a failed release retries on the next run.

No nightly on that commit means **no cut**; recut instead.
**Recut** with `gh workflow run hyprws-stable.yml`: the trunk tip becomes the next `.N` of the newest upstream stable it contains.
The release gate takes an **older stable sha only with a fork nightly tag** on it.
A missing runner tool is a **workflow task**, never a reason to patch the build script.

### Optional T3 Connect config

T3 Connect **stays dark** unless every `T3CODE_RELAY_URL` and `T3CODE_CLERK_*` **repository variable** `hyprws-release.yml` reads exists.

## Failure handling

- **Recreate the token** when the mirror fails
- A **refused mirror** means someone wrote `main`
- A **refused lease**: rerun; it carries new commits
- **Never `--force`** the trunk or `main`
- An **open issue**: resolve its stop
- A **red candidate**: fix at the tip in a session
- A **flake**: `gh run rerun --failed`, then rerun
- A **failed stable release**: fix and rerun
- **Never move** a published tag

## Version ordering caveat

**Semver precedence is global** even though the updater separates channels: `0.0.36-hyprws-nightly.20260828.1208` sorts above `0.0.35-hyprws.2` and promotes nothing.
**Never infer channel or recency** from a mixed sort; filter by the `-hyprws-nightly.` or `-hyprws.<n>` shape first.
