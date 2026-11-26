import { EnvironmentId, IsoDateTime } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  colleagueForMenuId,
  colleagueShareMenuIdFork,
  colleagueShareTargets,
  shareSuggestions,
} from "./colleagueShare.logic.fork";

const colleague = (name: string) => ({
  subject: `colleague:${name.toLowerCase()}`,
  name,
  environmentId: EnvironmentId.make(`env-${name}`),
  url: "https://example.test",
  savedAt: IsoDateTime.make("2026-11-25T00:00:00.000Z"),
});
const person = (name: string) => ({ subject: `colleague:${name.toLowerCase()}`, name });

describe("colleague share targets", () => {
  it("marks colleagues the thread is shared with, so their entry stops sharing", () => {
    expect(colleagueShareTargets([colleague("Sam"), colleague("Jordan")], [person("Sam")])).toEqual(
      [
        { subject: "colleague:jordan", name: "Jordan", shared: false },
        { subject: "colleague:sam", name: "Sam", shared: true },
      ],
    );
  });

  it("offers unshared colleagues in one click, and links only for everyone else", () => {
    expect(
      shareSuggestions([colleague("Jordan"), colleague("Sam")], {
        sharedWith: [person("Sam")],
        collaborators: [person("Jordan"), person("Sam"), person("Alex")],
      }),
    ).toEqual({ colleagues: [colleague("Jordan")], sharedBefore: [person("Alex")] });
  });

  it("resolves a menu entry to its colleague, and ignores other entries", () => {
    const targets = colleagueShareTargets([colleague("Jordan")], []);
    expect(colleagueForMenuId(colleagueShareMenuIdFork("colleague:jordan"), targets)).toBe(
      targets[0],
    );
    expect(colleagueForMenuId(colleagueShareMenuIdFork("colleague:gone"), targets)).toBeUndefined();
    expect(colleagueForMenuId("share-collaborator", targets)).toBeNull();
  });
});
