import {
  DEFAULT_CLIENT_SETTINGS,
  type ConfirmDialogOptions,
  type ContextMenuItem,
  type DesktopBridge,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
const showContextMenuFallbackMock = vi.fn<
  <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: {
      x: number;
      y: number;
    },
  ) => Promise<T | null>
>();
const dismissContextMenuMock = vi.fn<() => void>();
const requestConfirmDialogMock =
  vi.fn<(message: string, options?: ConfirmDialogOptions) => Promise<boolean> | undefined>();
vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
  dismissContextMenu: dismissContextMenuMock,
}));
vi.mock("./confirmDialog", () => ({
  requestConfirmDialog: requestConfirmDialogMock,
}));
function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}
function testWindow(): Window & typeof globalThis {
  return globalThis.window ?? (globalThis as unknown as Window & typeof globalThis);
}
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  if (globalThis.window === undefined) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
  }
  Reflect.deleteProperty(testWindow(), "desktopBridge");
  Object.defineProperty(testWindow(), "localStorage", {
    configurable: true,
    value: createLocalStorageStub(),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});
describe("LocalApi", () => {
  it("uses the themed context-menu renderer without a desktop bridge", async () => {
    showContextMenuFallbackMock.mockResolvedValue("rename");
    const { createLocalApi } = await import("./localApi");
    const items = [{ id: "rename", label: "Rename" }] as const;
    await expect(createLocalApi().contextMenu.show(items, { x: 4, y: 5 })).resolves.toBe("rename");
    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, { x: 4, y: 5 });
  });
  it("dismisses an open themed context menu without a desktop bridge", async () => {
    const { createLocalApi } = await import("./localApi");
    await createLocalApi().contextMenu.close();
    expect(dismissContextMenuMock).toHaveBeenCalledOnce();
  });
  it("uses the themed context-menu renderer with a desktop bridge", async () => {
    showContextMenuFallbackMock.mockResolvedValue("delete");
    const showContextMenu = vi.fn().mockResolvedValue("native-delete");
    testWindow().desktopBridge = { showContextMenu } as unknown as DesktopBridge;
    const { createLocalApi } = await import("./localApi");
    const items = [{ id: "delete", label: "Delete" }] as const;
    await expect(createLocalApi().contextMenu.show(items, { x: 4, y: 5 })).resolves.toBe("delete");
    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, { x: 4, y: 5 });
    expect(showContextMenu).not.toHaveBeenCalled();
  });
  it("dismisses an open themed context menu with a desktop bridge", async () => {
    testWindow().desktopBridge = {} as DesktopBridge;
    const { createLocalApi } = await import("./localApi");
    await createLocalApi().contextMenu.close();
    expect(dismissContextMenuMock).toHaveBeenCalledOnce();
  });
});
