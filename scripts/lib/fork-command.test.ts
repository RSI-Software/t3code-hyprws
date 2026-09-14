// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  isTransientCommandFailure,
  requireCommandSuccess,
  runCommand,
  runCommandTextWithRetry,
  type CommandResult,
} from "./fork-command.ts";

const failure = (partial: Partial<CommandResult>): CommandResult => ({
  status: 1,
  stdout: "",
  stderr: "",
  ...partial,
});

/**
 * runCommandTextWithRetry wraps the real spawnSync, so the retries are exercised through a real
 * child process: a throwaway node script whose behaviour is scripted by the attempt counter.
 */
const scriptedCommand = (steps: ReadonlyArray<{ stderr?: string; stdout?: string }>): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-command-test-"));
  const counter = NodePath.join(dir, "counter");
  NodeFS.writeFileSync(counter, "0");
  const script = NodePath.join(dir, "script.cjs");
  NodeFS.writeFileSync(
    script,
    `const fs = require("node:fs");
const steps = ${JSON.stringify(steps)};
const counter = ${JSON.stringify(counter)};
const attempt = Number(fs.readFileSync(counter, "utf8"));
fs.writeFileSync(counter, String(attempt + 1));
const step = steps[Math.min(attempt, steps.length - 1)];
if (step.stderr) process.stderr.write(step.stderr);
if (step.stdout) process.stdout.write(step.stdout);
process.exit(step.stderr || step.stdout ? (step.stderr ? 1 : 0) : 1);
`,
  );
  return script;
};

it("classifies 5xx, secondary rate limits, and connection text as transient", () => {
  assert.strictEqual(
    isTransientCommandFailure(failure({ stderr: "HTTP 503: Service Unavailable" })),
    true,
  );
  assert.strictEqual(isTransientCommandFailure(failure({ stderr: "HTTP 502" })), true);
  assert.strictEqual(isTransientCommandFailure(failure({ stderr: "HTTP 504" })), true);
  assert.strictEqual(
    isTransientCommandFailure(failure({ stderr: "was submitted too quickly" })),
    true,
  );
  assert.strictEqual(
    isTransientCommandFailure(failure({ stderr: "Secondary rate limit hit" })),
    true,
  );
  assert.strictEqual(
    isTransientCommandFailure(failure({ stderr: "Connection reset by peer" })),
    true,
  );
  assert.strictEqual(isTransientCommandFailure(failure({ stderr: "EAI_AGAIN" })), true);
  assert.strictEqual(isTransientCommandFailure(failure({ stdout: "ETIMEDOUT" })), true);
  assert.strictEqual(isTransientCommandFailure(failure({ stderr: "TLS handshake timeout" })), true);
});

it("classifies a spawn timeout error as transient", () => {
  assert.strictEqual(
    isTransientCommandFailure(failure({ error: new Error("spawnSync gh ETIMEDOUT") })),
    true,
  );
});

it("does not classify fatal failures as transient", () => {
  assert.strictEqual(isTransientCommandFailure(failure({ stderr: "HTTP 404: Not Found" })), false);
  assert.strictEqual(isTransientCommandFailure(failure({ stderr: "rate limit exceeded" })), false);
  assert.strictEqual(isTransientCommandFailure(failure({ stderr: "Bad credentials" })), false);
  assert.strictEqual(isTransientCommandFailure(failure({ status: 1 })), false);
});

it("retries a transient 503 and succeeds on attempt 2 without sleeping", () => {
  const script = scriptedCommand([
    { stderr: "HTTP 503: Service Unavailable" },
    { stdout: '[{"number":933}]' },
  ]);
  const output = runCommandTextWithRetry("node", [script], {}, { attempts: 3, baseDelayMs: 0 });
  assert.strictEqual(output, '[{"number":933}]');
});

it("names the matched reason on the retry stderr line", () => {
  const script = scriptedCommand([{ stderr: "HTTP 503: Service Unavailable" }, { stdout: "[]" }]);
  const lines: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    runCommandTextWithRetry("node", [script], {}, { attempts: 3, baseDelayMs: 0 });
  } finally {
    process.stderr.write = originalWrite;
  }
  const retryLine = lines.find((line) => line.includes("failed transiently"));
  assert.ok(retryLine !== undefined);
  assert.include(retryLine, "HTTP 502/503/504");
  assert.include(retryLine, "attempt 1/3");
});

it("exhausts transient retries and throws with the original text", () => {
  const script = scriptedCommand([
    { stderr: "HTTP 503: Service Unavailable" },
    { stderr: "HTTP 503: Service Unavailable" },
    { stderr: "HTTP 503: Service Unavailable" },
  ]);
  let thrown: unknown;
  try {
    runCommandTextWithRetry("node", [script], {}, { attempts: 3, baseDelayMs: 0 });
  } catch (error) {
    thrown = error;
  }
  assert.instanceOf(thrown, Error);
  const message = (thrown as Error).message;
  assert.include(message, "HTTP 503: Service Unavailable");
  assert.include(message, "(after 3 attempts)");
});

it("streams a command's real exit status without capturing its output", () => {
  const result = runCommand(
    "node",
    ["-e", "console.log('to stdout'); console.error('to stderr'); process.exit(3)"],
    { stream: true },
  );
  assert.strictEqual(result.status, 3);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});

it("a short timeout override kills a slow command and names it in the error", () => {
  const result = runCommand("sleep", ["5"], { timeout: 100 });
  assert.throws(() => requireCommandSuccess(result, "sleep", ["5"]), /sleep 5 failed.*ETIMEDOUT/s);
});

it("throws immediately on a 404 with zero retries", () => {
  const script = scriptedCommand([{ stderr: "HTTP 404: Not Found" }]);
  assert.throws(
    () => runCommandTextWithRetry("node", [script], {}, { attempts: 3, baseDelayMs: 0 }),
    /HTTP 404: Not Found/,
  );
  // The scripted command records one increment per attempt; a second run would fail differently,
  // so assert the counter shows exactly one attempt.
  const counter = NodePath.join(NodePath.dirname(script), "counter");
  assert.strictEqual(NodeFS.readFileSync(counter, "utf8"), "1");
});
