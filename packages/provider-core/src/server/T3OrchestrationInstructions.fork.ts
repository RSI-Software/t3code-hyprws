// Fork-owned delegated rounds guidance (RSI-Software/t3code-hyprws#1652),
// interpolated before the upstream review-round bullet. A fresh task stays the
// default; continuing is for rounds that need the child's own context.
export const DELEGATED_ROUNDS_INSTRUCTION_FORK =
  "- To keep one child's context across rounds (brief, findings, reply, ruling), call `delegate_task` with `continueTaskId` set to its `taskId` and only the new round's message as `task`. The same task reopens and its result wakes you like a new one; `task_status` and `task_cancel` follow the current round. Archive the child thread to release it. A fresh task stays the default for an independent second opinion.";
