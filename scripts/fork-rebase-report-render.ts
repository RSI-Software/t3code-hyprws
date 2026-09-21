import type { ForkRebaseReport } from "./fork-rebase-report.ts";

export const encodeReportJson = (report: ForkRebaseReport): string => {
  const encoded = JSON.stringify(report, null, 2);
  const prettyTags = JSON.stringify(report.sharedBase.upstreamTags, null, 2).replaceAll(
    "\n",
    "\n    ",
  );
  const inlineTags = `[${report.sharedBase.upstreamTags.map((tag) => JSON.stringify(tag)).join(", ")}]`;
  const property = `"upstreamTags": ${prettyTags}`;
  const inlineProperty = `"upstreamTags": ${inlineTags}`;
  const formatted =
    `    ${inlineProperty}`.length <= 100 ? encoded.replace(property, inlineProperty) : encoded;
  return `${formatted}\n`;
};
