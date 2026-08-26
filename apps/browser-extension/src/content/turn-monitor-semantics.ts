export type StableTurnTerminal = "cancelled" | "completed";

export interface StableTurnState {
  readonly cancelDispatched: boolean;
  readonly cancelRequested: boolean;
  readonly hasResponseText: boolean;
  readonly started: boolean;
  readonly stopObserved: boolean;
  readonly stopVisible: boolean;
}

/** Accepts only generation-specific Stop/Cancel labels, never generic composer controls. */
export function isGenerationStopControlName(value: string): boolean {
  return /^(?:stop(?: generating(?: response)?| generation| response| streaming)?|cancel(?: generating(?: response)?| generation| response| streaming))$/iu.test(
    value.trim(),
  );
}

export function isTurnSendControlName(value: string): boolean {
  return /^(?:send|submit)(?: (?:message|prompt))?$/iu.test(value.trim());
}

/** Resolves a terminal only after a visible Stop control proved the turn started. */
export function resolveStableTurnTerminal(state: StableTurnState): StableTurnTerminal | undefined {
  if (!state.started || !state.stopObserved || state.stopVisible) {
    return undefined;
  }
  if (state.cancelRequested && state.cancelDispatched) {
    return "cancelled";
  }
  return state.hasResponseText ? "completed" : undefined;
}
