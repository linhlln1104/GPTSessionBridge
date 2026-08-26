import type { WebModelDescriptor } from "@gpt-session-bridge/protocol";

import {
  PAGE_DEFAULT_REASONING_EFFORT,
  type PageFailureCode,
  type PageTurnStartMessage,
} from "../protocol/page-messages.js";

const MAX_CATALOG_MODELS = 128;
const MAX_SEMANTIC_KEY_CHARACTERS = 512;
const MODEL_ID_PREFIX = "ui-";
const REASONING_DESCRIPTION =
  "Compatibility label only; it does not control ChatGPT Web reasoning, which remains UI-defined.";

export interface ObservedModelOption {
  /** User-visible, semantic accessible name. */
  readonly displayName: string;
  /** Selection state exposed by the semantic radio/option contract. */
  readonly selected: boolean;
  /** Stable semantic path in the currently observed picker, never a page-internal identifier. */
  readonly semanticKey: string;
}

export interface ChatGptUiTurnObserver {
  completed(): void;
  failed(): void;
  outputText(text: string): void;
  started(): void;
  cancelled(): void;
}

export interface ChatGptUiTurnPreparation {
  acceptModelOptions(options: readonly ObservedModelOption[]): boolean;
  onSubmitting(): void;
  shouldSubmit(): boolean;
}

export type ChatGptUiTurnStartOutcome = "cancelled-before-submit" | "submitted";

/** DOM-facing capability kept narrow enough to fake without a real ChatGPT account. */
export interface ChatGptUiDriver {
  cancelTextTurn(): Promise<boolean>;
  discoverModelOptions(): Promise<readonly ObservedModelOption[]>;
  dispose(): void;
  observeModelOptions(listener: (options: readonly ObservedModelOption[]) => void): () => void;
  /** Selects through visible UI. The final start path independently verifies the picker again. */
  selectModel(semanticKey: string): Promise<boolean>;
  /** Final picker verification and Send happen in one continuation without an intervening await. */
  startTextTurn(
    prompt: string,
    semanticKey: string,
    preparation: ChatGptUiTurnPreparation,
    observer: ChatGptUiTurnObserver,
  ): Promise<ChatGptUiTurnStartOutcome>;
}

export interface ChatGptDomAdapterSink {
  completed(turnId: string): void;
  failed(turnId: string, failure: AdapterFailure): void;
  outputText(turnId: string, delta: string): void;
  started(turnId: string): void;
  cancelled(turnId: string): void;
}

export interface AdapterCatalog {
  readonly catalogRevision: string;
  readonly models: readonly WebModelDescriptor[];
}

export interface AdapterFailure {
  readonly code: PageFailureCode;
  readonly message: string;
  readonly retryable: boolean;
}

interface CatalogEntry {
  readonly descriptor: WebModelDescriptor;
  readonly selected: boolean;
  readonly semanticKey: string;
}

interface InternalCatalog extends AdapterCatalog {
  readonly entries: ReadonlyMap<string, CatalogEntry>;
  readonly semanticSnapshot: string;
}

interface NormalizedObservedOption {
  readonly canonicalSemanticKey: string;
  readonly displayName: string;
  readonly selected: boolean;
  readonly semanticKey: string;
}

interface ActiveAdapterTurn {
  cancelRequested: boolean;
  readonly sink: ChatGptDomAdapterSink;
  stage: "preparing" | "submitted";
  readonly turnId: string;
}

export interface ChatGptDomAdapterOptions {
  readonly digest?: (value: string) => Promise<string>;
  readonly driver: ChatGptUiDriver;
}

export class ChatGptDomAdapterError extends Error {
  public readonly failure: AdapterFailure;

  public constructor(failure: AdapterFailure) {
    super(failure.message);
    this.failure = Object.freeze({ ...failure });
    this.name = "ChatGptDomAdapterError";
  }
}

/**
 * Coordinates a single text-only turn through the narrow semantic UI driver.
 */
export class ChatGptDomAdapter {
  readonly #digest: (value: string) => Promise<string>;
  readonly #driver: ChatGptUiDriver;
  #activeTurn: ActiveAdapterTurn | undefined;
  #catalogListener: ((catalog: AdapterCatalog) => void) | undefined;
  #catalogObservation: Promise<void> = Promise.resolve();
  #disposed = false;
  #lastCatalogRevision: string | undefined;
  readonly #stopModelObservation: () => void;

