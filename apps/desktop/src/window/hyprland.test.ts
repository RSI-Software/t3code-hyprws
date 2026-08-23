import { assert, describe, it } from "@effect/vitest";

import {
  formatWorkspaceArgument,
  hyprlandSocketCandidates,
  parseHyprlandClients,
  selectClientForWindow,
  type HyprlandClient,
} from "./hyprland.ts";

const client = (input: Partial<HyprlandClient> & { readonly address: string }): HyprlandClient => ({
  pid: 42,
  title: "T3 Code",
  workspace: { id: 3, name: "3" },
  ...input,
});

describe("hyprland", () => {
  it("prefers the runtime-dir socket and keeps the legacy /tmp path", () => {
    assert.deepEqual(
      hyprlandSocketCandidates({ instanceSignature: "sig", runtimeDirectory: "/run/user/1000" }),
      ["/run/user/1000/hypr/sig/.socket.sock", "/tmp/hypr/sig/.socket.sock"],
    );
    assert.deepEqual(
      hyprlandSocketCandidates({ instanceSignature: "sig", runtimeDirectory: undefined }),
      ["/tmp/hypr/sig/.socket.sock"],
    );
    assert.deepEqual(
      hyprlandSocketCandidates({
        instanceSignature: undefined,
        runtimeDirectory: "/run/user/1000",
      }),
      [],
    );
  });

  it("keeps well-formed clients and drops the rest", () => {
    const parsed = parseHyprlandClients(
      JSON.stringify([
        { address: "0x1", pid: 7, title: "one", workspace: { id: 2, name: "2" }, extra: true },
        { address: "0x2", pid: 7, workspace: { id: 4, name: "code" } },
        { address: "0x3", pid: 7 },
        { pid: 7, workspace: { id: 1, name: "1" } },
        "nonsense",
      ]),
    );
    assert.deepEqual(parsed, [
      { address: "0x1", pid: 7, title: "one", workspace: { id: 2, name: "2" } },
      { address: "0x2", pid: 7, title: "", workspace: { id: 4, name: "code" } },
    ]);
    assert.deepEqual(parseHyprlandClients("not json"), []);
    assert.deepEqual(parseHyprlandClients("{}"), []);
  });

  it("addresses numbered, named, and special workspaces the way hyprctl does", () => {
    assert.equal(formatWorkspaceArgument({ id: 3, name: "3" }), "3");
    assert.equal(formatWorkspaceArgument({ id: 7, name: "code" }), "name:code");
    assert.equal(formatWorkspaceArgument({ id: -98, name: "special:magic" }), "special:magic");
  });

  it("matches a window by title before falling back to a lone candidate", () => {
    const clients = [
      client({ address: "0x1", title: "hub" }),
      client({ address: "0x2", title: "project" }),
      client({ address: "0x9", pid: 99, title: "project" }),
    ];

    assert.equal(
      selectClientForWindow({ clients, pid: 42, title: "project", claimedAddresses: new Set() })
        ?.address,
      "0x2",
    );
    assert.equal(
      selectClientForWindow({
        clients,
        pid: 42,
        title: "no such title",
        claimedAddresses: new Set(["0x1"]),
      })?.address,
      "0x2",
    );
  });

  it("refuses to guess when several unclaimed windows could match", () => {
    const clients = [
      client({ address: "0x1", title: "same" }),
      client({ address: "0x2", title: "same" }),
    ];
    assert.equal(
      selectClientForWindow({ clients, pid: 42, title: "same", claimedAddresses: new Set() }),
      null,
    );
    assert.equal(
      selectClientForWindow({
        clients,
        pid: 42,
        title: "same",
        claimedAddresses: new Set(["0x1", "0x2"]),
      }),
      null,
    );
  });
});
