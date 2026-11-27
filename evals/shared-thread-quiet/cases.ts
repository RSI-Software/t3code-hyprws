// In a shared thread, does a line get an agent reply exactly when it is for the agent?
// Jordan owns the thread; Alex is the collaborator. Only the reply to the last message is graded.
export interface SharedThreadMessage {
  readonly from: "owner" | "collaborator";
  readonly text: string;
  /** History lines with a clear answer are graded too, as a secondary measure. */
  readonly expect?: "quiet" | "reply";
  /** Sent with "Ask the agent": the agent answers whoever it is to. */
  readonly forced?: true;
}

export type SharedThreadKind =
  | "unnamed-ask"
  | "it-or-you"
  | "relay"
  | "answers-agent"
  | "about-output"
  | "ambiguous"
  | "approval"
  | "control-work"
  | "control-people"
  | "forced";

export interface SharedThreadCase {
  readonly id: string;
  readonly kind: SharedThreadKind;
  readonly source: string;
  readonly messages: ReadonlyArray<SharedThreadMessage>;
  readonly expect: "quiet" | "reply";
  /** Why the expected answer is right, for ambiguous lines. */
  readonly why?: string;
}

const owner = (text: string, expect?: "quiet" | "reply"): SharedThreadMessage => ({
  from: "owner",
  text,
  ...(expect ? { expect } : {}),
});
const alex = (text: string, expect?: "quiet" | "reply"): SharedThreadMessage => ({
  from: "collaborator",
  text,
  ...(expect ? { expect } : {}),
});

const forced = (message: SharedThreadMessage): SharedThreadMessage => ({
  ...message,
  forced: true,
});

const smallTalk = [
  owner("Alex, did you get a chance to look at the todo API yet?", "quiet"),
  alex("Yep, just opened it. It's tiny, should be quick.", "quiet"),
];
// The agent has produced something the people can talk about. Edit tools are off in the eval.
const toggleWork = [
  owner(
    "Add a toggleTodo(list, index) to todos.js that flips done. Show the code in your reply.",
    "reply",
  ),
];
// The agent has just asked the room a question.
const priorityQuestion = [
  owner(
    "I want todos to have a priority. Don't write code yet: first ask us one question, whether priority should be (1) a number 1-3 or (2) a string low/medium/high, then wait.",
    "reply",
  ),
];
const planQuestion = [
  owner(
    "Before you write anything, propose a short plan for adding due dates to todos and ask us if it's OK.",
    "reply",
  ),
];

const BRIEF = "RSI-714 brief";

