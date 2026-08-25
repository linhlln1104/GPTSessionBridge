# Windows IPC helper

This helper owns the Windows named-pipe boundary between the bridge and Native
Messaging host. It has two one-shot modes:

```text
gptsessionbridge-windows-ipc server
gptsessionbridge-windows-ipc client
```

The endpoint name is derived internally from the current Windows logon SID. It
is never accepted from the command line, environment, registry, or a file. The
server uses a protected logon-SID DACL, rejects remote clients, requests the
first and only pipe instance, and verifies the peer PID, session, user SID, and
logon SID before relaying data. The client performs the symmetric server checks.
An unconnected server exits after 30 seconds with `connection_timeout`, bounding
the lifetime of an orphan if its parent terminates unexpectedly. The bridge may
then start a new listener serially; listeners must never overlap.

The server writes `ipc_listening` after it has acquired the single pipe instance.
After verification each side writes the fixed line `ipc_connected` to stderr.
Standard output remains reserved for 4-byte little-endian length-framed data.
Frames are relayed with backpressure and a 1 MiB payload ceiling; application
payloads and endpoint details are never logged.

This boundary does not claim to protect a compromised process already running
inside the same Windows logon session, or an administrator or SYSTEM process.
