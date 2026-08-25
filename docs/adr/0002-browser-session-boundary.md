# ADR 0002: Keep the ChatGPT Session Inside the User's Browser

- Status: Accepted
- Date: 2026-08-25

## Decision

GPTSessionBridge interacts with a ChatGPT Web session through a Manifest V3 extension attached to a tab selected by the user. It does not embed a login browser, copy a Chrome profile, or extract session credentials.

## Required permissions

The extension may request Native Messaging plus temporary `activeTab` and `scripting` access for the user-selected exact `https://chatgpt.com` document. It must not request persistent host, cookie, debugger, history, storage, broad-host, or profile access.

## Consequences

- Login, logout, CAPTCHA, MFA, and account switching remain visible user actions in Chrome.
- DOM adaptation is isolated, versioned, and expected to require maintenance as the Web UI changes.
- A disconnected or incompatible tab produces an explicit error and never opens another login surface or falls back to a different provider.
- Extension-to-host messages contain application data only; cookies and browser storage are not part of the protocol.