  public constructor(options: ChatGptDomAdapterOptions) {
    this.#driver = options.driver;
    this.#digest = options.digest ?? sha256Hex;
    this.#stopModelObservation = this.#driver.observeModelOptions((observed) => {
      this.#catalogObservation = this.#catalogObservation
        .catch(() => undefined)
        .then(async () => {
          if (this.#disposed) {
            return;
          }
          const catalog = await buildCatalog(observed, this.#digest);
          this.#installCatalog(catalog);
        });
      void this.#catalogObservation.catch(() => undefined);
    });
  }

  public async discoverCatalog(): Promise<AdapterCatalog> {
    this.#assertAvailable();
    const catalog = await this.#readCatalog();
    return Object.freeze({
      catalogRevision: catalog.catalogRevision,
      models: catalog.models,
    });
  }

  public onCatalogChanged(listener: (catalog: AdapterCatalog) => void): () => void {
    if (this.#catalogListener !== undefined || this.#disposed) {
      throw adapterError("adapter_unavailable", "The catalog observer is unavailable.", false);
    }
    this.#catalogListener = listener;
    return () => {
      if (this.#catalogListener === listener) {
        this.#catalogListener = undefined;
      }
    };
  }

  public async startTurn(
    command: PageTurnStartMessage,
    sink: ChatGptDomAdapterSink,
  ): Promise<void> {
    this.#assertAvailable();
    if (this.#activeTurn !== undefined) {
      throw adapterError("turn_already_active", "A ChatGPT Web turn is already active.", false);
    }
    if (command.reasoningEffort !== PAGE_DEFAULT_REASONING_EFFORT) {
      throw adapterError("unsupported", "The requested Web turn option is unsupported.", false);
    }
    if (command.input.length !== 1) {
      throw adapterError(
        "unsupported",
        "Exactly one text input is required for a Web turn.",
        false,
      );
    }

    const turnId = command.turnId;
    // Reserve before the first await so concurrent commands cannot both pass
    // the single-turn guard while model discovery is in flight.
    const active: ActiveAdapterTurn = {
      cancelRequested: false,
      sink,
      stage: "preparing",
      turnId,
    };
    this.#activeTurn = active;
    try {
      const catalog = await this.#readCatalog();
      if (this.#finishPreSubmitCancellation(active)) {
        return;
      }
      if (catalog.catalogRevision !== command.catalogRevision) {
        throw adapterError(
          "browser_state_changed",
          "The ChatGPT Web model catalog changed. Refresh the model list and retry.",
          true,
        );
      }
      const entry = catalog.entries.get(command.modelId);
      if (entry === undefined) {
        throw adapterError(
          "model_unavailable",
          "The selected ChatGPT Web model is no longer available.",
          true,
        );
      }
      const input = command.input[0];
      if (input === undefined) {
        throw adapterError(
          "unsupported",
          "Exactly one text input is required for a Web turn.",
          false,
        );
      }
      const prompt = input.text;
      if (!(await this.#driver.selectModel(entry.semanticKey))) {
        throw adapterError(
          "model_unavailable",
          "The selected ChatGPT Web model could not be confirmed in the picker.",
          true,
        );
      }
      if (this.#finishPreSubmitCancellation(active)) {
        return;
      }
      const outcome = await this.#driver.startTextTurn(
        prompt,
        entry.semanticKey,
        {
          acceptModelOptions: (options) => {
            try {
              const normalized = normalizeObservedCatalog(options);
              return (
                semanticSnapshot(normalized) === catalog.semanticSnapshot &&
                normalized.find((option) => option.selected)?.semanticKey === entry.semanticKey
              );
            } catch {
              return false;
            }
          },
          onSubmitting: () => {
            active.stage = "submitted";
          },
          shouldSubmit: () => !active.cancelRequested,
        },
        {
          cancelled: () => {
            if (this.#finish(active)) {
              sink.cancelled(turnId);
            }
          },
          completed: () => {
            if (this.#finish(active)) {
              sink.completed(turnId);
            }
          },
          failed: () => {
            if (this.#finish(active)) {
              sink.failed(
                turnId,
                Object.freeze({
                  code: "browser_state_changed",
                  message: "ChatGPT Web changed after the turn was submitted.",
                  retryable: false,
                }),
              );
            }
          },
          outputText: (delta) => {
            if (this.#activeTurn === active && delta.length > 0) {
              sink.outputText(turnId, delta);
            }
          },
          started: () => {
            if (this.#activeTurn === active) {
              sink.started(turnId);
            }
          },
        },
      );
      if (outcome === "cancelled-before-submit" && this.#finish(active)) {
        sink.cancelled(turnId);
      }
    } catch (error) {
      // A terminal observer callback may have won the race with a rejecting
      // driver promise. Never publish a second terminal event in that case.
      if (this.#activeTurn !== active) {
        return;
      }
      if (active.cancelRequested && active.stage === "preparing") {
        this.#activeTurn = undefined;
        sink.cancelled(turnId);
        return;
      }
      this.#finish(active);
      if (error instanceof ChatGptDomAdapterError) {
        throw error;
      }
      if (active.stage === "preparing") {
        throw adapterError(
          "browser_state_changed",
          "ChatGPT Web changed before the text turn was submitted.",
          true,
        );
      }
      throw adapterError(
        "browser_state_changed",
        "ChatGPT Web could not confirm the submitted text turn.",
        false,
      );
    }
  }

  public async cancelTurn(turnId: string): Promise<void> {
    this.#assertAvailable();
    const active = this.#activeTurn;
    if (active?.turnId !== turnId || active.cancelRequested) {
      throw adapterError("turn_not_found", "The requested Web turn is not active.", false);
    }
    active.cancelRequested = true;
    if (active.stage === "preparing") {
      return;
    }

    let accepted = false;
    try {
      accepted = await this.#driver.cancelTextTurn();
    } catch {
      // Normalize DOM-specific diagnostics at the adapter boundary.
    }
    if (this.#activeTurn !== active) {
      return;
    }
    if (!accepted) {
      active.cancelRequested = false;
      throw adapterError(
        "browser_state_changed",
        "ChatGPT Web did not expose a confirmed stop control.",
        true,
      );
    }
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#activeTurn = undefined;
    this.#catalogListener = undefined;
    this.#stopModelObservation();
    this.#driver.dispose();
  }

  async #readCatalog(): Promise<InternalCatalog> {
    let observed: readonly ObservedModelOption[];
    try {
      observed = await this.#driver.discoverModelOptions();
    } catch {
      throw adapterError(
        "adapter_unavailable",
        "A verified ChatGPT Web model picker is unavailable.",
        true,
      );
    }
    const catalog = await buildCatalog(observed, this.#digest);
    this.#installCatalog(catalog);
    return catalog;
  }

  #installCatalog(catalog: InternalCatalog): void {
    const previous = this.#lastCatalogRevision;
    this.#lastCatalogRevision = catalog.catalogRevision;
    if (previous !== undefined && previous !== catalog.catalogRevision) {
      this.#catalogListener?.(
        Object.freeze({
          catalogRevision: catalog.catalogRevision,
          models: catalog.models,
        }),
      );
    }
  }

  #finish(active: ActiveAdapterTurn): boolean {
    if (this.#activeTurn !== active) {
      return false;
    }
    this.#activeTurn = undefined;
    return true;
  }

  #finishPreSubmitCancellation(active: ActiveAdapterTurn): boolean {
    if (!active.cancelRequested) {
      this.#assertAvailable();
      if (this.#activeTurn !== active) {
        throw adapterError("adapter_unavailable", "The page adapter is closed.", true);
      }
      return false;
    }
    if (this.#finish(active)) {
      active.sink.cancelled(active.turnId);
    }
    return true;
  }

  #assertAvailable(): void {
    if (this.#disposed) {
      throw adapterError("adapter_unavailable", "The page adapter is closed.", true);
    }
  }
}

