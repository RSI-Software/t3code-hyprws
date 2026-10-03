import { assert, describe, it } from "@effect/vitest";

import {
  formatClearWorkspaceWindowRule,
  formatMoveToWorkspaceRequest,
  formatSuppressActivationWindowRule,
  formatWindowRuleTitleMatcher,
  formatWorkspaceArgument,
  formatWorkspaceWindowRule,
  hyprlandSocketCandidates,
  parseHyprlandClients,
  selectClientForWindow,
  resolveHyprlandWindowRuleGrammar,
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

  it("uses the compositor grammar for silent address-scoped workspace moves", () => {
    assert.equal(
      formatMoveToWorkspaceRequest({ id: 8, name: "8" }, "0xabc"),
      "/dispatch movetoworkspacesilent 8,address:0xabc",
    );
    assert.equal(
      formatMoveToWorkspaceRequest({ id: 8, name: "8" }, "0xabc", "lua"),
      '/dispatch hl.dsp.window.move({workspace="8",follow=false,window="address:0xabc"})',
    );
    assert.equal(
      formatMoveToWorkspaceRequest({ id: 7, name: "code" }, "0xabc", "lua"),
      '/dispatch hl.dsp.window.move({workspace="name:code",follow=false,window="address:0xabc"})',
    );
  });

  it("formats exact map-time workspace rules and rejects unsafe titles", () => {
    assert.equal(
      formatWindowRuleTitleMatcher("t3code-dev-agent.a+b"),
      "match:title ^(t3code-dev-agent\\.a\\+b)$",
    );
    assert.equal(
      formatWorkspaceWindowRule({ id: 8, name: "8" }, "t3code-dev-agent-a"),
      "/keyword windowrule workspace 8 silent, match:title ^(t3code-dev-agent-a)$",
    );
    assert.equal(
      formatSuppressActivationWindowRule("t3code-dev-agent-a"),
      "/keyword windowrule suppress_event activate activate_focus, match:title ^(t3code-dev-agent-a)$",
    );
    assert.equal(
      formatClearWorkspaceWindowRule("t3code-dev-agent-a"),
      "/keyword windowrule workspace unset, match:title ^(t3code-dev-agent-a)$",
    );
    assert.equal(formatWindowRuleTitleMatcher("unsafe,title"), null);
  });

  it("selects Lua rules only for compositors with the typed rule API", () => {
    const resolve = (version: string, configProvider: string) =>
      resolveHyprlandWindowRuleGrammar({
        versionPayload: JSON.stringify({ version }),
        statusPayload: JSON.stringify({ configProvider }),
      });
    assert.equal(resolve("0.54.1", "hyprlang"), "legacy");
    assert.equal(resolve("0.55.0", "lua"), "lua");
    assert.equal(resolve("0.56.2", "hyprlang"), "legacy");
    assert.equal(resolve("1.0.0", "lua"), "lua");
    assert.equal(resolve("unknown", "lua"), "legacy");
    assert.equal(
      resolveHyprlandWindowRuleGrammar({
        versionPayload: "not json",
        statusPayload: '{"configProvider":"lua"}',
      }),
      "legacy",
    );
  });

  it("gives repeated Lua rules unique names and disables only the current workspace rule", () => {
    assert.equal(
      formatWorkspaceWindowRule({ id: 8, name: "8" }, "t3code-dev-agent-a", "lua"),
      '/eval local key="t3code.desktop-agent.workspace.t3code-dev-agent-a";local old=rawget(_G,key);if old then old:set_enabled(false) end;local seqkey=key..".sequence";local seq=(rawget(_G,seqkey) or 0)+1;rawset(_G,seqkey,seq);_G[key]=hl.window_rule({name="t3code-desktop-agent-workspace-t3code-dev-agent-a-"..seq,match={title="^(t3code-dev-agent-a)$"},workspace="8 silent"})',
    );
    assert.equal(
      formatSuppressActivationWindowRule("t3code-dev-agent-a", "lua"),
      '/eval local key="t3code.desktop-agent.suppression.t3code-dev-agent-a";local old=rawget(_G,key);if old then old:set_enabled(false) end;local seqkey=key..".sequence";local seq=(rawget(_G,seqkey) or 0)+1;rawset(_G,seqkey,seq);_G[key]=hl.window_rule({name="t3code-desktop-agent-suppression-t3code-dev-agent-a-"..seq,match={title="^(t3code-dev-agent-a)$"},suppress_event="activate activate_focus"})',
    );
    assert.equal(
      formatClearWorkspaceWindowRule("t3code-dev-agent-a", "lua"),
      '/eval local key="t3code.desktop-agent.workspace.t3code-dev-agent-a";local rule=rawget(_G,key);if rule then rule:set_enabled(false);rawset(_G,key,nil) end',
    );
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
