import { it as effectIt } from "@effect/vitest";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  EnvironmentId,
  INCOGNITO_BROWSER_PROFILE_ID,
  PreviewAutomationStatus,
  ProjectId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as BrowserImport from "../../preview/BrowserImport/BrowserImport.ts";
import type { WindowId } from "../../window/WindowId.fork.ts"; // fork-hook: multi-window/window-id-import
import { projectWindowIdentity } from "../../window/WindowIdentity.ts";
import * as PreviewIpc from "./preview.ts";

const { fromPartition, fromWebContents, fromId } = vi.hoisted(() => ({
  fromPartition: vi.fn(() => {
    throw new Error("Session can only be received when app is ready");
  }),
  fromWebContents: vi.fn(() => null as Electron.BrowserWindow | null),
  fromId: vi.fn(() => null as Electron.WebContents | null),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
    fromWebContents,
  },
  session: {
    fromPartition,
  },
  webContents: {
    fromId,
  },
}));

describe("preview IPC methods", () => {
  beforeEach(() => {
    fromPartition.mockClear();
    fromWebContents.mockReset();
    fromWebContents.mockReturnValue(null);
    fromId.mockReset();
    fromId.mockReturnValue(null);
  });

  it("does not access the Electron session while the module loads", async () => {
    await expect(import("./preview.ts")).resolves.toBeDefined();
    expect(fromPartition).not.toHaveBeenCalled();
  });

  it("derives distinct partition scopes when identifiers contain the delimiter", () => {
    const first = PreviewIpc.resolvePartitionScope("a", "b::c");
    const second = PreviewIpc.resolvePartitionScope("a::b", "c");

    expect(first).toEqual({ scope: '["a","b::c"]', persistent: true, namespace: "profile" });
    expect(second).toEqual({ scope: '["a::b","c"]', persistent: true, namespace: "profile" });
    expect(first.scope).not.toBe(second.scope);
  });

  it("preserves lone surrogates without collapsing them to replacement characters", () => {
    const highSurrogate = PreviewIpc.resolvePartitionScope("environment", "profile-\ud800");
    const lowSurrogate = PreviewIpc.resolvePartitionScope("environment", "profile-\udc00");
    const replacement = PreviewIpc.resolvePartitionScope("environment", "profile-�");

    expect(highSurrogate.scope).toBe('["environment","profile-\\ud800"]');
    expect(lowSurrogate.scope).toBe('["environment","profile-\\udc00"]');
    expect(highSurrogate.scope).not.toBe(lowSurrogate.scope);
    expect(highSurrogate.scope).not.toBe(replacement.scope);
    expect(lowSurrogate.scope).not.toBe(replacement.scope);
  });

  it("keeps the legacy default partition scope and incognito persistence", () => {
    expect(PreviewIpc.resolvePartitionScope("environment::legacy", undefined)).toEqual({
      scope: "environment::legacy",
      persistent: true,
    });
    expect(
      PreviewIpc.resolvePartitionScope("environment::legacy", DEFAULT_BROWSER_PROFILE_ID),
    ).toEqual({ scope: "environment::legacy", persistent: true });
    expect(
      PreviewIpc.resolvePartitionScope("environment::legacy", INCOGNITO_BROWSER_PROFILE_ID),
    ).toEqual({
      scope: '["environment::legacy","incognito"]',
      persistent: false,
      namespace: "profile",
    });
  });

  effectIt.effect("targets imports at the same partition tuple as the renderer", () => {
    const received: Array<Parameters<BrowserImport.BrowserImport["Service"]["importCookies"]>[0]> =
      [];
    const browserImport = BrowserImport.BrowserImport.of({
      listSources: Effect.succeed([]),
      importCookies: (input) =>
        Effect.sync(() => {
          received.push(input);
          return { imported: 0, skipped: 0, skippedDomains: [] };
        }),
    });
    const request = (environmentId: string, targetProfileId: string) =>
      PreviewIpc.importBrowserCookies.handler({
        environmentId,
        sourceId: "helium",
        sourceProfileDirectory: "Default",
        targetProfileId,
      });

    return Effect.gen(function* () {
      yield* request("a", "b");
      yield* request("a::b", DEFAULT_BROWSER_PROFILE_ID);

      expect(received[0]).toMatchObject(PreviewIpc.resolvePartitionScope("a", "b"));
      expect(received[1]).toMatchObject(
        PreviewIpc.resolvePartitionScope("a::b", DEFAULT_BROWSER_PROFILE_ID),
      );
      expect(received[0]?.namespace).toBe("profile");
      expect(received[1]?.namespace).toBeUndefined();
    }).pipe(Effect.provideService(BrowserImport.BrowserImport, browserImport));
  });

  effectIt.effect("rejects invalid webContents ids before resolving the preview service", () =>
    Effect.map(
      PreviewIpc.registerWebview
        .handler({ tabId: "tab-1", webContentsId: 0 })
        .pipe(
          Effect.provideService(ElectronWindow.ElectronWindow, null as never),
          Effect.provideService(PreviewManager.PreviewManager, null as never),
          Effect.exit,
        ),
      (exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && Schema.isSchemaError(error.value)).toBe(true);
        expect(fromPartition).not.toHaveBeenCalled();
      },
    ),
  );

  effectIt.effect("returns automation status for long runtime tab ids", () => {
    const identity = projectWindowIdentity(
      EnvironmentId.make("environment-1"),
      ProjectId.make("project-1"),
    );
    const windowId = "00000000-0000-4000-8000-000000000001" as WindowId; // fork-hook: multi-window/window-id-sender
    const sender = { id: 7 } as Electron.WebContents;
    const senderWindow = {} as Electron.BrowserWindow;
    fromId.mockReturnValue(sender);
    fromWebContents.mockReturnValue(senderWindow);

    return Effect.gen(function* () {
      const tabId =
        `["environment-1","thread:delegated-task:${"a".repeat(120)}",` +
        `"server-epoch-1","preview-1"]`;
      const status = {
        available: false,
        visible: true,
        tabId,
        url: null,
        title: null,
        loading: false,
      };

      const owners: unknown[] = []; // fork-hook: multi-window/window-id-preview-owners
      const recordOwner = (owner: unknown) => Effect.sync(() => owners.push(owner)); // fork-hook: multi-window/window-id-preview-record-owner
      const automation = Effect.succeed({
        automationStatus: () => Effect.succeed(status),
      } as never); // fork-hook: multi-window/window-id-preview-automation

      expect(tabId.length).toBeGreaterThan(128);
      expect(
        yield* PreviewIpc.automationStatus.handler({ tabId }, { sender }).pipe(
          Effect.provideService(ElectronWindow.ElectronWindow, {
            windowIdFor: () => Effect.succeed(Option.some(windowId)), // fork-hook: multi-window/window-id-sender-lookup
          } as never),
          Effect.provideService(PreviewManager.PreviewManager, {
            forWindow: (owner: unknown) => Effect.andThen(recordOwner(owner), automation), // fork-hook: multi-window/window-id-preview-owner
          } as never),
        ),
      ).toEqual(status);
      expect(owners).toEqual([windowId]); // fork-hook: multi-window/window-id-preview-owner-assert
      expect(owners).not.toContainEqual(identity); // fork-hook: multi-window/window-id-preview-not-project
    });
  });

  it("keeps the public automation status tab id limit", () => {
    const encode = Schema.encodeUnknownSync(PreviewAutomationStatus);
    const tabId = "t".repeat(129);

    expect(() =>
      encode({
        available: false,
        visible: true,
        tabId,
        url: null,
        title: null,
        loading: false,
      }),
    ).toThrow();
  });
});
