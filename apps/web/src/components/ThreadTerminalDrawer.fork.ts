// Fork-owned focus request gating for thread terminal viewports. Upstream
// focuses a terminal whenever it becomes ready or `focusRequestId` changes;
// the fork wants the terminal to take focus only on an explicit request (the
// composer owns focus on thread change), so the viewport's upstream effect
// asks this module whether the incoming request is real and unconsumed.
export function shouldHandleTerminalFocusRequest(input: {
  focusOnRequest: boolean;
  focusRequestId: number;
  handledFocusRequestId: number;
}): boolean {
  return (
    input.focusOnRequest &&
    input.focusRequestId !== 0 &&
    input.focusRequestId !== input.handledFocusRequestId
  );
}

// A pending request means the terminal surface was not ready when the request
// was handled, so xterm becoming ready must hand focus to the terminal rather
// than steal it from the composer.
export function shouldFocusTerminalOnAttachFork(focusPending: boolean): boolean {
  return focusPending;
}
