import { describe, expect, it } from "vite-plus/test";

import { providerErrorLabelFromInstanceHint } from "./ProviderCommandReactor.ts";

describe("fork provider error attribution", () => {
  it("uses the unknown driver kind when the resolved driver is not registered locally", () => {
    expect(
      providerErrorLabelFromInstanceHint({
        instanceId: "third_party_driver",
      }),
    ).toBe("third_party_driver");
  });
});
