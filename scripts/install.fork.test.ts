// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer with stub curl and uname binaries.
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

// Newest first, as the releases API lists them; a nightly outranks every stable here.
const RELEASES = `[
  { "tag_name": "v0.0.43-hyprws-nightly.20260923.695" },
  { "tag_name": "v0.0.43-hyprws.3" },
  { "tag_name": "v0.0.43-hyprws-nightly.20260923.693" },
  { "tag_name": "v0.0.43-hyprws.2" }
]
`;

// Serves the fixture for the releases API and 404s everything else, so the
// installer stops right after announcing the version it resolved.
const STUB_CURL = `#!/bin/sh
url= out=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    http*) url="$1" ;;
  esac
  shift
done
printf '%s\\n' "$url" >> "$STUB_DIR/urls"
case "$url" in
  https://api.github.com/*) cp "$STUB_DIR/releases.json" "$out"; printf 200 ;;
  *) : > "$out"; printf 404 ;;
esac
`;

const roots: Array<string> = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const runInstaller = async (input: { uname: string; env?: Record<string, string> }) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-fork-"));
  roots.push(root);
  const bin = NodePath.join(root, "stub-bin");
  await NodeFSP.mkdir(bin);
  await NodeFSP.writeFile(NodePath.join(root, "releases.json"), RELEASES);
  await NodeFSP.writeFile(NodePath.join(bin, "curl"), STUB_CURL, { mode: 0o755 });
  const [system, machine] = input.uname.split(" ");
  await NodeFSP.writeFile(
    NodePath.join(bin, "uname"),
    `#!/bin/sh\ncase "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; esac\n`,
    { mode: 0o755 },
  );
  const result = NodeChildProcess.spawnSync(
    "sh",
    [NodePath.resolve(import.meta.dirname, "install.sh")],
    {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: NodePath.join(root, "home"),
        STUB_DIR: root,
        ...input.env,
      },
    },
  );
  const urls = await NodeFSP.readFile(NodePath.join(root, "urls"), "utf8").catch(() => "");
  return { status: result.status, stderr: result.stderr, urls: urls.trim().split("\n") };
};

describe.skipIf(HostProcessPlatform.defaultValue() !== "linux")("fork installer", () => {
  it("resolves the newest -hyprws stable from the fork's releases, never a nightly", async () => {
    const { stderr, urls } = await runInstaller({ uname: "Linux x86_64" });
    expect(stderr).toContain("Installing T3 Code 0.0.43-hyprws.3\n");
    expect(urls).toEqual([
      "https://api.github.com/repos/RSI-Software/t3code-hyprws/releases?per_page=100",
      "https://github.com/RSI-Software/t3code-hyprws/releases/download/v0.0.43-hyprws.3/SHA256SUMS",
    ]);
  });

  it("resolves the newest -hyprws-nightly on the nightly channel", async () => {
    const { stderr } = await runInstaller({
      uname: "Linux x86_64",
      env: { T3CODE_CHANNEL: "nightly" },
    });
    expect(stderr).toContain("Installing T3 Code 0.0.43-hyprws-nightly.20260923.695\n");
  });

  it.each(["Darwin arm64", "Linux aarch64"])("refuses %s in one line", async (uname) => {
    const { status, stderr, urls } = await runInstaller({ uname });
    expect(status).toBe(1);
    expect(stderr.trim().split("\n").at(-1)).toBe(
      `t3 install: RSI-Software/t3code-hyprws ships Linux x64 builds only, not ${uname}`,
    );
    expect(urls).toEqual([""]);
  });
});