export const sharedThreadCases: ReadonlyArray<SharedThreadCase> = [
  // Unnamed or implicit asks.
  {
    id: "control-unnamed-ask",
    kind: "unnamed-ask",
    source: "RSI-712 spike thread, message 6",
    messages: [...smallTalk, alex("Can you also add a toggleTodo(list, index) that flips done?")],
    expect: "reply",
  },
  {
    id: "unnamed-should",
    kind: "unnamed-ask",
    source: `${BRIEF}: unnamed or implicit asks`,
    messages: [...smallTalk, alex("addTodo should probably trim the title.")],
    expect: "reply",
  },
  {
    id: "unnamed-lets",
    kind: "unnamed-ask",
    source: `${BRIEF}: unnamed or implicit asks`,
    messages: [...smallTalk, owner("Let's add a removeTodo too.")],
    expect: "reply",
  },
  {
    id: "unnamed-code-question",
    kind: "unnamed-ask",
    source: `${BRIEF}: unnamed or implicit asks`,
    messages: [...smallTalk, alex("What happens if the title is empty?")],
    expect: "reply",
  },
  {
    id: "unnamed-imperative",
    kind: "unnamed-ask",
    source: `${BRIEF}: unnamed or implicit asks`,
    messages: [...smallTalk, alex("Rename addTodo to createTodo.")],
    expect: "reply",
  },
  {
    id: "unnamed-need",
    kind: "unnamed-ask",
    source: `${BRIEF}: unnamed or implicit asks`,
    messages: [...smallTalk, owner("We need a way to count the done todos.")],
    expect: "reply",
  },
  // "it" or "you" with no name.
  {
    id: "you-explain",
    kind: "it-or-you",
    source: `${BRIEF}: "you" with no name`,
    messages: [...smallTalk, alex("Could you explain what the spread in addTodo is doing?")],
    expect: "reply",
  },
  {
    id: "you-still-there",
    kind: "it-or-you",
    source: `${BRIEF}: "you" with no name`,
    messages: [...smallTalk, alex("you still there? check whether addTodo mutates the list")],
    expect: "reply",
  },
  {
    id: "it-missed-case",
    kind: "it-or-you",
    source: `${BRIEF}: "it" with no name`,
    messages: [...toggleWork, alex("It doesn't handle an out-of-range index though.")],
    expect: "reply",
  },
  {
    id: "it-also",
    kind: "it-or-you",
    source: `${BRIEF}: "it" with no name`,
    messages: [...toggleWork, owner("It should return the same list when the index is invalid.")],
    expect: "reply",
  },
  // Requests relayed through a person.
  {
    id: "relay-request",
    kind: "relay",
    source: "RSI-712 spike thread, message 11",
    messages: [...smallTalk, alex("Jordan, can you get it to add a quick test for toggleTodo?")],
    expect: "reply",
  },
  {
    id: "relay-ask-it",
    kind: "relay",
    source: `${BRIEF}: relayed requests`,
    messages: [...smallTalk, alex("Jordan, ask it to add a JSDoc comment to addTodo.")],
    expect: "reply",
  },
  {
    id: "relay-have-the-agent",
    kind: "relay",
    source: `${BRIEF}: relayed requests`,
    messages: [...smallTalk, alex("Jordan, maybe have the agent check whether addTodo is pure?")],
    expect: "reply",
  },
  {
    id: "relay-the-bot",
    kind: "relay",
    source: `${BRIEF}: relayed requests`,
    messages: [...smallTalk, alex("Jordan, could we get the bot to write a usage example?")],
    expect: "reply",
  },
  {
    id: "relay-owner-passes-on",
    kind: "relay",
    source: `${BRIEF}: relayed requests`,
    messages: [...smallTalk, owner("Alex wants a toggleTodo as well, so let's get that in.")],
    expect: "reply",
  },
  {
    id: "relay-can-it-tell",
    kind: "relay",
    source: `${BRIEF}: relayed requests`,
    messages: [...smallTalk, alex("Jordan, can it tell us what addTodo returns for a null list?")],
    expect: "reply",
  },
  // Replies to a question the agent just asked.
  {
    id: "answers-option",
    kind: "answers-agent",
    source: `${BRIEF}: replies to the agent's question`,
    messages: [...priorityQuestion, owner("yes, option 2")],
    expect: "reply",
  },
  {
    id: "answers-number",
    kind: "answers-agent",
    source: `${BRIEF}: replies to the agent's question`,
    messages: [...priorityQuestion, alex("2")],
    expect: "reply",
  },
  {
    id: "answers-after-people",
    kind: "answers-agent",
    source: `${BRIEF}: replies to the agent's question`,
    messages: [...priorityQuestion, alex("I like 2. Jordan?"), owner("agreed, go with 2")],
    expect: "reply",
  },
  {
    id: "answers-sounds-good",
    kind: "answers-agent",
    source: `${BRIEF}: replies to the agent's question`,
    messages: [...planQuestion, alex("sounds good")],
    expect: "reply",
  },
  {
    id: "answers-go-ahead",
    kind: "answers-agent",
    source: `${BRIEF}: replies to the agent's question`,
    messages: [...planQuestion, owner("go ahead")],
    expect: "reply",
  },
  // People discussing what the agent produced.
  {
    id: "about-output-praise",
    kind: "about-output",
    source: `${BRIEF}: people discussing the agent's output`,
    messages: [...toggleWork, alex("Nice, that's cleaner than what I had.")],
    expect: "quiet",
  },
  {
    id: "about-output-opinion",
    kind: "about-output",
    source: `${BRIEF}: people discussing the agent's output`,
    messages: [...toggleWork, alex("Jordan, is that readable enough for the new folks?")],
    expect: "quiet",
  },
  {
    id: "about-output-later",
    kind: "about-output",
    source: `${BRIEF}: people discussing the agent's output`,
    messages: [
      ...toggleWork,
      owner("Let's leave that for now and review it properly tomorrow, Alex."),
    ],
    expect: "quiet",
  },
  {
    id: "about-output-names-agent",
    kind: "about-output",
    source: `${BRIEF}: people discussing the agent's output`,
    messages: [...toggleWork, alex("The agent did a decent job on this one.")],
    expect: "quiet",
    why: "Names the agent but asks nothing of it; RSI-712's rule said a name alone means reply.",
  },
  // Ambiguous lines, with the answer stated.
  {
    id: "ambiguous-not-sure-name",
    kind: "ambiguous",
    source: `${BRIEF}: ambiguous lines`,
    messages: [...toggleWork, alex("hmm, not sure about that name")],
    expect: "reply",
    why: "Doubts the agent's work; offering two names costs one short reply.",
  },
  {
    id: "ambiguous-wonder",
    kind: "ambiguous",
    source: `${BRIEF}: ambiguous lines`,
    messages: [...toggleWork, alex("I wonder if done even needs to be a boolean.")],
    expect: "reply",
    why: "An open design question about the code the agent can answer.",
  },
  {
    id: "ambiguous-ok",
    kind: "ambiguous",
    source: `${BRIEF}: ambiguous lines`,
    messages: [...toggleWork, owner("ok")],
    expect: "quiet",
    why: "Acknowledges finished work; the agent asked nothing.",
  },
  {
    id: "ambiguous-thanks",
    kind: "ambiguous",
    source: `${BRIEF}: ambiguous lines`,
    messages: [...toggleWork, alex("thanks!")],
    expect: "quiet",
    why: "Thanks asks nothing; a 'you're welcome' is noise in a shared thread.",
  },
  {
    id: "ambiguous-someday",
    kind: "ambiguous",
    source: `${BRIEF}: ambiguous lines`,
    messages: [...toggleWork, owner("We should add tests at some point, Alex.")],
    expect: "quiet",
    why: "A plan between people, addressed to Alex, for later.",
  },
  // A collaborator who needs approval: the host sent each line on (RSI-625 approval flow).
  {
    id: "approval-ask",
    kind: "approval",
    source: `${BRIEF}: a collaborator who needs approval; RSI-625`,
    messages: [...smallTalk, alex("Can you make addTodo reject an empty title?")],
    expect: "reply",
  },
  {
    id: "approval-people",
    kind: "approval",
    source: `${BRIEF}: a collaborator who needs approval; RSI-625`,
    messages: [...smallTalk, alex("Jordan, no rush approving these, I'm off to a meeting.")],
    expect: "quiet",
  },
  // Controls: ordinary work.
  {
    id: "control-owner-work",
    kind: "control-work",
    source: `${BRIEF}: control, ordinary work`,
    messages: [...smallTalk, owner("Add a removeTodo(list, index) that returns a new list.")],
    expect: "reply",
  },
  // Controls: people only talking to each other.
  {
    id: "control-people-only",
    kind: "control-people",
    source: "RSI-712 spike thread, message 4",
    messages: [...smallTalk, alex("Nice. Jordan, are we still doing the demo on Friday?")],
    expect: "quiet",
  },
  {
    id: "control-lunch",
    kind: "control-people",
    source: `${BRIEF}: control, people only`,
    messages: [...smallTalk, alex("brb, grabbing lunch")],
    expect: "quiet",
  },
  {
    id: "control-person-task",
    kind: "control-people",
    source: `${BRIEF}: control, people only`,
    messages: [...smallTalk, owner("Alex, can you send me the staging URL later?")],
    expect: "quiet",
  },
  {
    id: "control-agreement",
    kind: "control-people",
    source: `${BRIEF}: control, people only`,
    messages: [...smallTalk, alex("Friday demo still on?", "quiet"), owner("Yep, Friday works.")],
    expect: "quiet",
  },
  {
    id: "control-standup",
    kind: "control-people",
    source: `${BRIEF}: control, people only`,
    messages: [...smallTalk, alex("Who's joining standup tomorrow?")],
    expect: "quiet",
  },
  {
    id: "control-thanks-person",
    kind: "control-people",
    source: `${BRIEF}: control, people only`,
    messages: [...smallTalk, owner("Thanks Alex, appreciate you looking.")],
    expect: "quiet",
  },
  {
    id: "control-preference",
    kind: "control-people",
    source: `${BRIEF}: control, people only`,
    messages: [...smallTalk, owner("Alex, tabs or spaces? Just curious.")],
    expect: "quiet",
  },
  // "Ask the agent": a people line the agent must answer, and the next line judged again.
  {
    id: "forced-to-person",
    kind: "forced",
    source: "RSI-802",
    messages: [...smallTalk, forced(alex("Jordan, are we still doing the demo on Friday?"))],
    expect: "reply",
  },
  {
    id: "forced-thanks",
    kind: "forced",
    source: "RSI-802",
    messages: [...smallTalk, forced(owner("Thanks Alex, appreciate you looking."))],
    expect: "reply",
  },
  {
    id: "forced-then-normal",
    kind: "forced",
    source: "RSI-802",
    messages: [
      ...smallTalk,
      forced(alex("Jordan, tabs or spaces? Just curious.", "reply")),
      alex("brb, grabbing lunch"),
    ],
    expect: "quiet",
  },
];
