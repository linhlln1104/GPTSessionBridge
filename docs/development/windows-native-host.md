# Windows Native Host development setup

This workflow installs only the unsigned development identity. It does not install a Chrome extension automatically, edit a Chrome profile, read a browser session, or contact ChatGPT Web.

## Prerequisites

- Windows x64
- Node.js 24.18.1 with Corepack
- .NET SDK 10.0.301
- Google Chrome when manually testing the unpacked extension

Install dependencies and verify the repository first:

```shell
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

On Windows, verification builds a Node single-executable Native Host, publishes the self-contained IPC helper, hashes the complete artifact, and runs a bidirectional packaged-relay smoke test. It does not modify HKCU during verification.

## Install the development host

```shell
corepack pnpm native-host:install
```

The command rebuilds and verifies the package, copies it into a content-addressed directory below the current user's local application data, materializes an absolute Chrome Native Messaging manifest, and registers that manifest under the fixed development-only host name:

```text
com.gptsessionbridge.native_host.dev
```

Setup queries both of the current user's Chrome Native Messaging registry views because Chrome checks 32-bit first and then 64-bit. It refuses foreign or inconsistent values, reconciles the lower-precedence 64-bit view first and the Chrome-effective 32-bit view second, and then verifies the final snapshot. On supported Windows versions, `HKCU\Software` is shared across WOW64 views, so the first exact-path change may satisfy both queries; setup accepts that safe convergence without accepting a different path. No administrator privileges are required.

These `reg.exe` operations are not an atomic transaction. If setup detects a concurrent or uncertain change, it fails closed; it removes private staging but retains every promoted content-addressed artifact because another installer may already have adopted that path. It does not infer ownership from a matching path. Code already running as the same user can still mutate HKCU and is outside this unsigned development boundary.

Registry output decoding supports ASCII, UTF-8, and UTF-16LE. If Windows emits a non-ASCII path through an unsupported legacy console code page, setup fails closed instead of guessing the registered path.

The command prints one JSON object. Use its `extensionPath` value when loading the extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select the exact `extensionPath` returned by setup.

The public development manifest key keeps the unpacked extension ID stable. A future Chrome Web Store build must use a different release identity and a separately signed production installer.

## Inspect or remove registration

```shell
corepack pnpm native-host:status
corepack pnpm native-host:uninstall
```

`status` reports `installed` only when both registry queries name the same verified managed manifest; absent, partial, conflicting, or foreign state is reported separately. `uninstall` verifies both views, clears 64-bit first, clears 32-bit only if it remains, and finally verifies both absent. Content-addressed package files are deliberately retained so an interrupted uninstall cannot delete a loaded unpacked extension or ambiguous files; they contain only build artifacts, not browser credentials, prompts, responses, or profiles.

Remove the unpacked extension from Chrome separately. The setup command never closes Chrome or changes extension state on the user's behalf.

## Current limit

A successful Native Host installation proves only the local Chrome-to-bridge transport boundary. To exercise the Phase 4 adapter manually, open a fresh `https://chatgpt.com/` surface with no transcript, press Connect in the unpacked extension, and refresh the Codex model list. Only `Web · …` models discovered from that selected document are advertised. The observed nested picker currently requires the English accessible submenu name `Model`; localized variants are not certified. The provider accepts only the documented plain-text subset, so normal Codex coding requests carrying developer instructions or tool definitions fail closed. Do not use a real account or submit account/source content during development unless that test is explicitly authorized; automated verification uses synthetic DOM and does not contact ChatGPT.

The generated artifact is for local development and is not a redistributable release bundle. Signing, protected installation, release identities, and a complete third-party license inventory remain release gates.

Chrome's lookup order and manifest requirements are documented in [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). Microsoft's [WOW64 registry-key table](https://learn.microsoft.com/windows/win32/winprog64/shared-registry-keys) documents `HKEY_CURRENT_USER\SOFTWARE` as shared on Windows 7 and newer.
