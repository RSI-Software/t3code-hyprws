// Spike RSI-712: does the agent in a shared thread stay quiet only when people talk to each other?
export interface SharedThreadMessage {
  readonly from: "owner" | "collaborator";
  readonly text: string;
}

export interface SharedThreadCase {
  readonly id: string;
  readonly source: string;
  /** Sent in order; only the reply to the last one is graded. */
  readonly messages: ReadonlyArray<SharedThreadMessage>;
  readonly expect: "quiet" | "reply";
}

const smallTalk: ReadonlyArray<SharedThreadMessage> = [
  { from: "owner", text: "Alex, did you get a chance to look at the todo API yet?" },
  { from: "collaborator", text: "Yep, just opened it. It's tiny, should be quick." },
];

export const sharedThreadCases: ReadonlyArray<SharedThreadCase> = [
  {
    // Wrong on Haiku in the spike thread: addressed to a person, but asks for agent work.
    id: "relay-request",
    source: "RSI-712 spike thread, message 11",
    messages: [
      ...smallTalk,
      { from: "collaborator", text: "Jordan, can you get it to add a quick test for toggleTodo?" },
    ],
    expect: "reply",
  },
  {
    id: "control-people-only",
    source: "RSI-712 spike thread, message 4",
    messages: [
      ...smallTalk,
      { from: "collaborator", text: "Nice. Jordan, are we still doing the demo on Friday?" },
    ],
    expect: "quiet",
  },
  {
    id: "control-unnamed-ask",
    source: "RSI-712 spike thread, message 6",
    messages: [
      ...smallTalk,
      { from: "collaborator", text: "Can you also add a toggleTodo(list, index) that flips done?" },
    ],
    expect: "reply",
  },
];
