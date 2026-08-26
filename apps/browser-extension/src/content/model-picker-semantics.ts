export interface SemanticMenuItem {
  readonly hasPopup: boolean;
  readonly name: string;
  readonly role: string;
}

export interface ModelPopupController {
  readonly matchesVerifiedTrigger: boolean;
  readonly name: string;
  readonly role: string;
}

export type ModelOptionsRoute =
  { readonly kind: "direct" } | { readonly index: number; readonly kind: "submenu" };

/** Resolves only direct radio/options or one explicitly named Model submenu. */
export function resolveModelOptionsRoute(
  items: readonly SemanticMenuItem[],
): ModelOptionsRoute | undefined {
  const candidates = items
    .map((item, index) => ({ index, item }))
    .filter(
      ({ item }) => item.role === "menuitem" && item.hasPopup && isModelSubmenuName(item.name),
    );
  const selected = candidates[0];
  if (candidates.length === 1 && selected !== undefined) {
    return Object.freeze({ index: selected.index, kind: "submenu" });
  }
  if (candidates.length > 1) {
    return undefined;
  }
  return items.some((item) => item.role === "menuitemradio" || item.role === "option")
    ? Object.freeze({ kind: "direct" })
    : undefined;
}

export function isModelSubmenuName(value: string): boolean {
  if (value.slice(0, 5).toLocaleLowerCase("en-US") !== "model") {
    return false;
  }
  const suffix = value.slice(5);
  if (suffix.length === 0) {
    return true;
  }
  return /^(?:Auto(?:\s|$)|ChatGPT(?:\s|[-0-9]|$)|GPT(?:\s|[-0-9]|$)|o[0-9](?:\s|[-0-9]|$))/u.test(
    suffix.trimStart(),
  );
}

export function isExplicitModelContextName(value: string): boolean {
  return /^(?:available models|choose (?:a )?model|models?|model picker|model selector)$/iu.test(
    value.trim(),
  );
}

export function isModelPopupControllerAuthorized(
  controller: ModelPopupController,
  verifiedRouteIsDirect: boolean,
): boolean {
  return (
    (verifiedRouteIsDirect && controller.matchesVerifiedTrigger) ||
    (controller.role === "menuitem" && isModelSubmenuName(controller.name))
  );
}
