import type {
  ChatGptUiDriver,
  ChatGptUiTurnPreparation,
  ChatGptUiTurnObserver,
  ChatGptUiTurnStartOutcome,
  ObservedModelOption,
} from "./chatgpt-dom-adapter.js";
import {
  ConversationOwnershipGuard,
  isStrictlyFollowingDocumentPosition,
} from "./conversation-ownership.js";
import {
  isExplicitModelContextName,
  isModelPopupControllerAuthorized,
  resolveModelOptionsRoute,
} from "./model-picker-semantics.js";
import {
  isGenerationStopControlName,
  isTurnSendControlName,
  resolveStableTurnTerminal,
  type StableTurnTerminal,
} from "./turn-monitor-semantics.js";

const CHATGPT_ORIGIN = "https://chatgpt.com";
const DOM_OPERATION_TIMEOUT_MS = 4_000;
const PICKER_TRIGGER_TIMEOUT_MS = 1_500;
const MAX_PICKER_TRIGGER_CANDIDATES = 16;
const MAX_OUTPUT_CHARACTERS = 1_048_576;
const MAX_PROMPT_CHARACTERS = 262_144;
const MAX_STREAM_DELTA_CHARACTERS = 16_384;
const STABLE_COMPLETION_MS = 800;
const TURN_LIFETIME_MS = 15 * 60 * 1_000;

interface PickerOption extends ObservedModelOption {
  readonly element: HTMLElement;
  readonly selected: boolean;
}

interface OpenPicker {
  readonly optionsPopup: HTMLElement;
  readonly popup: HTMLElement;
  readonly trigger: HTMLElement;
}

interface PickerTriggerCandidate {
  readonly allowDirectOptions: boolean;
  readonly element: HTMLElement;
}

interface VerifiedModelPicker {
  readonly direct: boolean;
  readonly trigger: HTMLElement;
}

interface Composer {
  readonly editor: HTMLElement | HTMLTextAreaElement;
  readonly form: HTMLFormElement;
}

export interface BrowserChatGptUiDriverOptions {
  readonly document?: Document;
  readonly location?: Location;
}

/**
 * Semantic DOM implementation for the isolated content-script world. It only
 * reads visible UI and invokes ordinary UI controls.
 */
export class BrowserChatGptUiDriver implements ChatGptUiDriver {
  readonly #document: Document;
  readonly #location: Location;
  readonly #ownership = new ConversationOwnershipGuard<HTMLElement>();
  #activeMonitor: BrowserTurnMonitor | undefined;
  readonly #catalogObservers = new Set<MutationObserver>();
  #disposed = false;
  #submissionUncertain = false;
  #verifiedModelPicker: VerifiedModelPicker | undefined;

  public constructor(options: BrowserChatGptUiDriverOptions = {}) {
    this.#document = options.document ?? document;
    this.#location = options.location ?? location;
    this.#assertAvailable();
    this.#assertConversationSurface();
  }

  public async discoverModelOptions(): Promise<readonly ObservedModelOption[]> {
    this.#assertAvailable();
    this.#assertConversationSurface();
    const picker = await this.#openVerifiedPicker();
    try {
      return snapshotPickerOptions(readPickerOptions(picker.optionsPopup));
    } finally {
      await this.#closePicker(picker);
    }
  }

