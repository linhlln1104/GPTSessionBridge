import { installServiceWorker } from "./service-worker-runtime.js";
import { readChromeApi } from "../platform/chrome-api.js";

installServiceWorker(readChromeApi());
