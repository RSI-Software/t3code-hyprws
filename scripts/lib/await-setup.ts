// @effect-diagnostics nodeBuiltinImport:off - preloaded before the entry's imports resolve, so only Node built-ins exist.

// A preload (`node --import`) that waits for the background worktree setup of
// the checkout it runs in (`vp run` starts at the repo root). T3 marks a thread's
// workspace ready while `scripts/setup-worktree.ts` still installs; an entry
// started then fails on unresolved imports instead of naming the cause. A
// preload runs before the entry's imports resolve.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

const markers = NodePath.join(process.cwd(), ".t3");
const running = NodePath.join(markers, "setup-running");
const failed = NodePath.join(markers, "setup-failed");

const runningPid = (): number | undefined => {
  let pid: number;
  try {
    pid = Number(NodeFS.readFileSync(running, "utf8").trim());
  } catch {
    return undefined;
  }
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    // A setup killed without its exit handler leaves a stale marker.
    return undefined;
  }
};

let announced = false;
for (let pid = runningPid(); pid !== undefined; pid = runningPid()) {
  if (!announced) process.stderr.write(`waiting for worktree setup (pid ${pid}) to finish\n`);
  announced = true;
  await NodeTimersPromises.setTimeout(1_000);
}
if (NodeFS.existsSync(failed)) {
  process.stderr.write(
    `worktree setup failed; fix it and rerun setup first:\n${NodeFS.readFileSync(failed, "utf8")}`,
  );
  process.exit(1);
}
