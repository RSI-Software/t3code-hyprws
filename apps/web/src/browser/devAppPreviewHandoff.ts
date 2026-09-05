import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  terminalOutputText,
  type TerminalBufferState,
  type TerminalOutputCursor,
} from "@t3tools/client-runtime/state/terminal";
import type { EnvironmentId, TerminalAttachInput } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { terminalEnvironment } from "~/state/terminal";
import { formatEnvironmentQueryError } from "~/state/query";

const PREVIEW_LINE_PREFIX = "[dev-app] previewUrl=";
const MAX_PREVIEW_LINE_LENGTH = 4_096;
const OUTPUT_OVERLAP_LENGTH = 8_192;
const DEFAULT_HANDOFF_TIMEOUT_MS = 120_000;

export function isDevAppPreviewActionCommand(command: string): boolean {
  const tokens = devAppPreviewActionTokens(command);
  return tokens !== null;
}

function devAppPreviewActionTokens(command: string): ReadonlyArray<string> | null {
  if (/[\r\n;&|`$<>\\'\"]/.test(command)) return null;
  const tokens = command.trim().split(/\s+/);
  const modeFlags = tokens.filter(
    (token) => token === "--preview" || token === "--external" || token === "--desktop",
  );
  return tokens[0] === "vp" &&
    tokens[1] === "run" &&
    tokens[2] === "dev:app" &&
    modeFlags.length === 1 &&
    modeFlags[0] === "--preview"
    ? tokens
    : null;
}

export function devAppPreviewActionCommandForRuntime(
  command: string,
  previewSupported: boolean,
): string {
  if (previewSupported) return command;
  const tokens = devAppPreviewActionTokens(command);
  return tokens === null
    ? command
    : tokens.map((token) => (token === "--preview" ? "--external" : token)).join(" ");
}

export function parseDevAppPreviewLine(line: string): string | null {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!normalized.startsWith(PREVIEW_LINE_PREFIX)) return null;
  const candidate = normalized.slice(PREVIEW_LINE_PREFIX.length);
  if (
    candidate.length === 0 ||
    candidate.length > MAX_PREVIEW_LINE_LENGTH ||
    candidate.trim() !== candidate
  ) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const hashParams = new URLSearchParams(hash);
  const hashKeys = [...hashParams.keys()];
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") ||
    url.port.length === 0 ||
    Number(url.port) < 1 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/pair" ||
    url.search.length > 0 ||
    hashKeys.length !== 1 ||
    hashKeys[0] !== "token" ||
    (hashParams.get("token")?.length ?? 0) === 0
  ) {
    return null;
  }
  return url.href;
}

export class DevAppPreviewLineDecoder {
  private line = "";
  private discardUntilNewline = false;
  private controlState: "text" | "escape" | "csi" | "string" | "string-escape" = "text";

  discardPartialLine(): void {
    this.line = "";
    this.discardUntilNewline = true;
  }

  push(chunk: string): string | null {
    for (const character of chunk) {
      const codePoint = character.charCodeAt(0);
      if (this.controlState === "escape") {
        if (character === "[") this.controlState = "csi";
        else if (character === "]" || character === "P" || character === "^" || character === "_") {
          this.controlState = "string";
        } else if (codePoint < 0x20 || codePoint > 0x2f) {
          this.controlState = "text";
        }
        continue;
      }
      if (this.controlState === "csi") {
        if (codePoint >= 0x40 && codePoint <= 0x7e) this.controlState = "text";
        continue;
      }
      if (this.controlState === "string-escape") {
        this.controlState = character === "\\" ? "text" : "string";
        continue;
      }
      if (this.controlState === "string") {
        if (character === "\u0007" || codePoint === 0x9c) this.controlState = "text";
        else if (character === "\u001b") this.controlState = "string-escape";
        continue;
      }
      if (character === "\u001b") {
        this.controlState = "escape";
        continue;
      }
      if (codePoint === 0x9b) {
        this.controlState = "csi";
        continue;
      }
      if (codePoint === 0x90 || codePoint === 0x9d || codePoint === 0x9e || codePoint === 0x9f) {
        this.controlState = "string";
        continue;
      }
      if (character === "\n" || character === "\r") {
        const previewUrl = this.discardUntilNewline ? null : parseRenderedPreviewLine(this.line);
        this.line = "";
        this.discardUntilNewline = false;
        if (previewUrl !== null) return previewUrl;
        continue;
      }
      if (this.discardUntilNewline) continue;
      if (character === "\b") {
        this.line = this.line.slice(0, -1);
        continue;
      }
      if (character === "\t") {
        this.line += " ";
      } else if (codePoint >= 0x20 && codePoint !== 0x7f) {
        this.line += character;
      }
      if (this.line.length > MAX_PREVIEW_LINE_LENGTH) {
        this.line = this.line.slice(-MAX_PREVIEW_LINE_LENGTH);
      }
    }
    return null;
  }
}

function parseRenderedPreviewLine(line: string): string | null {
  const markerIndex = line.lastIndexOf(PREVIEW_LINE_PREFIX);
  if (markerIndex < 0) return null;
  const candidate = line.slice(markerIndex + PREVIEW_LINE_PREFIX.length).split(/\s/, 1)[0];
  return candidate ? parseDevAppPreviewLine(`${PREVIEW_LINE_PREFIX}${candidate}`) : null;
}

export type DevAppPreviewOutputResult =
  | { readonly type: "waiting" }
  | { readonly type: "ready" }
  | { readonly type: "preview"; readonly url: string }
  | { readonly type: "ended"; readonly message: string };

/** Reads only output added after the first attachment snapshot. */
export class DevAppPreviewOutputWatcher {
  private initialized = false;
  private cursor: TerminalOutputCursor = INITIAL_TERMINAL_OUTPUT_CURSOR;
  private outputTail = "";
  private readonly decoder = new DevAppPreviewLineDecoder();

  observe(state: TerminalBufferState): DevAppPreviewOutputResult {
    if (!this.initialized && state.version === 0) return { type: "waiting" };
    const update = readTerminalOutputUpdate(state.output, this.cursor);
    this.cursor = update.cursor;
    const outputText = update.type === "reset" ? update.data : null;

    if (!this.initialized) {
      this.initialized = true;
      this.outputTail = (outputText ?? terminalOutputText(state.output)).slice(
        -OUTPUT_OVERLAP_LENGTH,
      );
      if (this.outputTail.length > 0 && !this.outputTail.endsWith("\n")) {
        this.decoder.discardPartialLine();
      }
      return terminalEndedResult(state) ?? { type: "ready" };
    }

    let added = "";
    if (update.type === "append") {
      added = update.data;
      this.outputTail = `${this.outputTail}${added}`.slice(-OUTPUT_OVERLAP_LENGTH);
    } else if (update.type === "reset") {
      if (this.outputTail.length === 0) {
        added = update.data;
      } else {
        const overlapIndex = update.data.lastIndexOf(this.outputTail);
        if (overlapIndex >= 0) {
          added = update.data.slice(overlapIndex + this.outputTail.length);
        } else if (update.data.length > 0 && !update.data.endsWith("\n")) {
          this.decoder.discardPartialLine();
        }
      }
      this.outputTail = update.data.slice(-OUTPUT_OVERLAP_LENGTH);
    }

    const previewUrl = this.decoder.push(added);
    if (previewUrl !== null) return { type: "preview", url: previewUrl };
    return terminalEndedResult(state) ?? { type: "waiting" };
  }
}

function terminalEndedResult(state: TerminalBufferState): DevAppPreviewOutputResult | null {
  if (state.status !== "exited" && state.status !== "closed" && state.status !== "error") {
    return null;
  }
  return {
    type: "ended",
    message: state.error ?? `The terminal ${state.status} before dev:app produced a preview URL.`,
  };
}

export interface DevAppPreviewHandoff {
  readonly ready: Promise<void>;
  readonly cancel: () => void;
}

export class DevAppPreviewHandoffCancelledError extends Error {
  override readonly name = "DevAppPreviewHandoffCancelledError";

  constructor() {
    super("The dev app preview action was cancelled.");
  }
}

type TerminalAttachResult = AsyncResult.AsyncResult<TerminalBufferState, unknown>;

export interface DevAppPreviewHandoffSource {
  readonly attach: (target: {
    readonly environmentId: EnvironmentId;
    readonly terminal: TerminalAttachInput;
  }) => {
    readonly get: () => TerminalAttachResult;
    readonly subscribe: (listener: (result: TerminalAttachResult) => void) => () => void;
  };
}

export interface DevAppPreviewHandoffManager {
  readonly arm: (input: {
    readonly environmentId: EnvironmentId;
    readonly terminal: TerminalAttachInput;
    readonly onPreviewUrl: (url: string) => void | Promise<void>;
    readonly onError: (message: string) => void;
    readonly timeoutMs?: number;
  }) => DevAppPreviewHandoff;
}

const terminalTargetKey = (environmentId: EnvironmentId, terminal: TerminalAttachInput) =>
  JSON.stringify([environmentId, terminal.threadId, terminal.terminalId ?? null]);

export function createDevAppPreviewHandoffManager(
  source: DevAppPreviewHandoffSource,
): DevAppPreviewHandoffManager {
  const activeHandoffs = new Map<string, DevAppPreviewHandoff>();

  return {
    arm: (input) => {
      const key = terminalTargetKey(input.environmentId, input.terminal);
      activeHandoffs.get(key)?.cancel();

      const watcher = new DevAppPreviewOutputWatcher();
      const attachment = source.attach({
        environmentId: input.environmentId,
        terminal: input.terminal,
      });
      let ready = false;
      let settled = false;
      let unsubscribe = () => {};
      let resolveReady!: () => void;
      let rejectReady!: (error: Error) => void;
      const readyPromise = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        if (activeHandoffs.get(key) === handoff) activeHandoffs.delete(key);
      };
      const handoff: DevAppPreviewHandoff = {
        ready: readyPromise,
        cancel: () => {
          const wasReady = ready;
          finish();
          if (!wasReady) rejectReady(new DevAppPreviewHandoffCancelledError());
        },
      };
      activeHandoffs.set(key, handoff);
      const fail = (message: string) => {
        const wasReady = ready;
        finish();
        if (wasReady) input.onError(message);
        else rejectReady(new Error(message));
      };
      const consume = (result: TerminalAttachResult) => {
        if (settled) return;
        if (result._tag === "Failure") {
          fail(formatEnvironmentQueryError(result.cause));
          return;
        }
        const state = Option.getOrNull(AsyncResult.value(result));
        // Stream.scan exposes its empty seed before the server's first attachment snapshot.
        if (state === null || state.version === 0) return;
        const outputResult = watcher.observe(state);
        if (outputResult.type === "ready") {
          ready = true;
          resolveReady();
        } else if (outputResult.type === "preview") {
          finish();
          void Promise.resolve(input.onPreviewUrl(outputResult.url)).catch((error: unknown) => {
            input.onError(
              error instanceof Error ? error.message : "Failed to open the preview URL.",
            );
          });
        } else if (outputResult.type === "ended") {
          fail(outputResult.message);
        }
      };
      const timeout = setTimeout(() => {
        fail("Timed out waiting for dev:app to produce a preview URL.");
      }, input.timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS);

      unsubscribe = attachment.subscribe(consume);
      if (settled) unsubscribe();
      consume(attachment.get());
      return handoff;
    },
  };
}

const devAppPreviewHandoffManager = createDevAppPreviewHandoffManager({
  attach: ({ environmentId, terminal }) => {
    const atom = terminalEnvironment.attach({ environmentId, input: terminal });
    return {
      get: () => appAtomRegistry.get(atom),
      subscribe: (listener) => appAtomRegistry.subscribe(atom, listener),
    };
  },
});

/**
 * The pairing URL is a one-time credential, like the server's normal pairingUrl log.
 * This handoff reads that existing terminal stream and adds no file or durable client storage.
 */
export function armDevAppPreviewHandoff(input: {
  readonly environmentId: EnvironmentId;
  readonly terminal: TerminalAttachInput;
  readonly onPreviewUrl: (url: string) => void | Promise<void>;
  readonly onError: (message: string) => void;
  readonly timeoutMs?: number;
}): DevAppPreviewHandoff {
  return devAppPreviewHandoffManager.arm(input);
}
