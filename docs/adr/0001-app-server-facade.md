# ADR 0001: Use a Thin App-Server Facade

- Status: Accepted
- Date: 2026-08-25

## Decision

GPTSessionBridge will run as a thin bidirectional facade in front of the official Codex app-server. It will augment the model catalog and pin a custom local Responses provider only when a Web-backed thread is created. All other protocol traffic will pass through without semantic changes.

## Rationale

This keeps Codex authentication, thread lifecycle, approvals, sandboxing, persistence, and streamed events in the official implementation. Native Codex API traffic does not pass through a general-purpose HTTP proxy owned by GPTSessionBridge.

## Consequences

- The facade must correctly correlate interleaved traffic in both directions.
- Compatibility must be tested against pinned app-server schemas and live smoke transcripts.
- Provider selection is thread-bound; crossing between Codex and Web providers requires a new thread or an explicit handoff design.
- The integration must fail closed if an owned request cannot be routed safely.
