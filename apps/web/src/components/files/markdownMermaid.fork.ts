let mermaidModule: Promise<typeof import("~/components/chat/MermaidDiagram")> | null = null;

/** Draws a Mermaid diagram with the chat's renderer, which shows its own parse errors. */
export function renderMermaid(
  container: HTMLElement,
  source: string,
  onInvalid: (invalid: boolean) => void,
): () => void {
  let destroyed = false;
  let mounted: { destroy(): void } | null = null;
  mermaidModule ??= import("~/components/chat/MermaidDiagram");
  void (async () => {
    const mermaid = await mermaidModule;
    const core = await mermaid.loadCore();
    const type = core.status === "loaded" ? mermaid.detectDiagramType(core.pele, source) : null;
    const load =
      core.status === "loaded" && type ? await mermaid.loadDiagramType(core.pele, type) : core;
    const math = source.includes("$$") ? await mermaid.loadMath() : null;
    if (destroyed) return;
    if (load.status !== "loaded") {
      container.textContent = "The diagram renderer failed to load.";
      onInvalid(true);
      return;
    }
    mounted = load.pele.mount(container, source, {
      links: false,
      images: false,
      zoom: false,
      autoDirection: false,
      ...(math
        ? { math, sanitize: mermaid.sanitizeMathDiagramSvg }
        : { sanitize: mermaid.sanitizeDiagramSvg }),
      onRender: () => onInvalid(false),
      onError: () => onInvalid(true),
    });
  })();
  return () => {
    destroyed = true;
    mounted?.destroy();
  };
}
