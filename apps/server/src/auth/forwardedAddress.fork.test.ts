import { describe, expect, it } from "vite-plus/test";

import { forwardedClientAddressFork } from "./forwardedAddress.fork.ts";

describe("forwardedClientAddressFork", () => {
  it("records the forwarded address behind a loopback proxy", () => {
    expect(forwardedClientAddressFork("127.0.0.1", { "cf-connecting-ip": "203.0.113.7" })).toEqual({
      ipAddress: "203.0.113.7",
    });
    expect(
      forwardedClientAddressFork("::1", { "x-forwarded-for": "198.51.100.2, 10.0.0.1" }),
    ).toEqual({ ipAddress: "198.51.100.2" });
    expect(forwardedClientAddressFork("127.0.0.1", { "x-forwarded-for": "not-an-ip" })).toEqual({});
  });

  it("ignores forwarded headers from a non-loopback peer", () => {
    expect(forwardedClientAddressFork("192.0.2.9", { "cf-connecting-ip": "203.0.113.7" })).toEqual(
      {},
    );
  });
});
