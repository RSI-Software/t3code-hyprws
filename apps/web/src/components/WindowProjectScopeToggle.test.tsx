import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { applyWindowProjectScopeChange } from "../windowProjectScope";
import { WindowProjectScopeToggle } from "./WindowProjectScopeToggle";

const projectRef = scopeProjectRef("environment-1" as never, "project-1" as never);

describe("WindowProjectScopeToggle", () => {
  it("renders only for a project window", () => {
    expect(
      renderToStaticMarkup(
        <WindowProjectScopeToggle
          forcedProjectRef={null}
          listScope={{ kind: "all" }}
          onNavigate={() => undefined}
        />,
      ),
    ).toBe("");

    const html = renderToStaticMarkup(
      <WindowProjectScopeToggle
        forcedProjectRef={projectRef}
        listScope={{ kind: "project", projectRef }}
        onNavigate={() => undefined}
      />,
    );
    expect(html).toContain("This project");
    expect(html).toContain("All projects");
  });

  it("writes storage and navigates exactly once for each scope change", () => {
    const setItem = vi.fn();
    const navigate = vi.fn();

    applyWindowProjectScopeChange({
      projectRef,
      currentScope: "project",
      nextScope: "all",
      navigate,
      storage: { setItem },
    });
    expect(setItem).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenLastCalledWith(
      "t3code:window-project-list-scope:environment-1:project-1",
      "all",
    );
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenLastCalledWith("all");

    setItem.mockClear();
    navigate.mockClear();
    applyWindowProjectScopeChange({
      projectRef,
      currentScope: "all",
      nextScope: "project",
      navigate,
      storage: { setItem },
    });
    expect(setItem).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenLastCalledWith(
      "t3code:window-project-list-scope:environment-1:project-1",
      "project",
    );
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenLastCalledWith(undefined);
  });

  it("ignores a request for the already active scope", () => {
    const setItem = vi.fn();
    const navigate = vi.fn();
    applyWindowProjectScopeChange({
      projectRef,
      currentScope: "project",
      nextScope: "project",
      navigate,
      storage: { setItem },
    });
    expect(setItem).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