export async function buildCatalog(
  observed: readonly ObservedModelOption[],
  digest: (value: string) => Promise<string> = sha256Hex,
): Promise<InternalCatalog> {
  const normalized = normalizeObservedCatalog(observed);

  const entries = new Map<string, CatalogEntry>();
  const models: WebModelDescriptor[] = [];
  for (const option of normalized) {
    const hash = await digest(option.canonicalSemanticKey);
    if (!/^[a-f0-9]{64}$/u.test(hash)) {
      throw adapterError("adapter_unavailable", "The model identifier digest is invalid.", false);
    }
    const id = `${MODEL_ID_PREFIX}${slugify(option.displayName)}-${hash.slice(0, 24)}`;
    if (entries.has(id)) {
      throw adapterError(
        "adapter_unavailable",
        "The ChatGPT Web model picker produced an identifier collision.",
        false,
      );
    }
    const inputModalities: ["text"] = ["text"];
    const supportedReasoningEfforts: WebModelDescriptor["supportedReasoningEfforts"] = [
      Object.freeze({
        description: REASONING_DESCRIPTION,
        reasoningEffort: PAGE_DEFAULT_REASONING_EFFORT,
      }),
    ];
    Object.freeze(inputModalities);
    Object.freeze(supportedReasoningEfforts);
    const descriptor: WebModelDescriptor = Object.freeze({
      defaultReasoningEffort: PAGE_DEFAULT_REASONING_EFFORT,
      displayName: option.displayName,
      id,
      inputModalities,
      supportedReasoningEfforts,
    });
    entries.set(
      id,
      Object.freeze({
        descriptor,
        selected: option.selected,
        semanticKey: option.semanticKey,
      }),
    );
    models.push(descriptor);
  }

  const revisionSource = models
    .map((descriptor) => {
      const entry = entries.get(descriptor.id);
      if (entry === undefined) {
        throw adapterError("adapter_unavailable", "The model catalog is inconsistent.", false);
      }
      return JSON.stringify({ descriptor, semanticKey: entry.semanticKey });
    })
    .join("\n");
  const revisionHash = await digest(revisionSource);
  if (!/^[a-f0-9]{64}$/u.test(revisionHash)) {
    throw adapterError("adapter_unavailable", "The catalog revision digest is invalid.", false);
  }
  return Object.freeze({
    catalogRevision: `web-ui-${revisionHash}`,
    entries,
    models: Object.freeze(models),
    semanticSnapshot: semanticSnapshot(normalized),
  });
}

