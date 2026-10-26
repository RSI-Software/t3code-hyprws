import {
  VoiceInputConfigFork,
  VoiceInputConfigUpdateFork,
  VoiceInputTranscriptFork,
  type VoiceInputSettingsFork,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Socket from "effect/socket/Socket";
import type * as Scope from "effect/Scope";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as VoiceText from "./VoiceText.fork.ts";
import { isVoiceRecordingFork } from "./recording.fork.ts";
import { metaVoiceRequestFork, metaVoiceStreamFork, metaVoiceTranscriptFork } from "./meta.fork.ts";
import { openAiVoiceStreamFork } from "./openaiRealtime.fork.ts";
import { relayVoiceStreamFork } from "./realtime.fork.ts";

export class VoiceInputError extends Schema.TaggedError<VoiceInputError>()("VoiceInputError", {
  reason: Schema.Literals([
    "settings",
    "storage",
    "disabled",
    "live",
    "audio",
    "upstream",
    "response",
  ]),
  status: Schema.optionalKey(Schema.Number),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "settings":
        return "Check the dictation base URL and model.";
      case "storage":
        return "Could not load or save dictation settings.";
      case "disabled":
        return "Enable dictation in Settings first.";
      case "live":
        return "Live preview is off for this speech service.";
      case "audio":
        return "Use a mono PCM16 WAV recording at 16 or 24 kHz, up to five minutes.";
      case "upstream":
        return this.status
          ? `Dictation provider returned HTTP ${this.status}.`
          : "Could not reach the dictation provider.";
      case "response":
        return "The dictation provider returned an invalid transcript.";
    }
  }
}

