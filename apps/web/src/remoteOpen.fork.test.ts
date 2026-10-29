import { describe, expect, it } from "vite-plus/test";

import { buildRemoteOpenUrlInOwnWindow } from "./remoteOpen.fork";

describe("buildRemoteOpenUrlInOwnWindow", () => {
  it("opens VS Code-family folders in their own window and leaves files and other editors alone", () => {
    const open = (editor: "vscode" | "cursor" | "zed", isFile?: boolean) =>
      buildRemoteOpenUrlInOwnWindow({
        editor,
        host: "sol",
        absolutePath: "/work/project",
        ...(isFile === undefined ? {} : { isFile }),
      });
    expect([open("vscode"), open("cursor", false), open("vscode", true), open("zed")]).toEqual([
      "vscode://vscode-remote/ssh-remote+sol/work/project?windowId=_blank",
      "cursor://vscode-remote/ssh-remote+sol/work/project?windowId=_blank",
      "vscode://vscode-remote/ssh-remote+sol/work/project:1:1",
      "zed://ssh/sol/work/project",
    ]);
  });
});
