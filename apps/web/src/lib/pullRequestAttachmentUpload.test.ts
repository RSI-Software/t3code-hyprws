import { EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  createUploadUrl: Symbol("create-upload-url"),
  uploadAttachment: Symbol("upload-attachment"),
  removeUpload: Symbol("remove-upload"),
  runAtomCommand: vi.fn(),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: mocks.runAtomCommand,
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../state/attachments", () => ({
  attachmentEnvironment: { remove: mocks.removeUpload },
}));
vi.mock("../state/pullRequests", () => ({
  pullRequestEnvironment: {
    createAttachmentUploadUrl: mocks.createUploadUrl,
    uploadAttachment: mocks.uploadAttachment,
  },
}));
import { uploadPullRequestAttachment } from "./pullRequestAttachmentUpload";

class TestXmlHttpRequest {
  static requests: TestXmlHttpRequest[] = [];

  status = 0;
  timeout = 0;
  readonly headers = new Map<string, string>();
  readonly listeners = new Map<string, () => void>();
  readonly upload = { addEventListener: () => {} };

  constructor() {
    TestXmlHttpRequest.requests.push(this);
  }

  open(): void {}

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  addEventListener(event: string, listener: () => void): void {
    this.listeners.set(event, listener);
  }

  send(): void {}

  abort(): void {
    this.listeners.get("abort")?.();
  }

  complete(status = 204): void {
    this.status = status;
    this.listeners.get("load")?.();
  }
}

const environmentId = EnvironmentId.make("environment-1");
const reference = {
  projectId: "project-1" as ProjectId,
  repository: "acme/web",
  number: 7,
};

describe("uploadPullRequestAttachment", () => {
  beforeEach(() => {
    TestXmlHttpRequest.requests = [];
    mocks.runAtomCommand.mockReset();
    mocks.runAtomCommand.mockImplementation(async (_registry: unknown, command: unknown) => {
      if (command === mocks.createUploadUrl) {
        return {
          _tag: "Success",
          value: {
            attachmentId: "pending-id",
            relativeUrl: "/api/attachments/upload/signed",
            expiresAt: 1,
          },
        };
      }
      if (command === mocks.uploadAttachment) {
        return {
          _tag: "Success",
          value: { insertion: "https://github.com/user-attachments/assets/id" },
        };
      }
      return { _tag: "Success", value: undefined };
    });
    vi.stubGlobal("XMLHttpRequest", TestXmlHttpRequest);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stages inferred media with its signed MIME type before publishing it", async () => {
    const upload = uploadPullRequestAttachment({
      environmentId,
      reference,
      httpBaseUrl: "https://environment.test/",
      file: new File([new Uint8Array([1, 2, 3])], "recording.mov"),
      onProgress: () => {},
    });
    await vi.waitFor(() => expect(TestXmlHttpRequest.requests).toHaveLength(1));

    expect(TestXmlHttpRequest.requests[0]!.headers.get("Content-Type")).toBe("video/quicktime");
    TestXmlHttpRequest.requests[0]!.complete();

    await expect(upload).resolves.toBe("https://github.com/user-attachments/assets/id");
    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.uploadAttachment,
      expect.objectContaining({
        environmentId,
        input: expect.objectContaining({
          ...reference,
          attachmentId: "pending-id",
          mimeType: "video/quicktime",
        }),
      }),
      expect.anything(),
    );
    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.removeUpload,
      { environmentId, input: { attachmentId: "pending-id" } },
      expect.anything(),
    );
  });

  it("announces publishing only once the bytes are staged", async () => {
    const onPublish = vi.fn();
    const upload = uploadPullRequestAttachment({
      environmentId,
      reference,
      httpBaseUrl: "https://environment.test/",
      file: new File([new Uint8Array([1])], "demo.png", { type: "image/png" }),
      onProgress: () => {},
      onPublish,
    });
    await vi.waitFor(() => expect(TestXmlHttpRequest.requests).toHaveLength(1));
    expect(onPublish).not.toHaveBeenCalled();
    TestXmlHttpRequest.requests[0]!.complete();

    await expect(upload).resolves.toBe("https://github.com/user-attachments/assets/id");
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.uploadAttachment,
      expect.anything(),
      expect.anything(),
    );
  });

  it("does not publish a staged file whose upload was cancelled", async () => {
    const controller = new AbortController();
    const upload = uploadPullRequestAttachment({
      environmentId,
      reference,
      httpBaseUrl: "https://environment.test/",
      file: new File([new Uint8Array([1])], "demo.png", { type: "image/png" }),
      onProgress: () => {},
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(TestXmlHttpRequest.requests).toHaveLength(1));
    controller.abort();

    await expect(upload).rejects.toThrow();
    expect(mocks.runAtomCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      mocks.uploadAttachment,
      expect.anything(),
      expect.anything(),
    );
    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.removeUpload,
      { environmentId, input: { attachmentId: "pending-id" } },
      expect.anything(),
    );
  });

  it("releases the signed staging slot when the upload URL is invalid", async () => {
    await expect(
      uploadPullRequestAttachment({
        environmentId,
        reference,
        httpBaseUrl: "not a URL",
        file: new File([new Uint8Array([1])], "demo.png", { type: "image/png" }),
        onProgress: () => {},
      }),
    ).rejects.toThrow("upload URL is invalid");

    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.removeUpload,
      { environmentId, input: { attachmentId: "pending-id" } },
      expect.anything(),
    );
  });
});
