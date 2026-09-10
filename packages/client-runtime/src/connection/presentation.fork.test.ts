import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { type ConnectionCatalogEntry, SshConnectionProfile } from "./catalog.ts";
import { SshConnectionTarget } from "./model.ts";
import { connectionCatalogDisplayUrl } from "./presentation.ts";

describe("connection presentation for an SSH target", () => {
  it("formats SSH display information without a missing username and preserves the port", () => {
    const target = new SshConnectionTarget({
      environmentId: EnvironmentId.make("environment-ssh"),
      label: "SSH environment",
      connectionId: "connection-ssh",
    });
    const entry: ConnectionCatalogEntry = {
      target,
      profile: Option.some(
        new SshConnectionProfile({
          connectionId: target.connectionId,
          environmentId: target.environmentId,
          label: target.label,
          target: {
            alias: "devbox",
            hostname: "devbox.example.test",
            username: null,
            port: 2222,
          },
        }),
      ),
    };

    expect(connectionCatalogDisplayUrl(entry)).toBe("devbox.example.test:2222");
  });
});