const StoredSettings = Schema.Struct({ ...VoiceInputConfigFork.fields, apiKey: Schema.String });
/** Legacy providers whose wire this service still speaks. */
const OPENAI_SHAPED_LEGACY = new Set([
  "meta",
  "openai-compatible",
  "openai",
  "groq",
  "mistral",
  "promptletariat",
]);
/** Settings saved with full upload and socket URLs; read once so the saved key survives. */
const LegacySettings = Schema.Struct({
  enabled: Schema.Boolean,
  provider: Schema.String,
  endpoint: Schema.String,
  streamingEndpoint: Schema.optionalKey(Schema.String),
  model: Schema.String,
  apiKey: Schema.String,
});
const codec = Schema.fromJsonString(StoredSettings);
const decodeStoredSettings = (encoded: string) =>
  Schema.decodeEffect(codec)(encoded).pipe(
    Effect.catch(() =>
      Schema.decodeEffect(Schema.fromJsonString(LegacySettings))(encoded).pipe(
        Effect.map(({ endpoint, streamingEndpoint, ...legacy }) => {
          const provider = legacy.provider === "meta" ? "meta" : "openai-compatible";
          const baseUrl = apiRootFork(
            endpoint.trim().replace(/\/(audio\/transcriptions|asr\/transcribe)\/*$/, ""),
          );
          return {
            ...legacy,
            provider,
            baseUrl: baseUrl ?? endpoint.trim(),
            // Local HTTP and unknown wires, or URLs with parameters, need reconfiguring.
            enabled:
              legacy.enabled && baseUrl !== null && OPENAI_SHAPED_LEGACY.has(legacy.provider),
            // Meta settings from before streaming URLs were always live.
            live: streamingEndpoint === undefined ? provider === "meta" : streamingEndpoint !== "",
            extensions: false,
          } as const;
        }),
      ),
    ),
  );
const decodeConfigUpdate = Schema.decodeEffect(VoiceInputConfigUpdateFork);
const SECRET_NAME = "fork-voice-input";
const defaults = {
  enabled: false,
  provider: "meta",
  baseUrl: "https://api.meta.ai/v1",
  live: true,
  model: "muse-voice-transcribe-1.0",
  extensions: false,
  apiKey: "",
} as const;

/** Each wire's upload and realtime paths below one API root. */
function voiceInputUrlsFork(config: Pick<VoiceInputConfigFork, "provider" | "baseUrl">) {
  const base = config.baseUrl.replace(/\/+$/, "");
  const [upload, realtime] =
    config.provider === "meta"
      ? ["/asr/transcribe", "/asr/realtime"]
      : ["/audio/transcriptions", "/realtime?intent=transcription"];
  return { upload: base + upload, realtime: base.replace(/^http/, "ws") + realtime };
}

/**
 * Project terms as transcription hints: the standard `prompt` always, and Promptletariat's
 * `keywords` and `custom_spelling` when extensions are on. Lines are `term` or `heard, misheard -> Term`.
 * Hints past Promptletariat's limits are dropped, never refused, so dictation keeps working.
 */
function voiceVocabularyFork(terms: string, extensions: boolean): VoiceVocabularyFork {
  const canonical = new Set<string>();
  const spelling: Array<{ from: Array<string>; to: string }> = [];
  let sources = 0;
  for (const line of terms.split("\n")) {
    const [heard, term = heard] = line.split("->").map((part) => part.trim());
    if (!term) continue;
    canonical.add(term);
    const from = heard === term ? [] : (heard ?? "").split(",").flatMap((p) => p.trim() || []);
    if (from.length > 0 && sources + from.length <= 256) {
      sources += from.length;
      spelling.push({ from, to: term });
    }
  }
  if (canonical.size === 0) return {};
  // Keywords are decoder hotwords: no angle brackets or NUL, 100 phrases of 128 characters,
  // and an 8 KiB encoded query.
  const keywords: Array<string> = [];
  for (const term of canonical) {
    if (keywords.length === 100) break;
    const keyword = term
      .replace(/[<>\0]/g, "")
      .trim()
      .slice(0, 128);
    if (
      keyword &&
      !keywords.includes(keyword) &&
      hotwordQueryLength([...keywords, keyword]) <= 8192
    )
      keywords.push(keyword);
  }
  return {
    prompt: [...canonical].join(", ").slice(0, 4096),
    ...(extensions && keywords.length > 0 ? { keywords } : {}),
    ...(extensions && spelling.length > 0 ? { custom_spelling: spelling } : {}),
  };
}
const hotwordQueryLength = (words: ReadonlyArray<string>) =>
  new URLSearchParams(words.map((word): [string, string] => ["hotword", word])).toString().length;
export interface VoiceVocabularyFork {
  readonly prompt?: string;
  readonly keywords?: ReadonlyArray<string>;
  readonly custom_spelling?: typeof CustomSpelling.Type;
}
const CustomSpelling = Schema.Array(
  Schema.Struct({ from: Schema.Array(Schema.String), to: Schema.String }),
);
const encodeCustomSpelling = Schema.encodeSync(Schema.fromJsonString(CustomSpelling));

export class VoiceInput extends Context.Service<
  VoiceInput,
  {
    readonly settings: Effect.Effect<VoiceInputSettingsFork, VoiceInputError>;
    readonly configure: (
      input: VoiceInputConfigUpdateFork,
    ) => Effect.Effect<VoiceInputSettingsFork, VoiceInputError>;
    /** `projectId` selects the dictating project's speech terms; the defaults' otherwise. */
    readonly transcribe: (
      audio: Uint8Array,
      projectId?: string,
    ) => Effect.Effect<string, VoiceInputError>;
    readonly stream: (
      socket: Socket.Socket,
      projectId?: string,
    ) => Effect.Effect<void, VoiceInputError, Scope.Scope | Socket.WebSocketConstructor>;
  }
>()("t3/voice-input/VoiceInput.fork/VoiceInput") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const client = yield* HttpClient.HttpClient;
  const text = yield* VoiceText.VoiceText;
  const writes = yield* Semaphore.make(1);
  const projectTerms = (projectId: string | undefined) =>
    text.settings.pipe(
      Effect.map(
        ({ projects, defaults }) => ((projectId && projects[projectId]) || defaults).terms,
      ),
      // Terms only steer recognition; dictation still works without them.
      Effect.orElseSucceed(() => ""),
    );

  const read = secrets.get(SECRET_NAME).pipe(
    Effect.mapError((cause) => new VoiceInputError({ reason: "storage", cause })),
    Effect.flatMap((stored) =>
      Option.isNone(stored)
        ? Effect.succeed(defaults)
        : decodeStoredSettings(new TextDecoder().decode(stored.value)).pipe(
            Effect.mapError((cause) => new VoiceInputError({ reason: "storage", cause })),
          ),
    ),
  );
  const publicSettings = ({
    apiKey,
    ...settings
  }: VoiceInputConfigFork & { apiKey: string }): VoiceInputSettingsFork => ({
    ...settings,
    hasApiKey: apiKey.length > 0,
  });
  const configure = Effect.fn("VoiceInput.configure")(function* (
    input: VoiceInputConfigUpdateFork,
  ) {
    const config = yield* decodeConfigUpdate(input).pipe(
      Effect.mapError((cause) => new VoiceInputError({ reason: "settings", cause })),
    );
    const baseUrl = apiRootFork(config.baseUrl.trim());
    const model = config.model.trim();
    if (baseUrl === null || !model) return yield* new VoiceInputError({ reason: "settings" });
    const previous = yield* read;
    const apiKey =
      config.apiKey?.trim() ??
      (config.provider === previous.provider && baseUrl === previous.baseUrl
        ? previous.apiKey
        : "");
    const saved = {
      enabled: config.enabled,
      provider: config.provider,
      baseUrl,
      live: config.live,
      model,
      extensions: config.extensions,
      apiKey,
    };
    const encoded = yield* Schema.encodeEffect(codec)(saved).pipe(
      Effect.mapError((cause) => new VoiceInputError({ reason: "storage", cause })),
    );
    yield* secrets
      .set(SECRET_NAME, new TextEncoder().encode(encoded))
      .pipe(Effect.mapError((cause) => new VoiceInputError({ reason: "storage", cause })));
    return publicSettings(saved);
  });

  const transcribe = Effect.fn("VoiceInput.transcribe")(function* (
    audio: Uint8Array,
    projectId: string | undefined,
  ) {
    const config = yield* read;
    if (!config.enabled) return yield* new VoiceInputError({ reason: "disabled" });
    if (!isVoiceRecordingFork(audio)) return yield* new VoiceInputError({ reason: "audio" });
    const { upload } = voiceInputUrlsFork(config);
    let request: HttpClientRequest.HttpClientRequest;
    if (config.provider === "meta") {
      request = metaVoiceRequestFork(upload, config.model, audio);
    } else {
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "dictation.wav");
      form.set("model", config.model);
      form.set("response_format", "json");
      const {
        prompt,
        keywords = [],
        custom_spelling,
      } = voiceVocabularyFork(yield* projectTerms(projectId), config.extensions);
      if (prompt) form.set("prompt", prompt);
      for (const keyword of keywords) form.append("keywords[]", keyword);
      if (custom_spelling) form.set("custom_spelling", encodeCustomSpelling(custom_spelling));
      request = HttpClientRequest.post(upload).pipe(HttpClientRequest.bodyFormData(form));
    }
    if (config.apiKey)
      request = HttpClientRequest.setHeader(request, "authorization", `Bearer ${config.apiKey}`);
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError((cause) => new VoiceInputError({ reason: "upstream", cause })));
    if (response.status < 200 || response.status >= 300) {
      return yield* new VoiceInputError({ reason: "upstream", status: response.status });
    }
    const text = yield* (
      config.provider === "meta"
        ? metaVoiceTranscriptFork(response)
        : HttpClientResponse.schemaBodyJson(VoiceInputTranscriptFork)(response).pipe(
            Effect.map((body) => body.text),
          )
    ).pipe(Effect.mapError((cause) => new VoiceInputError({ reason: "response", cause })));
    return text.trim();
  });
  return VoiceInput.of({
    settings: read.pipe(Effect.map(publicSettings)),
    configure: (input) => writes.withPermits(1)(configure(input)),
    stream: Effect.fn("VoiceInput.stream")(
      function* (socket, projectId) {
        const config = yield* read;
        if (!config.enabled) return yield* new VoiceInputError({ reason: "disabled" });
        if (!config.live) return yield* new VoiceInputError({ reason: "live" });
        const adapter =
          config.provider === "meta"
            ? metaVoiceStreamFork(config)
            : openAiVoiceStreamFork(
                config,
                voiceVocabularyFork(yield* projectTerms(projectId), config.extensions),
              );
        const upstream = yield* Socket.makeWebSocket(voiceInputUrlsFork(config).realtime, {
          openTimeout: "10 seconds",
          ...(adapter.headers ? { headers: adapter.headers } : {}),
        });
        yield* relayVoiceStreamFork(socket, upstream, adapter);
      },
      Effect.mapError((cause) =>
        isVoiceInputError(cause) ? cause : new VoiceInputError({ reason: "upstream", cause }),
      ),
    ),
    transcribe: (audio, projectId) =>
      transcribe(audio, projectId).pipe(
        Effect.timeout("60 seconds"),
        Effect.mapError((cause) =>
          cause._tag === "TimeoutError"
            ? new VoiceInputError({ reason: "upstream", cause })
            : cause,
        ),
      ),
  });
});

export const layer = Layer.effect(VoiceInput, make);
const isVoiceInputError = Schema.is(VoiceInputError);

/** The canonical API root, or null for one paths cannot be appended to. */
function apiRootFork(value: string) {
  try {
    const url = new URL(value);
    // URL drops a bare trailing ? or #, so check the raw text.
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !/[?#]/.test(value)
      ? url.origin + url.pathname.replace(/\/+$/, "")
      : null;
  } catch {
    return null;
  }
}
