const NAVIGATION_POLL_INTERVAL_MS = 250;

export interface DocumentNavigationMonitorOptions {
  readonly decideChange?: (previousUrl: string, nextUrl: string) => "adopt" | "defer" | "reject";
  readonly document: Document;
  readonly onChanged: () => void;
  readonly window: Window;
}

/**
 * Detects full URL changes in a ChatGPT SPA without patching page JavaScript or
 * requesting webNavigation/history permissions. The DOM observer makes normal
 * route transitions immediate; the bounded poll covers history changes that do
 * not mutate the visible document.
 */
export function observeDocumentNavigation(options: DocumentNavigationMonitorOptions): () => void {
  let acceptedUrl = options.window.location.href;
  let stopped = false;

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    observer.disconnect();
    options.window.removeEventListener("hashchange", check);
    options.window.removeEventListener("popstate", check);
    options.window.clearInterval(interval);
  };
  const check = (): void => {
    if (stopped) {
      return;
    }
    const nextUrl = options.window.location.href;
    if (nextUrl === acceptedUrl) {
      return;
    }
    let decision: "adopt" | "defer" | "reject";
    try {
      decision = options.decideChange?.(acceptedUrl, nextUrl) ?? "reject";
    } catch {
      decision = "reject";
    }
    if (decision === "adopt") {
      acceptedUrl = nextUrl;
      return;
    }
    if (decision === "reject") {
      stop();
      options.onChanged();
    }
  };
  const observer = new MutationObserver(check);
  observer.observe(options.document, { childList: true, subtree: true });
  options.window.addEventListener("hashchange", check);
  options.window.addEventListener("popstate", check);
  const interval = options.window.setInterval(check, NAVIGATION_POLL_INTERVAL_MS);

  return stop;
}
