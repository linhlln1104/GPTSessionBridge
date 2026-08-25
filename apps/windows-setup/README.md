# Windows development setup

This private workspace app installs a verified Windows x64 development package for the current user. It rejects other operating systems and architectures, never requests administrator rights, and never accepts credentials or browser session data.

## Registry-view policy

Chrome can resolve the 32-bit `NativeMessagingHosts` registry view before the 64-bit view. Setup therefore treats both HKCU views as one security decision:

- Install inspects both views and refuses any value it cannot prove belongs to a verified package under the managed LocalAppData root.
- It reconciles the lower-priority 64-bit view first and the Chrome-effective 32-bit view second, then re-reads both. On supported Windows versions, `HKCU\Software` is shared and the first exact-path write may satisfy both views. Success still requires both queries to reference the same generated manifest.
- Status reports `installed` only when both views reference that same owned and verified manifest. A missing, conflicting, invalid, or foreign view is reported as `unmanaged` with a reason.
- Uninstall verifies both views before mutation, clears 64-bit first, verifies that it remains absent, clears 32-bit only if it still exists, and finally requires both queries to be absent. It refuses to expose a foreign lower-priority entry.

`reg.exe` has no atomic conditional-write operation. The adapter performs explicit precondition and post-write checks and fails closed on races it observes. Private staging is removed on failure, but every promoted content-addressed package or registration is retained; this prevents one concurrent installer from deleting a path already adopted by another successful installer.

Registry commands use an explicit `/reg:32` or `/reg:64` switch. Their parsed output accepts ASCII/UTF-8 and UTF-16LE. Undecodable legacy-console output fails closed, so non-ASCII LocalAppData paths on legacy code pages are not currently claimed as supported.

## Package verification

`package-manifest.json` is canonical JSON containing the exact file list, sizes, and SHA-256 hashes. Verification bounds manifest bytes, directory entries, file count, and total artifact size; it rejects unlisted files, non-canonical manifests, path traversal, Windows case collisions, symlinks, junctions, and content changes. Installation additionally validates the fixed development Native Messaging identity, host/helper layout, manifest template, complete Manifest V3 policy, and required extension runtime entrypoints.

Uninstall removes registry entries only. Content-addressed package and registration files remain for conservative recovery and inspection.
