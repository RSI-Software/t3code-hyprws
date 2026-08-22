import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  resolveProjectWindowIntent,
  resolveWindowIdentityFromArguments,
} from "./DesktopLaunchIntent.ts";

const expectedProjectIdentity = {
  kind: "project",
  ref: {
    environmentId: EnvironmentId.make("environment-1"),
    projectId: ProjectId.make("project-1"),
  },
} as const;

describe("DesktopLaunchIntent", () => {
  it("parses project flags and desktop deep links", () => {
    assert.deepEqual(
      resolveWindowIdentityFromArguments(["t3code", "--project", "environment-1", "project-1"]),
      expectedProjectIdentity,
    );
    assert.deepEqual(
      resolveWindowIdentityFromArguments(["t3code", "--project=environment-1/project-1"]),
      expectedProjectIdentity,
    );
    assert.deepEqual(
      resolveWindowIdentityFromArguments([
        "t3code",
        "t3code://app/project/environment-1/project-1/thread/thread-1",
      ]),
      expectedProjectIdentity,
    );
  });

  it("decodes route identities without treating project ids as globally unique", () => {
    assert.deepEqual(resolveProjectWindowIntent("/project/remote%3Awsl/my%20project"), {
      kind: "project",
      ref: {
        environmentId: EnvironmentId.make("remote:wsl"),
        projectId: ProjectId.make("my project"),
      },
    });
  });

  it("ignores unrelated, malformed, and foreign deep links", () => {
    assert.isNull(resolveWindowIdentityFromArguments(["t3code"]));
    assert.isNull(resolveWindowIdentityFromArguments(["t3code", "relative/app-entry.js"]));
    assert.isNull(resolveWindowIdentityFromArguments(["t3code", "--project", "environment-1"]));
    assert.isNull(resolveProjectWindowIntent("https://app/project/environment-1/project-1"));
    assert.isNull(resolveProjectWindowIntent("t3code://other/project/environment-1/project-1"));
    assert.isNull(resolveProjectWindowIntent("t3code://app/project/%E0%A4%A/project-1"));
  });
});
