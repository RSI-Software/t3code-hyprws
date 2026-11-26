import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ProjectToolkit } from "./tools.ts";

it("t3_project_update takes an agent's team mark and unmark", () => {
  const decode = Schema.decodeUnknownSync(ProjectToolkit.tools.t3_project_update.parametersSchema);
  for (const teamFork of [true, false]) {
    expect(decode({ projectId: "project-1", teamFork })).toEqual({
      projectId: "project-1",
      teamFork,
    });
  }
});
