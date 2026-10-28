import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { regroupWorkingShelfFork } from "./Sidebar.groupWorking.fork";

const environmentId = EnvironmentId.make("env");
const thread = (id: string) => ({ environmentId, id: ThreadId.make(id) });
const [parent, child, other] = [thread("p"), thread("c"), thread("o")];
const group = {
  id: "env:g",
  title: "G",
  threadIds: ["env:p", "env:c"],
  parentThreadId: "env:p",
  collapsed: false,
};
const ids = (threads: readonly { readonly id: string }[]) => threads.map((t) => t.id);

describe("regroupWorkingShelfFork", () => {
  it("moves a group with its working parent, and keeps a working child home", () => {
    const active = [child, other];
    const working = [parent];
    regroupWorkingShelfFork(active, working, [group]);
    expect([ids(active), ids(working)]).toEqual([["o"], ["c", "p"]]);

    const home = [parent, other];
    const shelf = [child];
    regroupWorkingShelfFork(home, shelf, [group]);
    expect([ids(home), ids(shelf)]).toEqual([["p", "o", "c"], []]);
  });
});
