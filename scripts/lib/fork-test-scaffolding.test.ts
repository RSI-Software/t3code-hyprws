import { assert, it } from "@effect/vitest";
import { relocatedTestScaffolding } from "./fork-test-scaffolding.ts";

it("recognizes relocated bindings and suite wrappers but never assertions or missing imports", () => {
  const upstream = [
    'import { retained, moved, lost } from "module";',
    'import * as Layer from "effect/Layer";',
    'describe("updates", () => {',
    '  expect(result).toBe("idle");',
    "});",
  ].join("\n");
  const head = 'import { retained } from "module";';
  const sibling = [
    'import { moved } from "module";',
    'import * as Layer from "effect/Layer";',
    'describe("updates", () => {',
    '  expect(result).toBe("completed");',
    "});",
  ].join("\n");
  const missing = relocatedTestScaffolding(upstream, head, sibling);
  assert.isFalse(missing.lines.has('import { retained, moved, lost } from "module";'));
  assert.isTrue(missing.lines.has('import * as Layer from "effect/Layer";'));
  assert.isFalse(missing.lines.has('expect(result).toBe("idle");'));
  assert.equal(missing.suites, 1);
  const carried = relocatedTestScaffolding(
    upstream,
    head,
    sibling + '\nimport { lost } from "module";',
  );
  assert.isTrue(carried.lines.has('import { retained, moved, lost } from "module";'));
  assert.equal(relocatedTestScaffolding(upstream, upstream, sibling).suites, 0);
  assert.isFalse(
    relocatedTestScaffolding(
      upstream,
      head,
      sibling.replace('"effect/Layer"', '"other/Layer"'),
    ).lines.has('import * as Layer from "effect/Layer";'),
  );
});
