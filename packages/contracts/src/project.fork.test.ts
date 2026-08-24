import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { ProjectListEntriesInput } from "./project.ts";
const decodeListEntriesInput = Schema.decodeUnknownSync(ProjectListEntriesInput);
describe("project search inputs", () => {
  it("accepts an optional ignored-file listing request", () => {
    expect(decodeListEntriesInput({ cwd: "/workspace" }).includeIgnored).toBeUndefined();
    expect(decodeListEntriesInput({ cwd: "/workspace", includeIgnored: true }).includeIgnored).toBe(
      true,
    );
  });
});