  public async selectModel(semanticKey: string): Promise<boolean> {
    this.#assertAvailable();
    this.#assertConversationSurface();
    let picker = await this.#openVerifiedPicker();
    const matches = readPickerOptions(picker.optionsPopup).filter(
      (option) => option.semanticKey === semanticKey,
    );
    if (matches.length !== 1) {
      await this.#closePicker(picker);
      return false;
    }
    const selected = matches[0];
    if (selected === undefined) {
      await this.#closePicker(picker);
      return false;
    }
    if (selected.selected) {
      await this.#closePicker(picker);
      return true;
    }
    selected.element.click();
    if (!(await waitFor(() => !isVisible(picker.popup), this.#document))) {
      await this.#closePicker(picker);
      return false;
    }

    // Re-open and verify semantic selection state; click dispatch alone is not
    // accepted as proof that ChatGPT changed models.
    picker = await this.#openVerifiedPicker();
    try {
      const confirmed = readPickerOptions(picker.optionsPopup).filter(
        (option) => option.semanticKey === semanticKey && option.selected,
      );
      return confirmed.length === 1;
    } finally {
      await this.#closePicker(picker);
    }
  }

  public async startTextTurn(
    prompt: string,
    semanticKey: string,
    preparation: ChatGptUiTurnPreparation,
    observer: ChatGptUiTurnObserver,
  ): Promise<ChatGptUiTurnStartOutcome> {
    this.#assertAvailable();
    this.#assertConversationSurface();
    if (
      this.#activeMonitor !== undefined ||
      this.#submissionUncertain ||
      prompt.length < 1 ||
      prompt.length > MAX_PROMPT_CHARACTERS
    ) {
      throw new Error("text_turn_unavailable");
    }
    const picker = await this.#openVerifiedPicker();
    let composerWithPrompt: Composer | undefined;
    const handoff = { uncertain: false };
    let handoffNotified = false;
    let monitor: BrowserTurnMonitor | undefined;
    let baselineUsers: ReadonlySet<HTMLElement> | undefined;
    const markSubmissionUncertain = (): void => {
      if (!handoffNotified) {
        handoffNotified = true;
        try {
          preparation.onSubmitting();
        } finally {
          handoff.uncertain = true;
          this.#submissionUncertain = true;
        }
        return;
      }
      handoff.uncertain = true;
      this.#submissionUncertain = true;
    };
    try {
      // Everything from the fresh raw picker read through Send.click() is
      // synchronous. No digest, timer, observer, or other task can change the
      // selected model between verification and submission.
      const finalOptions = snapshotPickerOptions(readPickerOptions(picker.optionsPopup));
      if (
        !preparation.acceptModelOptions(finalOptions) ||
        finalOptions.filter((option) => option.semanticKey === semanticKey && option.selected)
          .length !== 1
      ) {
        throw new Error("model_picker_changed");
      }
      requestPopupClose(picker.trigger, picker.popup);
      if (isVisible(picker.popup) || isVisible(picker.optionsPopup)) {
        throw new Error("model_picker_close_unconfirmed");
      }
      if (!preparation.shouldSubmit()) {
        return "cancelled-before-submit";
      }

      this.#assertAvailable();
      this.#assertConversationSurface();
      const composer = findComposer(this.#document);
      if (readEditorText(composer.editor).length !== 0 || findStopButton(composer) !== undefined) {
        throw new Error("composer_not_idle");
      }
      const baseline = new Set(findAssistantMessages(this.#document));
      baselineUsers = new Set(findUserMessages(this.#document));
      composerWithPrompt = composer;
      if (!writeEditorText(composer.editor, prompt)) {
        throw new Error("composer_write_rejected");
      }
      const send = findSendButton(composer);
      monitor = new BrowserTurnMonitor({
        baseline,
        composer,
        document: this.#document,
        location: this.#location,
        observer: {
          ...observer,
          cancelled: () => {
            this.#clearMonitorIfSame(monitor);
            observer.cancelled();
          },
          completed: () => {
            this.#clearMonitorIfSame(monitor);
            observer.completed();
          },
          failed: () => {
            this.#clearMonitorIfSame(monitor);
            observer.failed();
          },
        },
      });
      this.#activeMonitor = monitor;
      monitor.observe();
      // From this point onward a thrown click or delayed SPA update cannot
      // prove that the prompt was not accepted. Keep the document terminally
      // locked unless ownership and visible start are both confirmed.
      markSubmissionUncertain();
      send.click();
      if (!(await monitor.waitUntilStarted())) {
        throw new Error("turn_start_unconfirmed");
      }
      const userAnchor = await this.#adoptOrVerifyOwnedConversation(baselineUsers, prompt);
      monitor.bindConversationValidator(() => {
        this.#assertConversationSurface();
      }, userAnchor);
      monitor.confirmStarted();
      this.#submissionUncertain = false;
      return "submitted";
    } catch (error) {
      monitor?.fail(false);
      this.#clearMonitorIfSame(monitor);
      if (
        !handoff.uncertain &&
        composerWithPrompt !== undefined &&
        !clearExactEditorPrompt(composerWithPrompt.editor, prompt)
      ) {
        // An unconfirmed prompt left in the composer could be sent later by
        // the page or user. Treat it like an uncertain handoff and forbid a
        // retry that could duplicate the request.
        markSubmissionUncertain();
      }
      if (!handoff.uncertain) {
        try {
          await this.#closePicker(picker);
        } catch {
          // Preserve the primary pre-submit diagnostic.
        }
      }
      throw error;
    }
  }

  public cancelTextTurn(): Promise<boolean> {
    this.#assertAvailable();
    return Promise.resolve(this.#activeMonitor?.requestCancellation() ?? false);
  }

  #clearMonitorIfSame(monitor: BrowserTurnMonitor | undefined): void {
    if (monitor !== undefined && this.#activeMonitor === monitor) {
      this.#activeMonitor = undefined;
    }
  }

  public observeModelOptions(
    listener: (options: readonly ObservedModelOption[]) => void,
  ): () => void {
    this.#assertAvailable();
    const root = this.#document.documentElement;
    let lastSignature: string | undefined;
    let queued = false;
    let stopped = false;
    const inspect = (): void => {
      queued = false;
      if (stopped) {
        return;
      }
      const observed: PickerOption[][] = [];
      for (const popup of findVisiblePickerPopups(this.#document)) {
        if (!isObservedModelOptionsPopup(popup, this.#verifiedModelPicker, this.#document)) {
          continue;
        }
        try {
          const options = [...readPickerOptions(popup)];
          if (options.filter((option) => option.selected).length === 1) {
            observed.push(options);
          }
        } catch {
          // A visible non-model menu is outside the observer's narrow contract.
        }
      }
      if (observed.length !== 1) {
        return;
      }
      const options = observed[0];
      if (options === undefined) {
        return;
      }
      const signature = options.map((option) => option.semanticKey).join("\n");
      if (signature === lastSignature) {
        return;
      }
      lastSignature = signature;
      listener(
        Object.freeze(
          options.map((option) =>
            Object.freeze({
              displayName: option.displayName,
              selected: option.selected,
              semanticKey: option.semanticKey,
            }),
          ),
        ),
      );
    };
    const scheduleInspect = (): void => {
      if (queued || stopped) {
        return;
      }
      queued = true;
      queueMicrotask(inspect);
    };
    const observer = new MutationObserver(scheduleInspect);
    observer.observe(root, { attributes: true, childList: true, subtree: true });
    this.#catalogObservers.add(observer);
    scheduleInspect();
    return () => {
      stopped = true;
      observer.disconnect();
      this.#catalogObservers.delete(observer);
    };
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const observer of this.#catalogObservers) {
      observer.disconnect();
    }
    this.#catalogObservers.clear();
    try {
      this.#activeMonitor?.requestCancellation();
    } catch {
      // Disconnect is best-effort: never turn teardown into a page exception.
    }
    this.#activeMonitor?.fail(false);
    this.#activeMonitor = undefined;
    this.#verifiedModelPicker = undefined;
  }

  async #openVerifiedPicker(): Promise<OpenPicker> {
    for (const candidate of findModelPickerTriggerCandidates(this.#document)) {
      const trigger = candidate.element;
      const existingPopups = new Set(findVisiblePickerPopups(this.#document));
      trigger.click();
      const rootPopup = await waitForValue(
        () => findControlledOrNewPopup(trigger, existingPopups, this.#document),
        this.#document,
        PICKER_TRIGGER_TIMEOUT_MS,
      );
      if (rootPopup === undefined) {
        continue;
      }
      const resolved = await openModelOptionsPopup(rootPopup, this.#document);
      if (
        resolved === undefined ||
        (resolved.direct &&
          !candidate.allowDirectOptions &&
          !hasExplicitModelSemanticContext(resolved.popup))
      ) {
        await closePopup(trigger, rootPopup, this.#document);
        continue;
      }
      let options: readonly PickerOption[];
      try {
        options = readPickerOptions(resolved.popup);
      } catch {
        await closePopup(trigger, rootPopup, this.#document);
        continue;
      }
      if (options.length < 1 || options.filter((option) => option.selected).length !== 1) {
        await closePopup(trigger, rootPopup, this.#document);
        continue;
      }
      this.#verifiedModelPicker = Object.freeze({ direct: resolved.direct, trigger });
      return Object.freeze({ optionsPopup: resolved.popup, popup: rootPopup, trigger });
    }
    throw new Error("model_picker_unavailable");
  }

  async #closePicker(picker: OpenPicker): Promise<void> {
    if (isVisible(picker.popup)) {
      await closePopup(picker.trigger, picker.popup, this.#document);
    }
    if (picker.optionsPopup !== picker.popup && isVisible(picker.optionsPopup)) {
      picker.optionsPopup.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
      );
      if (!(await waitFor(() => !isVisible(picker.optionsPopup), this.#document))) {
        throw new Error("model_picker_close_unconfirmed");
      }
    }
  }

  #assertAvailable(): void {
    if (this.#disposed || this.#location.origin !== CHATGPT_ORIGIN) {
      throw new Error("chatgpt_page_unavailable");
    }
  }

  #assertConversationSurface(): void {
    this.#ownership.assertSurface(readConversationSurface(this.#document, this.#location));
  }

  async #adoptOrVerifyOwnedConversation(
    baselineUsers: ReadonlySet<HTMLElement>,
    prompt: string,
  ): Promise<HTMLElement> {
    const candidate = await waitForValue(() => {
      const fresh = findUserMessages(this.#document).filter(
        (message) => !baselineUsers.has(message),
      );
      if (fresh.length > 1) {
        throw new Error("conversation_turn_ambiguous");
      }
      return fresh.length === 1 ? fresh[0] : undefined;
    }, this.#document);
    if (candidate === undefined) {
      throw new Error("conversation_ownership_unconfirmed");
    }
    return this.#ownership.adoptTurn(
      baselineUsers,
      readConversationSurface(this.#document, this.#location),
      prompt,
      (message) => serializeVisibleText(message, MAX_PROMPT_CHARACTERS),
    );
  }
}

interface BrowserTurnMonitorOptions {
  readonly baseline: ReadonlySet<HTMLElement>;
  readonly composer: Composer;
  readonly document: Document;
  readonly location: Location;
  readonly observer: ChatGptUiTurnObserver;
}

class BrowserTurnMonitor {
  readonly #baseline: ReadonlySet<HTMLElement>;
  readonly #composer: Composer;
  readonly #document: Document;
  readonly #location: Location;
  readonly #observer: ChatGptUiTurnObserver;
  readonly #startedPromise: Promise<boolean>;
  #cancelRequested = false;
  #cancelDispatched = false;
  #completionExpectedText: string | undefined;
  #completionExpectedTerminal: StableTurnTerminal | undefined;
  #completionTimer: ReturnType<typeof setTimeout> | undefined;
  #finished = false;
  #lastText = "";
  #lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  #mutationObserver: MutationObserver | undefined;
  #resolveStarted: ((started: boolean) => void) | undefined;
  #response: HTMLElement | undefined;
  #started = false;
  #stopObserved = false;
  #userAnchor: HTMLElement | undefined;
  #validateConversation: (() => void) | undefined;

  public constructor(options: BrowserTurnMonitorOptions) {
    this.#baseline = options.baseline;
    this.#composer = options.composer;
    this.#document = options.document;
    this.#location = options.location;
    this.#observer = options.observer;
    this.#startedPromise = new Promise<boolean>((resolve) => {
      this.#resolveStarted = resolve;
    });
  }

  public observe(): void {
    const body = this.#document.body;
    this.#mutationObserver = new MutationObserver(() => {
      this.#tick();
    });
    this.#mutationObserver.observe(body, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    this.#lifetimeTimer = setTimeout(() => {
      this.fail();
    }, TURN_LIFETIME_MS);
    this.#tick();
  }

  public async waitUntilStarted(): Promise<boolean> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve(false);
      }, DOM_OPERATION_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.#startedPromise, timeout]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  public requestCancellation(): boolean {
    if (this.#finished) {
      return false;
    }
    this.#cancelRequested = true;
    this.#tick();
    return !this.#finished;
  }

  public bindConversationValidator(validate: () => void, userAnchor: HTMLElement): void {
    if (this.#finished || !this.#stopObserved || this.#started) {
      throw new Error("turn_monitor_state_invalid");
    }
    validate();
    if (this.#response !== undefined) {
      this.#assertAssistantFollowsUser(userAnchor, this.#response);
    }
    this.#userAnchor = userAnchor;
    this.#validateConversation = validate;
  }

  public confirmStarted(): void {
    if (this.#finished || !this.#stopObserved || this.#started || this.#userAnchor === undefined) {
      throw new Error("turn_monitor_state_invalid");
    }
    this.#started = true;
    this.#observer.started();
    if (this.#lastText.length > 0) {
      emitBoundedDelta(this.#lastText, this.#observer);
    }
    this.#tick();
  }

  public fail(notify = this.#started): void {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    this.#resolveStarted?.(false);
    this.#resolveStarted = undefined;
    this.#cleanup();
    if (notify) {
      this.#observer.failed();
    }
  }

  #tick(): void {
    if (this.#finished) {
      return;
    }
    if (this.#location.origin !== CHATGPT_ORIGIN || !this.#document.body.isConnected) {
      this.fail();
      return;
    }
    if (!this.#composer.form.isConnected || !this.#composer.editor.isConnected) {
      this.fail();
      return;
    }
    try {
      this.#validateConversation?.();
    } catch {
      this.fail();
      return;
    }

    let stop: HTMLButtonElement | undefined;
    try {
      stop = findStopButton(this.#composer);
      const candidates = findAssistantMessages(this.#document).filter(
        (candidate) => !this.#baseline.has(candidate),
      );
      if (candidates.length > 1) {
        this.fail();
        return;
      }
      const candidate = candidates[0];
      if (candidate !== undefined) {
        if (this.#response !== undefined && this.#response !== candidate) {
          this.fail();
          return;
        }
        if (this.#userAnchor !== undefined) {
          this.#assertAssistantFollowsUser(this.#userAnchor, candidate);
        }
        this.#response = candidate;
        const text = extractAssistantText(candidate);
        if (text.length > MAX_OUTPUT_CHARACTERS || !text.startsWith(this.#lastText)) {
          this.fail();
          return;
        }
        const delta = text.slice(this.#lastText.length);
        this.#lastText = text;
        if (this.#started && delta.length > 0) {
          emitBoundedDelta(delta, this.#observer);
        }
      }
      if (this.#cancelRequested && !this.#cancelDispatched && stop !== undefined) {
        this.#cancelDispatched = true;
        stop.click();
      }
    } catch {
      this.fail();
      return;
    }

    if (stop !== undefined) {
      this.#stopObserved = true;
      this.#resolveStarted?.(true);
      this.#resolveStarted = undefined;
    }

    const terminal = resolveStableTurnTerminal({
      cancelDispatched: this.#cancelDispatched,
      cancelRequested: this.#cancelRequested,
      hasResponseText: this.#response !== undefined && this.#lastText.length > 0,
      started: this.#started,
      stopObserved: this.#stopObserved,
      stopVisible: stop !== undefined,
    });
    if (terminal === undefined) {
      if (stop !== undefined) {
        this.#clearCompletionTimer();
      }
    } else {
      this.#scheduleCompletion(this.#lastText, terminal);
    }
  }

  #scheduleCompletion(expectedText: string, expectedTerminal: StableTurnTerminal): void {
    if (
      this.#completionTimer !== undefined &&
      this.#completionExpectedText === expectedText &&
      this.#completionExpectedTerminal === expectedTerminal
    ) {
      return;
    }
    this.#clearCompletionTimer();
    this.#completionExpectedText = expectedText;
    this.#completionExpectedTerminal = expectedTerminal;
    this.#completionTimer = setTimeout(() => {
      this.#completionTimer = undefined;
      this.#completionExpectedText = undefined;
      this.#completionExpectedTerminal = undefined;
      if (this.#finished || expectedText !== this.#lastText) {
        return;
      }
      try {
        this.#validateConversation?.();
        if (findStopButton(this.#composer) !== undefined) {
          return;
        }
      } catch {
        this.fail();
        return;
      }
      this.#finished = true;
      this.#cleanup();
      if (expectedTerminal === "cancelled") {
        this.#observer.cancelled();
      } else {
        this.#observer.completed();
      }
    }, STABLE_COMPLETION_MS);
  }

  #clearCompletionTimer(): void {
    if (this.#completionTimer !== undefined) {
      clearTimeout(this.#completionTimer);
      this.#completionTimer = undefined;
    }
    this.#completionExpectedText = undefined;
    this.#completionExpectedTerminal = undefined;
  }

  #cleanup(): void {
    this.#mutationObserver?.disconnect();
    this.#mutationObserver = undefined;
    this.#clearCompletionTimer();
    if (this.#lifetimeTimer !== undefined) {
      clearTimeout(this.#lifetimeTimer);
      this.#lifetimeTimer = undefined;
    }
  }

  #assertAssistantFollowsUser(userAnchor: HTMLElement, assistant: HTMLElement): void {
    if (
      userAnchor.ownerDocument !== assistant.ownerDocument ||
      !isStrictlyFollowingDocumentPosition(userAnchor.compareDocumentPosition(assistant))
    ) {
      throw new Error("assistant_response_order_invalid");
    }
  }
}

function snapshotPickerOptions(options: readonly PickerOption[]): readonly ObservedModelOption[] {
  return Object.freeze(
    options.map((option) =>
      Object.freeze({
        displayName: option.displayName,
        selected: option.selected,
        semanticKey: option.semanticKey,
      }),
    ),
  );
}

function findModelPickerTriggerCandidates(
  documentValue: Document,
): readonly PickerTriggerCandidate[] {
  const candidates = uniqueElements([
    ...documentValue.querySelectorAll<HTMLElement>(
      'button[aria-haspopup="menu"], button[aria-haspopup="listbox"], [role="combobox"][aria-haspopup="listbox"]',
    ),
  ]).filter(
    (element) =>
      isVisible(element) &&
      accessibleName(element).length > 0 &&
      element.id !== "composer-plus-btn",
  );
  const composer = tryFindComposer(documentValue);
  const ordered = [...candidates].sort((left, right) => {
    return triggerPriority(left, composer) - triggerPriority(right, composer);
  });
  if (ordered.length < 1 || ordered.length > MAX_PICKER_TRIGGER_CANDIDATES) {
    throw new Error("model_picker_trigger_ambiguous");
  }
  return Object.freeze(
    ordered.map((element) =>
      Object.freeze({
        allowDirectOptions: hasExplicitModelSemanticContext(element),
        element,
      }),
    ),
  );
}

function triggerPriority(element: HTMLElement, composer: Composer | undefined): number {
  if (/\bmodel\b/iu.test(accessibleName(element))) {
    return 0;
  }
  if (composer?.form.contains(element) === true) {
    return 1;
  }
  return element.closest("header") === null ? 3 : 2;
}

async function openModelOptionsPopup(
  rootPopup: HTMLElement,
  documentValue: Document,
): Promise<{ readonly direct: boolean; readonly popup: HTMLElement } | undefined> {
  const menuElements = uniqueElements([
    ...rootPopup.querySelectorAll<HTMLElement>(
      '[role="menuitemradio"], [role="option"], [role="menuitem"]',
    ),
  ]).filter((element) => isVisible(element));
  const route = resolveModelOptionsRoute(
    menuElements.map((element) => ({
      hasPopup:
        element.getAttribute("aria-haspopup") === "menu" ||
        element.getAttribute("aria-haspopup") === "listbox",
      name: accessibleName(element),
      role: element.getAttribute("role") ?? "",
    })),
  );
  if (route?.kind === "direct") {
    return Object.freeze({ direct: true, popup: rootPopup });
  }
  if (route?.kind !== "submenu") {
    return undefined;
  }
  const submenuTrigger = menuElements[route.index];
  if (submenuTrigger === undefined) {
    return undefined;
  }
  const existing = new Set(findVisiblePickerPopups(documentValue));
  submenuTrigger.click();
  const popup = await waitForValue(
    () => findControlledOrNewPopup(submenuTrigger, existing, documentValue),
    documentValue,
  );
  return popup === undefined ? undefined : Object.freeze({ direct: false, popup });
}

function findControlledOrNewPopup(
  trigger: HTMLElement,
  existing: ReadonlySet<HTMLElement>,
  documentValue: Document,
): HTMLElement | undefined {
  const controlledId = trigger.getAttribute("aria-controls");
  if (controlledId !== null && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(controlledId)) {
    const controlled = documentValue.getElementById(controlledId);
    if (controlled instanceof HTMLElement && isPickerPopup(controlled) && isVisible(controlled)) {
      return controlled;
    }
  }
  const fresh = findVisiblePickerPopups(documentValue).filter((popup) => !existing.has(popup));
  return fresh.length === 1 ? fresh[0] : undefined;
}

function findVisiblePickerPopups(documentValue: Document): readonly HTMLElement[] {
  return uniqueElements([
    ...documentValue.querySelectorAll<HTMLElement>('[role="menu"], [role="listbox"]'),
  ]).filter((element) => isVisible(element) && isPickerPopup(element));
}

function isPickerPopup(element: HTMLElement): boolean {
  return element.matches('[role="menu"], [role="listbox"]');
}

function isObservedModelOptionsPopup(
  popup: HTMLElement,
  verified: VerifiedModelPicker | undefined,
  documentValue: Document,
): boolean {
  if (hasExplicitModelSemanticContext(popup)) {
    return true;
  }
  if (popup.id.length < 1 || popup.id.length > 128) {
    return false;
  }
  const controllers = [
    ...documentValue.querySelectorAll<HTMLElement>("[aria-controls][aria-haspopup]"),
  ].filter(
    (element) =>
      isVisible(element) &&
      element.getAttribute("aria-controls") === popup.id &&
      (element.getAttribute("aria-haspopup") === "menu" ||
        element.getAttribute("aria-haspopup") === "listbox"),
  );
  return controllers.some((controller) =>
    isModelPopupControllerAuthorized(
      {
        matchesVerifiedTrigger: controller === verified?.trigger,
        name: accessibleName(controller),
        role: controller.getAttribute("role") ?? "",
      },
      verified?.direct === true,
    ),
  );
}

function hasExplicitModelSemanticContext(element: HTMLElement): boolean {
  return [element, ...element.querySelectorAll<HTMLElement>('[role="group"]')].some((context) => {
    const name = explicitAccessibleName(context);
    return name !== undefined && isExplicitModelContextName(name);
  });
}

function readPickerOptions(popup: HTMLElement): readonly PickerOption[] {
  const elements = uniqueElements([
    ...popup.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="option"]'),
  ]).filter(
    (element) =>
      isVisible(element) &&
      element.getAttribute("aria-disabled") !== "true" &&
      element.getAttribute("aria-haspopup") === null,
  );
  if (elements.length < 1 || elements.length > 128) {
    throw new Error("model_picker_option_count_invalid");
  }
  // The popup's labelled-by target can contain the currently selected model,
  // so only its semantic role participates in stable option identity.
  const popupContext = popup.getAttribute("role") ?? "";
  const options = elements.map((element) => {
    const displayName = accessibleName(element);
    const group = element.closest<HTMLElement>('[role="group"]');
    const groupContext = group === null ? "" : semanticContext(group);
    const role = element.getAttribute("role") ?? "";
    if (displayName.length < 1 || displayName.length > 128 || role.length < 1) {
      throw new Error("model_picker_option_invalid");
    }
    return Object.freeze({
      displayName,
      element,
      selected:
        element.getAttribute("aria-checked") === "true" ||
        element.getAttribute("aria-selected") === "true",
      semanticKey: `${popupContext}|${groupContext}|${role}:${displayName}`,
    });
  });
  if (new Set(options.map((option) => option.semanticKey)).size !== options.length) {
    throw new Error("model_picker_option_ambiguous");
  }
  return Object.freeze(options);
}

function semanticContext(element: HTMLElement): string {
  const role = element.getAttribute("role") ?? "";
  const label = explicitAccessibleName(element) ?? "";
  return `${role}:${label}`;
}

async function closePopup(
  trigger: HTMLElement,
  popup: HTMLElement,
  documentValue: Document,
): Promise<void> {
  if (!isVisible(popup)) {
    return;
  }
  requestPopupClose(trigger, popup);
  if (!(await waitFor(() => !isVisible(popup), documentValue))) {
    throw new Error("model_picker_close_unconfirmed");
  }
}

function requestPopupClose(trigger: HTMLElement, popup: HTMLElement): void {
  if (!isVisible(popup)) {
    return;
  }
  if (trigger.getAttribute("aria-expanded") === "true") {
    trigger.click();
  } else {
    popup.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
    );
  }
}

function findComposer(documentValue: Document): Composer {
  const composer = tryFindComposer(documentValue);
  if (composer === undefined) {
    throw new Error("composer_unavailable");
  }
  return composer;
}

function tryFindComposer(documentValue: Document): Composer | undefined {
  const editors = uniqueElements([
    ...documentValue.querySelectorAll<HTMLElement>(
      '[contenteditable="true"][role="textbox"], #prompt-textarea[contenteditable="true"], textarea[aria-label]',
    ),
  ]).filter(
    (element) =>
      isVisible(element) &&
      element.getAttribute("aria-disabled") !== "true" &&
      (!(element instanceof HTMLTextAreaElement) || !element.readOnly),
  );
  const candidates = editors.flatMap((editor) => {
    const form = editor.closest("form");
    return form instanceof HTMLFormElement ? [{ editor, form }] : [];
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

function readEditorText(editor: HTMLElement | HTMLTextAreaElement): string {
  const value = editor instanceof HTMLTextAreaElement ? editor.value : editor.textContent;
  return normalizeLineEndings(value);
}

function writeEditorText(editor: HTMLElement | HTMLTextAreaElement, value: string): boolean {
  const normalized = normalizeLineEndings(value);
  editor.focus();
  if (editor instanceof HTMLTextAreaElement) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    descriptor?.set?.call(editor, normalized);
  } else {
    editor.replaceChildren(editor.ownerDocument.createTextNode(normalized));
  }
  editor.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      composed: true,
      data: normalized,
      inputType: "insertText",
    }),
  );
  return readEditorText(editor) === normalized;
}

function clearExactEditorPrompt(
  editor: HTMLElement | HTMLTextAreaElement,
  prompt: string,
): boolean {
  try {
    const current = readEditorText(editor);
    if (current.length === 0) {
      return true;
    }
    if (current !== normalizeLineEndings(prompt)) {
      return false;
    }
    return writeEditorText(editor, "") && readEditorText(editor).length === 0;
  } catch {
    return false;
  }
}

function findSendButton(composer: Composer): HTMLButtonElement {
  const semanticSubmit = uniqueElements([
    ...composer.form.querySelectorAll<HTMLButtonElement>('button[type="submit"]'),
  ]).filter((button) => isVisible(button) && !button.disabled);
  const submit = semanticSubmit[0];
  if (semanticSubmit.length === 1 && submit !== undefined) {
    return submit;
  }
  const named = uniqueElements([
    ...composer.form.querySelectorAll<HTMLButtonElement>("button[aria-label]"),
  ]).filter(
    (button) =>
      isVisible(button) && !button.disabled && isTurnSendControlName(accessibleName(button)),
  );
  if (named.length !== 1) {
    throw new Error("send_control_ambiguous");
  }
  const namedButton = named[0];
  if (namedButton === undefined) {
    throw new Error("send_control_unavailable");
  }
  return namedButton;
}

function findStopButton(composer: Composer): HTMLButtonElement | undefined {
  const candidates = uniqueElements([
    ...composer.form.querySelectorAll<HTMLButtonElement>("button[aria-label], button[type=button]"),
  ]).filter(
    (button) =>
      isVisible(button) && !button.disabled && isGenerationStopControlName(accessibleName(button)),
  );
  if (candidates.length > 1) {
    throw new Error("stop_control_ambiguous");
  }
  return candidates[0];
}

function findAssistantMessages(documentValue: Document): readonly HTMLElement[] {
  return uniqueElements([
    ...documentValue.querySelectorAll<HTMLElement>('[data-message-author-role="assistant"]'),
  ]).filter((element) => isVisible(element));
}

function findUserMessages(documentValue: Document): readonly HTMLElement[] {
  return uniqueElements([
    ...documentValue.querySelectorAll<HTMLElement>('[data-message-author-role="user"]'),
  ]).filter((element) => isVisible(element));
}

function readConversationSurface(
  documentValue: Document,
  locationValue: Location,
): {
  readonly assistantMessageCount: number;
  readonly pathname: string;
  readonly userMessages: readonly HTMLElement[];
} {
  return Object.freeze({
    assistantMessageCount: findAssistantMessages(documentValue).length,
    pathname: locationValue.pathname,
    userMessages: findUserMessages(documentValue),
  });
}

function extractAssistantText(message: HTMLElement): string {
  const value = serializeVisibleText(message, MAX_OUTPUT_CHARACTERS)
    .replace(/\u00a0/gu, " ")
    .replace(/\n{3,}/gu, "\n\n");
  return value.replace(/[\t ]+\n/gu, "\n").trimEnd();
}

function serializeVisibleText(node: Node, maxCharacters: number): string {
  const parts: string[] = [];
  let length = 0;
  const append = (value: string): void => {
    length += value.length;
    if (length > maxCharacters) {
      throw new Error("visible_message_too_large");
    }
    parts.push(value);
  };
  const visit = (current: Node): void => {
    if (current.nodeType === Node.TEXT_NODE) {
      append(current.textContent ?? "");
      return;
    }
    if (!(current instanceof HTMLElement)) {
      return;
    }
    if (
      current.matches(
        'button, input, nav, script, select, style, svg, textarea, [aria-hidden="true"], [hidden]',
      ) ||
      !isVisible(current)
    ) {
      return;
    }
    if (current.tagName === "BR") {
      append("\n");
      return;
    }
    const before = length;
    for (const child of current.childNodes) {
      visit(child);
    }
    if (isBlockElement(current) && length > before) {
      append("\n");
    }
  };
  visit(node);
  return parts.join("");
}

function isBlockElement(element: HTMLElement): boolean {
  return /^(?:ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DIV|DL|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|OL|P|PRE|SECTION|TABLE|UL)$/u.test(
    element.tagName,
  );
}

function emitBoundedDelta(delta: string, observer: ChatGptUiTurnObserver): void {
  for (let offset = 0; offset < delta.length; offset += MAX_STREAM_DELTA_CHARACTERS) {
    observer.outputText(delta.slice(offset, offset + MAX_STREAM_DELTA_CHARACTERS));
  }
}

function accessibleName(element: HTMLElement): string {
  const explicit = explicitAccessibleName(element);
  if (explicit !== undefined) {
    return explicit;
  }
  return normalizeVisibleText(element.innerText || element.textContent || "");
}

function explicitAccessibleName(element: HTMLElement): string | undefined {
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) {
    return normalizeVisibleText(ariaLabel);
  }
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const ids = labelledBy.trim().split(/\s+/u);
    if (
      ids.length > 0 &&
      ids.length <= 8 &&
      ids.every((id) => /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(id))
    ) {
      const label = ids
        .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (label.trim().length > 0) {
        return normalizeVisibleText(label);
      }
    }
  }
  return undefined;
}

function normalizeVisibleText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.hidden || element.getAttribute("aria-hidden") === "true") {
    return false;
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return (
    style?.display !== "none" &&
    style?.visibility !== "hidden" &&
    element.getClientRects().length > 0
  );
}

function uniqueElements<ElementType extends HTMLElement>(
  elements: readonly ElementType[],
): ElementType[] {
  return [...new Set(elements)];
}

async function waitFor(predicate: () => boolean, documentValue: Document): Promise<boolean> {
  return (await waitForValue(() => (predicate() ? true : undefined), documentValue)) === true;
}

async function waitForValue<Value>(
  read: () => Value | undefined,
  documentValue: Document,
  timeoutMilliseconds = DOM_OPERATION_TIMEOUT_MS,
): Promise<Value | undefined> {
  const immediate = read();
  if (immediate !== undefined) {
    return immediate;
  }
  const root = documentValue.documentElement;
  return new Promise<Value | undefined>((resolve) => {
    let settled = false;
    const finish = (value: Value | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      observer.disconnect();
      clearTimeout(timeout);
      resolve(value);
    };
    const observer = new MutationObserver(() => {
      try {
        const value = read();
        if (value !== undefined) {
          finish(value);
        }
      } catch {
        finish(undefined);
      }
    });
    const timeout = setTimeout(() => {
      finish(undefined);
    }, timeoutMilliseconds);
    observer.observe(root, { attributes: true, childList: true, subtree: true });
  });
}
