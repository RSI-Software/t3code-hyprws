# Cut stable

Tag a stable fork release from a bot-owned snapshot.
[SKILL.md](../SKILL.md) owns the never-rules and the stop shape; this file owns the judgement.

The [runbook](../../../../docs/fork/operations/fork-sync.md#cut-a-stable-release) owns every mechanic: what each transition validates, derives, and refuses.

Only the stable channel needs an entry point.
The release workflow fires on every push to `hyprws`, so a leased apply cuts the nightly by itself; never cut one by hand.

Start from the candidate notification issue, which carries everything a fresh session needs.
Exactly one candidate is open, because each reconcile closes cut and overtaken ones.

- **Never** replace a tag
- **Never** infer a candidate

## 1. List

```bash
vp run fork:sync stable-list
```

**Stop.** Show every reported issue, candidate, and snapshot branch.
Continue only after the human selects one exact issue number.
Recency is not permission to infer it.

## 2. Prepare

```bash
vp run fork:sync stable-prepare --report <report> --issue <human-selected-issue>
```

### Verdict source

- **Verdict from:** `hyprws CI` on the snapshot
- **Never from:** a local full-suite run
- **Failed job:** stops prepare with the run URL
- **45-minute timeout:** the same stop

A failed preparation removes its cut lane before requiring a fresh `stable-list`.
If that cleanup fails, run only the exact forced recovery command the refusal prints, then restart selection.

### Stop

Apply the [stop reply](stop-reply.md): the report carries every preparation result and the clean and ref checks.
The reply names the issue, snapshot SHA, derived tag, and any withhold reason.

- **Continue when:** the human names the candidate
- **And gives** an explicit release go
- **Withhold that go:** the app cannot launch
- **Withhold that go:** basic use fails

The agent must not infer the human's release judgement.

## 3. Publish

```bash
vp run fork:sync stable-publish --report <report> --go <exact-candidate>
```

Publish revalidates everything it bound before it creates the tag.

**Stop on every refusal.**
Each requires a fresh `stable-list` report and fresh human sign-off.
Never increment, replace, or repair the release by hand.

## No candidate

An apply that warns `stable snapshot release/<tag>-hyprws not created` left no candidate for that tag, and no later run will.
Report it to the human and cut nothing for it until they snapshot that branch by hand.