function normalizeObservedCatalog(
  observed: readonly ObservedModelOption[],
): readonly NormalizedObservedOption[] {
  if (observed.length < 1 || observed.length > MAX_CATALOG_MODELS) {
    throw adapterError(
      "adapter_unavailable",
      "The ChatGPT Web model picker returned an invalid option count.",
      true,
    );
  }
  const normalized = observed
    .map((option) => normalizeObservedOption(option))
    .sort((left, right) => compareText(left.canonicalSemanticKey, right.canonicalSemanticKey));
  const semanticKeys = new Set(normalized.map((option) => option.canonicalSemanticKey));
  if (semanticKeys.size !== normalized.length) {
    throw adapterError(
      "adapter_unavailable",
      "The ChatGPT Web model picker contains ambiguous options.",
      true,
    );
  }
  if (normalized.filter((option) => option.selected).length !== 1) {
    throw adapterError(
      "adapter_unavailable",
      "The ChatGPT Web model picker did not expose exactly one selected model.",
      true,
    );
  }
  return normalized;
}

function semanticSnapshot(normalized: readonly NormalizedObservedOption[]): string {
  return normalized
    .map((option) =>
      JSON.stringify({ displayName: option.displayName, semanticKey: option.semanticKey }),
    )
    .join("\n");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeObservedOption(option: ObservedModelOption): NormalizedObservedOption {
  const displayName = normalizeVisibleText(option.displayName);
  const semanticKey = normalizeVisibleText(option.semanticKey);
  if (
    typeof option.selected !== "boolean" ||
    !isSafeSingleLineText(displayName, 128) ||
    !isSafeSingleLineText(semanticKey, MAX_SEMANTIC_KEY_CHARACTERS)
  ) {
    throw adapterError(
      "adapter_unavailable",
      "The ChatGPT Web model picker contains unsafe labels.",
      true,
    );
  }
  return {
    canonicalSemanticKey: semanticKey.toLocaleLowerCase("en-US"),
    displayName,
    selected: option.selected,
    semanticKey,
  };
}

function normalizeVisibleText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32)
    .replace(/-+$/u, "");
  return slug.length > 0 ? slug : "model";
}

function isSafeSingleLineText(value: string, maxLength: number): boolean {
  if (value.length < 1 || value.length > maxLength) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return false;
    }
  }
  return true;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function adapterError(
  code: PageFailureCode,
  message: string,
  retryable: boolean,
): ChatGptDomAdapterError {
  return new ChatGptDomAdapterError(Object.freeze({ code, message, retryable }));
}
