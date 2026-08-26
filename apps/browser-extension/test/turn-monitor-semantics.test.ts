import { describe, expect, it } from "vitest";

import {
  isGenerationStopControlName,
  isTurnSendControlName,
  resolveStableTurnTerminal,
} from "../src/content/turn-monitor-semantics.js";

describe("ChatGPT turn monitor terminal semantics", () => {
  it("completes normally when cancellation arrived after Stop was already gone", () => {
    expect(
      resolveStableTurnTerminal({
        cancelDispatched: false,
        cancelRequested: true,
        hasResponseText: true,
        started: true,
        stopObserved: true,
        stopVisible: false,
      }),
    ).toBe("completed");
  });

  it("cancels only after the visible Stop control was actually dispatched", () => {
    expect(
      resolveStableTurnTerminal({
        cancelDispatched: true,
        cancelRequested: true,
        hasResponseText: false,
        started: true,
        stopObserved: true,
        stopVisible: false,
      }),
    ).toBe("cancelled");
    expect(
      resolveStableTurnTerminal({
        cancelDispatched: false,
        cancelRequested: true,
        hasResponseText: false,
        started: true,
        stopObserved: true,
        stopVisible: false,
      }),
    ).toBeUndefined();
  });

  it("does not resolve any terminal without a previously visible Stop control", () => {
    expect(
      resolveStableTurnTerminal({
        cancelDispatched: false,
        cancelRequested: false,
        hasResponseText: true,
        started: false,
        stopObserved: false,
        stopVisible: false,
      }),
    ).toBeUndefined();
    expect(
      resolveStableTurnTerminal({
        cancelDispatched: true,
        cancelRequested: true,
        hasResponseText: true,
        started: true,
        stopObserved: false,
        stopVisible: false,
      }),
    ).toBeUndefined();
  });

  it("does not confuse generic composer cancellation with generation Stop", () => {
    expect(isGenerationStopControlName("Stop streaming")).toBe(true);
    expect(isGenerationStopControlName("Cancel generating response")).toBe(true);
    expect(isGenerationStopControlName("Cancel upload")).toBe(false);
    expect(isGenerationStopControlName("Cancel")).toBe(false);
    expect(isTurnSendControlName("Send prompt")).toBe(true);
    expect(isTurnSendControlName("Send feedback")).toBe(false);
  });
});
