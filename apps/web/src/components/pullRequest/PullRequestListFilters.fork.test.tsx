import { CircleIcon } from "lucide-react";
import { Children, isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { PullRequestFiltersMenu } from "./PullRequestListFilters";

function hasLabeledGroup(node: ReactNode, label: string): boolean {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const props = child.props as { readonly children?: ReactNode; readonly label?: string };
    if (props.label === label) return true;
    if (hasLabeledGroup(props.children, label)) return true;
  }
  return false;
}

function menu(showProjectFilter?: boolean): ReactNode {
  return PullRequestFiltersMenu({
    state: "open",
    stateOptions: [{ value: "open", label: "Open", Icon: CircleIcon }],
    onState: () => undefined,
    involvement: "all",
    involvementOptions: [{ value: "all", label: "All", Icon: CircleIcon }],
    onInvolvement: () => undefined,
    filters: {},
    onFilters: () => undefined,
    host: undefined,
    hostOptions: [],
    onHost: () => undefined,
    server: undefined,
    serverOptions: [],
    onServer: () => undefined,
    projects: [],
    projectId: undefined,
    projectEnvironmentId: undefined,
    unavailable: new Map(),
    onProject: () => undefined,
    ...(showProjectFilter === undefined ? {} : { showProjectFilter }),
  });
}

describe("project-window pull request filter boundary", () => {
  it("hides only the project picker when the project window owns scope", () => {
    expect(hasLabeledGroup(menu(false), "State")).toBe(true);
    expect(hasLabeledGroup(menu(false), "Involvement")).toBe(true);
    expect(hasLabeledGroup(menu(false), "Project")).toBe(false);
    expect(hasLabeledGroup(menu(), "Project")).toBe(true);
  });
});
