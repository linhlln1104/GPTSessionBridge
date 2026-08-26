import { describe, expect, it } from "vitest";

import {
  canonicalizeVisibleMessageText,
  ConversationOwnershipGuard,
  isStrictlyFollowingDocumentPosition,
} from "../src/content/conversation-ownership.js";
import {
  isExplicitModelContextName,
  isModelPopupControllerAuthorized,
  isModelSubmenuName,
  resolveModelOptionsRoute,
} from "../src/content/model-picker-semantics.js";

describe("fresh ChatGPT conversation ownership", () => {
  it("rejects activation on an existing transcript", () => {
    const guard = new ConversationOwnershipGuard<object>();
    expect(() => {
      guard.assertSurface({ assistantMessageCount: 1, pathname: "/c/existing", userMessages: [] });
    }).toThrow("conversation_not_fresh");
    expect(() => {
      guard.assertSurface({ assistantMessageCount: 0, pathname: "/", userMessages: [{}] });
    }).toThrow("conversation_not_fresh");
  });

  it("adopts the first fresh turn and rejects SPA navigation to another chat", () => {
    const guard = new ConversationOwnershipGuard<{ readonly text: string }>();
    const first = { text: "first" };
    const second = { text: "second" };
    guard.assertSurface({ assistantMessageCount: 0, pathname: "/", userMessages: [] });
    expect(
      guard.adoptTurn(
        new Set(),
        {
          assistantMessageCount: 0,
          pathname: "/",
          userMessages: [first],
        },
        "first",
        (message) => message.text,
      ),
    ).toBe(first);
    guard.assertSurface({
      assistantMessageCount: 1,
      pathname: "/c/owned",
      userMessages: [first],
    });
    expect(
      guard.adoptTurn(
        new Set([first]),
        {
          assistantMessageCount: 1,
          pathname: "/c/owned",
          userMessages: [first, second],
        },
        "second",
        (message) => message.text,
      ),
    ).toBe(second);
    expect(() => {
      guard.assertSurface({
        assistantMessageCount: 1,
        pathname: "/c/owned",
        userMessages: [first, second, { text: "third" }],
      });
    }).toThrow("conversation_ownership_lost");

    expect(() => {
      guard.assertSurface({
        assistantMessageCount: 0,
        pathname: "/c/other",
        userMessages: [{ text: "other" }],
      });
    }).toThrow();
    expect(() => {
      guard.assertSurface({
        assistantMessageCount: 1,
        pathname: "/c/other",
        userMessages: [first, second],
      });
    }).toThrow("conversation_path_changed");
  });

  it("rejects a new user node whose visible text does not match the submitted prompt", () => {
    const guard = new ConversationOwnershipGuard<{ readonly text: string }>();
    const wrong = { text: "different prompt" };

    expect(() =>
      guard.adoptTurn(
        new Set(),
        { assistantMessageCount: 0, pathname: "/", userMessages: [wrong] },
        "expected prompt",
        (message) => message.text,
      ),
    ).toThrow("conversation_turn_content_mismatch");
    expect(() => {
      guard.assertSurface({ assistantMessageCount: 0, pathname: "/", userMessages: [wrong] });
    }).toThrow("conversation_not_fresh");
  });

  it("normalizes visible line endings but requires a strictly following sibling node", () => {
    expect(canonicalizeVisibleMessageText("first\r\nsecond  \n")).toBe("first\nsecond");
    expect(isStrictlyFollowingDocumentPosition(0x04)).toBe(true);
    expect(isStrictlyFollowingDocumentPosition(0x04 | 0x01)).toBe(false);
    expect(isStrictlyFollowingDocumentPosition(0x04 | 0x10)).toBe(false);
    expect(isStrictlyFollowingDocumentPosition(0x02)).toBe(false);
  });
});

describe("current ChatGPT model picker semantics", () => {
  it("resolves the live nested Model menu without treating Effort as a model", () => {
    expect(
      resolveModelOptionsRoute([
        { hasPopup: true, name: "ModelGPT-5.6 Sol", role: "menuitem" },
        { hasPopup: true, name: "EffortPro", role: "menuitem" },
      ]),
    ).toEqual({ index: 0, kind: "submenu" });
  });

  it("accepts direct menuitemradio catalogs and rejects ambiguous submenus", () => {
    expect(
      resolveModelOptionsRoute([
        { hasPopup: false, name: "GPT-5.6 Sol", role: "menuitemradio" },
        { hasPopup: false, name: "GPT-5.5", role: "menuitemradio" },
      ]),
    ).toEqual({ kind: "direct" });
    expect(
      resolveModelOptionsRoute([
        { hasPopup: true, name: "ModelOne", role: "menuitem" },
        { hasPopup: true, name: "ModelTwo", role: "menuitem" },
      ]),
    ).toBeUndefined();
  });

  it("prefers one explicit Model submenu over unrelated direct radio items", () => {
    expect(
      resolveModelOptionsRoute([
        { hasPopup: false, name: "Unrelated setting", role: "menuitemradio" },
        { hasPopup: true, name: "ModelGPT-5.6 Sol", role: "menuitem" },
      ]),
    ).toEqual({ index: 1, kind: "submenu" });
    expect(
      resolveModelOptionsRoute([
        { hasPopup: true, name: "Modeling preferences", role: "menuitem" },
      ]),
    ).toBeUndefined();
  });

  it("rejects broad settings labels while accepting the reviewed model semantics", () => {
    expect(isModelSubmenuName("ModelGPT-5.6 Sol")).toBe(true);
    expect(isModelSubmenuName("Model o3")).toBe(true);
    expect(isModelSubmenuName("Model behavior")).toBe(false);
    expect(isModelSubmenuName("Model Settings")).toBe(false);
    expect(isExplicitModelContextName("Models")).toBe(true);
    expect(isExplicitModelContextName("Model picker")).toBe(true);
    expect(isExplicitModelContextName("Model behavior settings")).toBe(false);
  });

  it("does not authorize a nested root popup only because its trigger was verified", () => {
    const rootController = {
      matchesVerifiedTrigger: true,
      name: "Pro",
      role: "button",
    };
    expect(isModelPopupControllerAuthorized(rootController, false)).toBe(false);
    expect(isModelPopupControllerAuthorized(rootController, true)).toBe(true);
    expect(
      isModelPopupControllerAuthorized(
        {
          matchesVerifiedTrigger: false,
          name: "ModelGPT-5.6 Sol",
          role: "menuitem",
        },
        false,
      ),
    ).toBe(true);
  });
});
