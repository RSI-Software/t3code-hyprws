import { type ColleagueFork, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createColleagueAttacherFork } from "./colleagueAttach.fork";

const jordan = {
  subject: "colleague:jordan",
  name: "Jordan",
  environmentId: EnvironmentId.make("jordan"),
  url: "http://jordan.test",
  savedAt: "2026-11-27T00:00:00.000Z",
  threadIds: [],
} as unknown as ColleagueFork;
const list = [jordan];
const none = new Set<EnvironmentId>();

describe("createColleagueAttacherFork", () => {
  it("tries an unattached colleague again on the next retry, with the same list", async () => {
    const attachColleagues = createColleagueAttacherFork();
    const attempts: string[] = [];
    const run = (retry: number) =>
      attachColleagues({
        colleagues: list,
        known: none,
        retry,
        attach: async (colleague) => attempts.push(colleague.name),
      });

    await run(0);
    await run(0);
    expect(attempts).toEqual(["Jordan"]);

    await run(1);
    expect(attempts).toEqual(["Jordan", "Jordan"]);
  });

  it("keeps one attach in flight per colleague", async () => {
    const attachColleagues = createColleagueAttacherFork();
    const attempts: Array<() => void> = [];
    const run = (colleagues: ReadonlyArray<ColleagueFork>, retry: number) =>
      attachColleagues({
        colleagues,
        known: none,
        retry,
        attach: () => new Promise<void>((resolve) => attempts.push(resolve)),
      });

    const first = run(list, 0);
    void run([...list], 1);
    expect(attempts).toHaveLength(1);

    attempts[0]!();
    await first;
    void run(list, 1);
    expect(attempts).toHaveLength(2);
  });
});
