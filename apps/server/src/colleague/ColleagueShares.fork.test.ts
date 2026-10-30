import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2Command,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { ensureForkSchema } from "../persistence/ForkSchema.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ColleagueShares from "./ColleagueShares.fork.ts";

const shared = ThreadId.make("shared");
const other = ThreadId.make("other");
const sharedProject = ProjectId.make("p-shared");
const otherProject = ProjectId.make("p-other");
const projectOf = { [shared]: sharedProject, [other]: otherProject } as Record<string, ProjectId>;
const pairedSubjects = new Set<string>();

const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId) =>
    Effect.succeed({
      id: threadId,
      projectId: projectOf[threadId],
      deletedAt: null,
    } as never as OrchestrationV2ThreadShell),
});
const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
  createPairingLink: () => Effect.succeed({ credential: "token" } as never),
  listSessions: () => Effect.succeed([...pairedSubjects].map((subject) => ({ subject }) as never)),
});
const config = Layer.succeed(ServerConfig.ServerConfig, {
  host: "127.0.0.1",
  port: 3773,
  privateNetworkOnly: false,
  devUrl: undefined,
} as never as ServerConfig.ServerConfig["Service"]);

const database = it.layer(
  Layer.mergeAll(
    NodeSqliteClient.layer({ filename: ":memory:" }),
    NodeCrypto.layer,
    threads,
    auth,
    config,
  ),
);
const withService = <A, E>(effect: Effect.Effect<A, E, ColleagueShares.ColleagueSharesFork>) =>
  Effect.andThen(ensureForkSchema(), Effect.provide(effect, ColleagueShares.layer));

const snapshot = () =>
  ({
    kind: "snapshot",
    snapshot: {
      threads: [shared, other].map((id) => ({ id, projectId: projectOf[id] })),
      archivedThreads: [],
      projects: [{ id: sharedProject }, { id: otherProject }],
    },
  }) as never as OrchestrationV2ShellStreamItem;
// Live shell events after each snapshot; the shell test supplies the queue.
const shellEvents: { queue?: Queue.Queue<OrchestrationV2ShellStreamItem> } = {};

const shellInputs: Array<object> = [];
const threadInputs: Array<number | undefined> = [];
const handlers = {
  "orchestration.dispatchCommand": (command: OrchestrationV2Command, _options: never) =>
    Effect.succeed(command),
  "orchestration.subscribeShell": (input: object, _options: never) => {
    shellInputs.push(input);
    return Stream.concat(
      Stream.make(snapshot()),
      shellEvents.queue ? Stream.fromQueue(shellEvents.queue) : Stream.empty,
    );
  },
  "orchestration.subscribeThread": (
    input: { readonly afterSequence?: number | undefined },
    _options: never,
  ) => {
    threadInputs.push(input.afterSequence);
    return Stream.concat(
      Stream.make({ kind: "event", sequence: 4 } as never as OrchestrationV2ThreadStreamItem),
      Stream.never,
    );
  },
};

const visibleThreads = (item: OrchestrationV2ShellStreamItem) =>
  item.kind === "snapshot" ? item.snapshot.threads.map((thread) => thread.id) : [];

const visibleProjects = (item: OrchestrationV2ShellStreamItem) =>
  item.kind === "snapshot" ? item.snapshot.projects.map(({ id }) => id) : [];

const message = (threadId: ThreadId, type = "message.dispatch", text = "hi") =>
  ({ type, threadId, text }) as never as OrchestrationV2Command;
const sentText = (command: OrchestrationV2Command) => ("text" in command ? command.text : "");

