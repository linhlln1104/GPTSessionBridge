import { chromium } from "playwright";

const MINIMUM_CHROME_MAJOR = 151;

let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const version = browser.version();
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
  if (!Number.isSafeInteger(major) || major < MINIMUM_CHROME_MAJOR) {
    throw new Error("unsupported_chrome_version");
  }
  process.stdout.write(`Chrome Stable preflight: ${version}\n`);
} catch {
  process.stderr.write(
    `Chrome Stable ${MINIMUM_CHROME_MAJOR} or newer is required for the DOM-runtime gate.\n`,
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
}
