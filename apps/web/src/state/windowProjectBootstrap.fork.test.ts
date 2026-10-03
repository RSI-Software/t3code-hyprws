import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { environmentShellBootstrappedAtom } from "./windowProjectBootstrap.fork";

const sources = vi.hoisted(() => ({
  shells: new Map<EnvironmentId, Atom.Writable<{ snapshot: Option.Option<object> }>>(),
  connections: new Map<EnvironmentId, Atom.Writable<SupervisorConnectionState>>(),
}));

vi.mock("./shell", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const Option = await import("effect/Option");
  return {
    environmentShell: {
      stateValueAtom: Atom.family((id: EnvironmentId) => {
        const atom = Atom.make({ snapshot: Option.none<object>() });
        sources.shells.set(id, atom);
        return atom;
      }),
    },
  };
});

vi.mock("../connection/catalog", async () => {
  const { Atom, AsyncResult } = await import("effect/unstable/reactivity");
  const { AVAILABLE_CONNECTION_STATE } = await import("@t3tools/client-runtime/connection");
  return {
    environmentCatalog: {
      stateAtom: Atom.family((id: EnvironmentId) => {
        const state = Atom.make(AVAILABLE_CONNECTION_STATE);
        sources.connections.set(id, state);
        return Atom.make((get) => AsyncResult.success(get(state)));
      }),
    },
  };
});

const registries: Array<AtomRegistry.AtomRegistry> = [];
afterEach(() => {
  for (const registry of registries) registry.dispose();
  registries.length = 0;
});

function fixture(name: string) {
  const registry = AtomRegistry.make();
  registries.push(registry);
  const environmentId = EnvironmentId.make(name);
  const ready = environmentShellBootstrappedAtom(environmentId);
  registry.mount(ready);
  return {
    registry,
    ready,
    setConnection: (patch: Partial<SupervisorConnectionState>) =>
      registry.set(sources.connections.get(environmentId)!, {
        ...AVAILABLE_CONNECTION_STATE,
        ...patch,
      }),
    setSnapshot: (present: boolean) =>
      registry.set(sources.shells.get(environmentId)!, {
        snapshot: present ? Option.some({}) : Option.none(),
      }),
  };
}

describe("project-window bootstrap", () => {
  it("keeps a pending remote environment pending while a local environment has a snapshot", () => {
    const remote = fixture("pending-remote");
    const localId = EnvironmentId.make("ready-local");
    const localReady = environmentShellBootstrappedAtom(localId);
    remote.registry.mount(localReady);
    remote.registry.set(sources.shells.get(localId)!, { snapshot: Option.some({}) });
    remote.setConnection({ phase: "connecting", desired: true });
    expect(remote.registry.get(localReady)).toBe(true);
    expect(remote.registry.get(remote.ready)).toBe(false);
    remote.setSnapshot(true);
    expect(remote.registry.get(remote.ready)).toBe(true);
    remote.setSnapshot(false);
    expect(remote.registry.get(remote.ready)).toBe(false);
  });

  it("waits for the first two desired retries and settles later or cancelled backoff", () => {
    const scope = fixture("retrying-remote");
    for (const attempt of [1, 2]) {
      scope.setConnection({ phase: "backoff", desired: true, attempt });
      expect(scope.registry.get(scope.ready)).toBe(false);
    }
    scope.setConnection({ phase: "backoff", desired: true, attempt: 3 });
    expect(scope.registry.get(scope.ready)).toBe(true);
    scope.setConnection({ phase: "backoff", desired: false, attempt: 1 });
    expect(scope.registry.get(scope.ready)).toBe(true);
  });

  it("settles disconnected environments but waits for a snapshot while connected", () => {
    const scope = fixture("settled-remote");
    for (const phase of ["available", "offline", "blocked"] as const) {
      scope.setConnection({ phase });
      expect(scope.registry.get(scope.ready)).toBe(true);
    }
    scope.setConnection({ phase: "connected", desired: true });
    expect(scope.registry.get(scope.ready)).toBe(false);
    scope.setSnapshot(true);
    expect(scope.registry.get(scope.ready)).toBe(true);
  });
});
