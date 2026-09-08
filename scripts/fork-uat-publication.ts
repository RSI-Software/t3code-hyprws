// @effect-diagnostics nodeBuiltinImport:off - UAT bundles are external operator state.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { InputCommandRunner as CommandRunner } from "./lib/fork-command.ts";
import type { UatTask } from "./fork-uat-policy.ts";
import { parentUatBody, renderUatTaskBody } from "./fork-uat-policy.ts";

export const PUBLICATION_SCHEMA = "fork-uat-publication/v1";

export interface PublicationFile {
  readonly path: string;
  readonly sha256: string;
}

export interface PublicationTask extends PublicationFile {
  readonly area: string;
  readonly condition: string;
  readonly title: string;
}

export interface UatPublication {
  readonly schema: typeof PUBLICATION_SCHEMA;
  readonly reviewSha256: string;
  readonly ref: string;
  readonly sha: string;
  readonly targetVersion: string;
  readonly relatesTo: number | null;
  readonly parent: PublicationFile & { readonly title: string };
  readonly tasks: ReadonlyArray<PublicationTask>;
}

export interface CreatedIssue {
  readonly number: number;
  readonly url: string;
}

interface CreateReceipt {
  readonly phase?: string;
  readonly issue?: CreatedIssue | null;
}

export const sha256 = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const slug = (value: string): string =>
  value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "acceptance";

const writeNew = (path: string, body: string): void => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, body, { flag: "wx" });
};

export const preparePublication = (input: {
  readonly bundlePath: string;
  readonly reviewPath: string;
  readonly reviewBody: string;
  readonly ref: string;
  readonly sha: string;
  readonly targetVersion: string;
  readonly relatesTo: number | null;
  readonly tasks: ReadonlyArray<UatTask>;
}): UatPublication => {
  const manifestPath = NodePath.join(input.bundlePath, "manifest.json");
  if (NodeFS.existsSync(manifestPath)) {
    throw new Error(`publication bundle already exists: ${input.bundlePath}`);
  }
  const parentBody = parentUatBody(input.reviewBody);
  const parentPath = NodePath.join(input.bundlePath, "parent.md");
  writeNew(parentPath, parentBody);
  const tasks = input.tasks.map((task, index): PublicationTask => {
    const body = renderUatTaskBody(task, input);
    const path = NodePath.join(
      input.bundlePath,
      "tasks",
      `${String(index + 1).padStart(2, "0")}-${slug(task.title)}.md`,
    );
    writeNew(path, body);
    return {
      area: task.area,
      condition: task.title,
      title: `UAT ${input.targetVersion}: ${task.area} — ${task.title}`,
      path: NodePath.relative(input.bundlePath, path),
      sha256: sha256(body),
    };
  });
  const publication: UatPublication = {
    schema: PUBLICATION_SCHEMA,
    reviewSha256: sha256(input.reviewBody),
    ref: input.ref,
    sha: input.sha,
    targetVersion: input.targetVersion,
    relatesTo: input.relatesTo,
    parent: {
      title: `UAT ${input.targetVersion}`,
      path: NodePath.relative(input.bundlePath, parentPath),
      sha256: sha256(parentBody),
    },
    tasks,
  };
  writeNew(manifestPath, `${JSON.stringify(publication, null, 2)}\n`);
  return publication;
};

const fullPath = (bundlePath: string, file: PublicationFile): string => {
  const path = NodePath.resolve(bundlePath, file.path);
  const root = `${NodePath.resolve(bundlePath)}${NodePath.sep}`;
  if (!path.startsWith(root)) throw new Error(`publication file escapes bundle: ${file.path}`);
  return path;
};

const verifyFile = (bundlePath: string, file: PublicationFile): void => {
  const path = fullPath(bundlePath, file);
  const body = NodeFS.readFileSync(path, "utf8");
  if (sha256(body) !== file.sha256)
    throw new Error(`publication file changed after review: ${path}`);
};

export const readPublication = (bundlePath: string): UatPublication => {
  const manifestPath = NodePath.join(bundlePath, "manifest.json");
  const manifestBody = NodeFS.readFileSync(manifestPath, "utf8");
  const sealPath = NodePath.join(bundlePath, "preflight.json");
  const seal = JSON.parse(NodeFS.readFileSync(sealPath, "utf8")) as {
    readonly schema?: string;
    readonly manifestSha256?: string;
  };
  if (seal.schema !== "fork-uat-preflight/v1" || seal.manifestSha256 !== sha256(manifestBody)) {
    throw new Error(`publication bundle was not preflighted or changed afterwards: ${bundlePath}`);
  }
  const value = JSON.parse(manifestBody) as Partial<UatPublication>;
  if (
    value.schema !== PUBLICATION_SCHEMA ||
    typeof value.reviewSha256 !== "string" ||
    typeof value.ref !== "string" ||
    typeof value.sha !== "string" ||
    typeof value.targetVersion !== "string" ||
    !Array.isArray(value.tasks) ||
    value.tasks.length === 0 ||
    typeof value.parent !== "object" ||
    value.parent === null
  ) {
    throw new Error(`invalid publication bundle: ${manifestPath}`);
  }
  const publication = value as UatPublication;
  verifyFile(bundlePath, publication.parent);
  publication.tasks.forEach((task) => verifyFile(bundlePath, task));
  return publication;
};

export const sealPublication = (bundlePath: string): void => {
  const manifestPath = NodePath.join(bundlePath, "manifest.json");
  const sealPath = NodePath.join(bundlePath, "preflight.json");
  const manifestSha256 = sha256(NodeFS.readFileSync(manifestPath, "utf8"));
  writeNew(
    sealPath,
    `${JSON.stringify({ schema: "fork-uat-preflight/v1", manifestSha256 }, null, 2)}\n`,
  );
};

const readReceipt = (path: string): CreatedIssue | null => {
  if (!NodeFS.existsSync(path)) return null;
  const receipt = JSON.parse(NodeFS.readFileSync(path, "utf8")) as CreateReceipt;
  if (receipt.phase !== "complete" || receipt.issue === null || receipt.issue === undefined)
    return null;
  if (
    !Number.isInteger(receipt.issue.number) ||
    !receipt.issue.url.startsWith("https://github.com/")
  ) {
    throw new Error(`invalid completed ghb receipt: ${path}`);
  }
  return receipt.issue;
};

export const ensureCreated = (
  runner: CommandRunner,
  receiptPath: string,
  createArgs: ReadonlyArray<string>,
  requireSuccess: (runner: CommandRunner, command: string, args: ReadonlyArray<string>) => string,
): CreatedIssue => {
  const existing = readReceipt(receiptPath);
  if (existing !== null) return existing;
  let output: string;
  if (NodeFS.existsSync(receiptPath)) {
    output = requireSuccess(runner, "ghb", ["issue", "create", "--resume", receiptPath]);
  } else {
    output = requireSuccess(runner, "ghb", [...createArgs, "--json", receiptPath]);
  }
  let created = readReceipt(receiptPath);
  if (created === null) {
    const urls = [
      ...output.matchAll(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/([1-9][0-9]*)/g),
    ];
    const url = urls.at(-1)?.[0];
    const number = Number(urls.at(-1)?.[1]);
    if (url === undefined || !Number.isInteger(number)) {
      throw new Error(`ghb did not report a completed issue: ${receiptPath}`);
    }
    created = { number, url };
    NodeFS.writeFileSync(receiptPath, `${JSON.stringify({ phase: "complete", issue: created })}\n`);
  }
  return created;
};

export const publicationPath = (reviewPath: string): string => `${reviewPath}.bundle`;

export const publicationFilePath = fullPath;
