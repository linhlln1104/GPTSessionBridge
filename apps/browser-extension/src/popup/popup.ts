import { readChromeApi } from "../platform/chrome-api.js";
import { installPopupController } from "./popup-controller.js";

installPopupController({
  document,
  now: () => Date.now(),
  runtime: readChromeApi().runtime,
  scheduleRefresh: (callback, intervalMs) => {
    const handle = globalThis.setInterval(callback, intervalMs);
    return () => {
      globalThis.clearInterval(handle);
    };
  },
});