database("ColleagueSharesFork", (it) => {
  it.effect("narrows a colleague's shell live, from a fresh snapshot on every change", () =>
    withService(
      Effect.gen(function* () {
        const service = yield* ColleagueShares.ColleagueSharesFork;
        const wrapped = service.wrapHandlers("colleague:sam", handlers);
        const items = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
        shellEvents.queue = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
        const fiber = yield* wrapped["orchestration.subscribeShell"](
          { afterSequence: 7, omitIdleSubagents: true, omitOlderSettled: true },
          undefined as never,
        ).pipe(
          Stream.runForEach((item) => Queue.offer(items, item)),
          Effect.forkChild,
        );

        assert.deepStrictEqual(visibleThreads(yield* Queue.take(items)), []);
        yield* service.share({ threadId: shared, colleagueName: "Sam" });
        const afterShare = yield* Queue.take(items);
        assert.deepStrictEqual(visibleThreads(afterShare), [shared]);
        assert.deepStrictEqual(visibleProjects(afterShare), [sharedProject]);
        // A project metadata refresh carries no threads; it keeps the visible projects.
        yield* Queue.offer(shellEvents.queue, {
          ...snapshot(),
          snapshot: { threads: [], archivedThreads: [], projects: [{ id: sharedProject }] },
          resolvedRepositoryIdentityRoots: [],
        } as never);
        assert.deepStrictEqual(visibleProjects(yield* Queue.take(items)), [sharedProject]);
        // Moving the shared thread to a hidden project re-snapshots with that project.
        projectOf[shared] = otherProject;
        yield* Queue.offer(shellEvents.queue, {
          kind: "thread.updated",
          thread: { id: shared, projectId: otherProject },
        } as never);
        assert.deepStrictEqual(visibleProjects(yield* Queue.take(items)), [otherProject]);
        projectOf[shared] = sharedProject;
        yield* service.unshare({ threadId: shared, subject: "colleague:sam" });
        assert.deepStrictEqual(visibleThreads(yield* Queue.take(items)), []);
        assert.deepStrictEqual(shellInputs.map(Object.keys), [[], [], [], []]);
        yield* Fiber.interrupt(fiber);

        const owner = service.wrapHandlers("owner", handlers);
        assert.strictEqual(owner, handlers);
      }),
    ),
  );

  it.effect("limits a colleague to shared threads and names them in their messages", () =>
    withService(
      Effect.gen(function* () {
        const service = yield* ColleagueShares.ColleagueSharesFork;
        const result = yield* service.share({ threadId: shared, colleagueName: "Sam" });
        assert.isFalse(result.knownColleague);
        assert.strictEqual(new URL(result.pairingUrl).searchParams.get("thread"), shared);
        // Like ws.ts, assign the wrapped handlers back onto the object they wrap.
        const wrapped = { ...handlers };
        Object.assign(wrapped, service.wrapHandlers("colleague:sam", wrapped));
        const dispatch = wrapped["orchestration.dispatchCommand"];

        const attributed = "Message from colleague Sam:\n\nhi";
        assert.strictEqual(
          sentText(yield* dispatch(message(shared), undefined as never)),
          attributed,
        );
        for (const text of ["hi", attributed]) {
          const edit = message(shared, "queued-run.edit", text);
          assert.strictEqual(sentText(yield* dispatch(edit, undefined as never)), attributed);
        }
        const refused = yield* Effect.exit(dispatch(message(other), undefined as never));
        assert.isTrue(Exit.isFailure(refused));
        const live = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
        const open = yield* wrapped["orchestration.subscribeThread"](
          { threadId: shared } as never,
          undefined as never,
        ).pipe(
          Stream.runForEach((item) => Queue.offer(live, item)),
          Effect.forkChild,
        );
        yield* Queue.take(live);
        // Unsharing pauses the stream instead of failing it; a re-share resumes after sequence 4.
        yield* service.unshare({ threadId: shared, subject: "colleague:sam" });
        yield* service.share({ threadId: shared, colleagueName: "Sam" });
        yield* Queue.take(live);
        assert.deepStrictEqual(threadInputs, [undefined, 4]);
        yield* Fiber.interrupt(open);

        pairedSubjects.add("colleague:sam");
        const again = yield* service.share({ threadId: shared, colleagueName: "Sam" });
        assert.isTrue(again.knownColleague);
      }),
    ),
  );
});
