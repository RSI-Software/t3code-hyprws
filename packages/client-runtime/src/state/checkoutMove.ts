import type { ThreadCheckoutMove } from "@t3tools/contracts";

export type TerminalCheckoutMode = "follow" | "pin";

export interface CheckoutMovePresentation {
  readonly action: "retry" | "undo" | null;
  readonly detail: string;
  readonly inFlight: boolean;
  readonly label: string;
}

const MAX_TERMINAL_ATTACHMENT_ID_LENGTH = 128;

function fnv1a32(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** Keep viewer attachment identities within the terminal wire contract. */
export function boundedTerminalAttachmentId(viewerId: string, terminalId: string): string {
  const identity = `${viewerId.trim()}:${terminalId.trim()}`;
  if (identity.length <= MAX_TERMINAL_ATTACHMENT_ID_LENGTH) return identity;
  const digest = `${fnv1a32(identity, 0x811c9dc5)}${fnv1a32(identity, 0x9e3779b9)}`;
  return `${identity.slice(0, MAX_TERMINAL_ATTACHMENT_ID_LENGTH - digest.length - 1)}:${digest}`;
}

export function isCheckoutMoveInFlight(move: ThreadCheckoutMove | null | undefined): boolean {
  return move?.status === "queued" || move?.status === "preparing";
}

export function isStaleCheckoutMoveRejection(detail: string): boolean {
  return /context changed|identity validation failed|no longer matches the effective checkout/i.test(
    detail,
  );
}

export function shouldFollowCommittedCheckout(input: {
  readonly mode: TerminalCheckoutMode;
  readonly move: ThreadCheckoutMove | null | undefined;
}): boolean {
  return input.mode === "follow" && input.move?.status === "committed";
}

/** Resolve the physical checkout a retry or reverse request must compare against. */
export function checkoutMoveExpectedRoot(move: ThreadCheckoutMove): string {
  if (move.effectiveProvider !== null) return move.effectiveProvider.checkoutRoot;
  if (move.completedSteps.includes("metadata")) {
    return move.destination?.checkoutRoot ?? move.requestedPath;
  }
  return move.source.checkoutRoot;
}

function checkoutName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || path
  );
}

function completedSteps(move: ThreadCheckoutMove): string {
  return move.completedSteps.length > 0 ? move.completedSteps.join(", ") : "none";
}

function providerState(move: ThreadCheckoutMove): string {
  if (move.effectiveProvider === null) return "No provider is running.";
  const provider = checkoutName(move.effectiveProvider.checkoutRoot);
  if (move.providerAvailable === undefined) return `Effective provider: ${provider}.`;
  return move.providerAvailable
    ? `Effective provider: ${provider}; provider available.`
    : `Effective provider: ${provider}; provider unavailable.`;
}

/** Turn durable transition state into the same honest copy on every client. */
export function presentCheckoutMove(
  move: ThreadCheckoutMove | null | undefined,
): CheckoutMovePresentation | null {
  if (!move) return null;
  const source = checkoutName(move.source.checkoutRoot);
  const requested = checkoutName(move.requestedPath);
  const route = `${source} → ${requested}`;
  const failure = move.detail ? ` ${move.detail}` : "";

  switch (move.status) {
    case "queued":
      return {
        action: null,
        inFlight: true,
        label: `Queued: ${route}`,
        detail: `Requested ${requested}. The effective checkout remains ${source} while the active turn settles.`,
      };
    case "preparing":
      return {
        action: null,
        inFlight: true,
        label: `Moving: ${route}`,
        detail: `Preparing ${requested}. The effective checkout remains ${source} until the transition commits.`,
      };
    case "failed":
      return {
        action: "retry",
        inFlight: false,
        label: `Move failed · Retry`,
        detail: `Requested ${requested}; completed steps: ${completedSteps(move)}. ${providerState(move)}${failure}`,
      };
    case "partial":
      return {
        action: "retry",
        inFlight: false,
        label: `Partially moved · Retry`,
        detail: `Requested ${requested}; completed steps: ${completedSteps(move)}. ${providerState(move)}${failure}`,
      };
    case "committed":
      return {
        action: "undo",
        inFlight: false,
        label: `Moved ${route} · Undo`,
        detail:
          move.effectiveProvider === null
            ? `Effective checkout is ${requested}. No provider is running; the next turn starts at ${requested}. Following terminal views reattach from this committed state; pinned views stay put. Undo is checked against the current physical checkout.`
            : `Effective checkout is ${requested}; effective provider is ${checkoutName(move.effectiveProvider.checkoutRoot)}. Following terminal views reattach from this committed state; pinned views stay put. Undo is checked against the current physical checkout.`,
      };
  }
}
