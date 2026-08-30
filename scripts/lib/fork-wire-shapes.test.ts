import { assert, it } from "@effect/vitest";

import {
  compareWireShapes,
  extractWireShapes,
  parseForkWireBaseline,
  wireFindingKey,
} from "./fork-wire-shapes.ts";

const changes = (before: string, after: string, path = "packages/contracts/src/environment.ts") =>
  compareWireShapes(before, after, path).map((finding) => `${finding.schema}: ${finding.change}`);

it("extracts exported literal and struct wire shapes", () => {
  const shapes = extractWireShapes(`
const Internal = Schema.Literals(["hidden"])
export const ThreadEnvMode =
  Schema.Literals(["local", "worktree"])
export const Project = Schema.Struct({
  id: Schema.String,
  label: Schema.optional(Schema.String),
  nested: Schema.Struct({ ignored: Schema.optionalKey(Schema.String) }),
})
`);
  assert.strictEqual(shapes.length, 2);
  assert.deepStrictEqual(shapes[0], {
    kind: "literals",
    name: "ThreadEnvMode",
    members: new Set(["local", "worktree"]),
  });
  assert.deepStrictEqual(shapes[1], {
    kind: "struct",
    name: "Project",
    fields: new Map([
      ["id", { optional: false }],
      ["label", { optional: true }],
      ["nested", { optional: true }],
    ]),
  });
});

it("refuses a literal added to an existing schema", () => {
  assert.deepStrictEqual(
    changes(
      'export const Mode = Schema.Literals(["local", "remote"])',
      'export const Mode = Schema.Literals(["local", "remote", "fork"])',
    ),
    ["Mode: literal added: fork"],
  );
});

it("covers the ThreadEnvMode worktrunk regression", () => {
  assert.deepStrictEqual(
    changes(
      'export const ThreadEnvMode = Schema.Literals(["local", "worktree"])',
      'export const ThreadEnvMode = Schema.Literals(["local", "worktree", "worktrunk"])',
    ),
    ["ThreadEnvMode: literal added: worktrunk"],
  );
});

it("refuses a required field added to an existing struct", () => {
  assert.deepStrictEqual(
    changes(
      "export const Project = Schema.Struct({ id: Schema.String })",
      "export const Project = Schema.Struct({ id: Schema.String, forkMode: Schema.String })",
    ),
    ["Project: required field added: forkMode"],
  );
});

it("refuses a removed field", () => {
  assert.deepStrictEqual(
    changes(
      "export const Project = Schema.Struct({ id: Schema.String, name: Schema.String })",
      "export const Project = Schema.Struct({ id: Schema.String })",
    ),
    ["Project: field removed: name"],
  );
});

it("reports a renamed field as a removal", () => {
  assert.deepStrictEqual(
    changes(
      "export const Project = Schema.Struct({ id: Schema.String, oldName: Schema.String })",
      "export const Project = Schema.Struct({ id: Schema.String, newName: Schema.String })",
    ),
    ["Project: field removed: oldName"],
  );
});

it("allows every supported optional or defaulted sibling field form", () => {
  for (const value of [
    "Schema.optional(Schema.String)",
    "Schema.optionalKey(Schema.String)",
    "Schema.optionalWith(Schema.String, { default: () => 'fork' })",
    "Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed('fork')))",
    "Schema.String.pipe(Schema.withConstructorDefault(() => 'fork'))",
  ]) {
    assert.deepStrictEqual(
      changes(
        "export const Project = Schema.Struct({ id: Schema.String })",
        `export const Project = Schema.Struct({ id: Schema.String, forkMode: ${value} })`,
      ),
      [],
      value,
    );
  }
});

it("allows a brand-new exported schema", () => {
  assert.deepStrictEqual(changes("", 'export const ForkMode = Schema.Literals(["fork"])'), []);
});

it("refuses any ipc.ts change that is not only optional fields", () => {
  assert.deepStrictEqual(
    changes(
      "export const Request = Schema.Struct({ id: Schema.String })",
      "export const Request = Schema.Struct({ id: Schema.String, mode: Schema.String })",
      "packages/contracts/src/ipc.ts",
    ),
    ["ipc.ts: desktop IPC shape changed"],
  );
  assert.deepStrictEqual(changes("// before", "// after", "packages/contracts/src/ipc.ts"), [
    "ipc.ts: desktop IPC shape changed",
  ]);
});

it("allows ipc.ts changes whose only extracted differences are optional fields", () => {
  assert.deepStrictEqual(
    changes(
      "export const Request = Schema.Struct({ id: Schema.String })",
      "export const Request = Schema.Struct({ id: Schema.String, forkMode: Schema.optional(Schema.String) })",
      "packages/contracts/src/ipc.ts",
    ),
    [],
  );
});

it("parses baseline entries and derives stable finding keys", () => {
  const baseline = parseForkWireBaseline(
    "# Baseline\n\n| Key | Reason |\n| --- | --- |\n| Mode: literal added: fork | shipped before the wire check |\n",
  );
  assert.strictEqual(baseline.get("Mode: literal added: fork"), "shipped before the wire check");
  assert.strictEqual(
    wireFindingKey("feat(desktop): add bridge", {
      schema: "ipc.ts",
      change: "desktop IPC shape changed",
      hint: "review",
    }),
    "ipc.ts: desktop IPC shape changed: feat(desktop): add bridge",
  );
});

it("appends the review escape-hatch hint to every finding", () => {
  const [finding] = compareWireShapes(
    'export const Mode = Schema.Literals(["local"])',
    'export const Mode = Schema.Literals(["local", "fork"])',
    "packages/contracts/src/environment.ts",
  );
  assert.strictEqual(
    finding?.hint,
    "add an optional fork-only sibling field instead, or add trailer Fork-Wire: reviewed <reason>",
  );
});
