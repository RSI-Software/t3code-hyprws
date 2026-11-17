import { parsePromptLinkRepository, type PromptLinkRepository } from "./promptLinks.ts";

// Linear's coding-tool links carry only a prompt; its issue context lists labels as
// `<label>Group › name</label>`, and a `repo` group of `owner/name` labels names the repository.
const LINEAR_REPO_LABEL = /<label>\s*repo\s*[›>]\s*([^<]+?)\s*<\/label>/i;

export function linearRepoLabelFork(
  repository: PromptLinkRepository | null,
  prompt: string,
): { readonly repository?: PromptLinkRepository } {
  const label = repository === null ? LINEAR_REPO_LABEL.exec(prompt)?.[1] : undefined;
  const labelled = label === undefined ? null : parsePromptLinkRepository(label);
  return labelled === null ? {} : { repository: labelled };
}
