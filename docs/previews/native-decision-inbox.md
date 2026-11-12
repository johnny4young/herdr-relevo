# Native Decision Inbox preview

The optional preview renders synthetic examples with the installed Herdr/GPUI runtime. It is separate from the [live Inbox](../proposals/decision-inbox.md) and does not connect example cards to operational agents.

Requires the installed signed Herdr app, core and Node.js. From the checkout:

```sh
bash scripts/preview-herdr.sh setup
bash scripts/preview-herdr.sh preflight
bash scripts/preview-herdr.sh check
bash scripts/preview-herdr.sh run
```

In another terminal, use the launcher's seed command for isolated idle terminals, status to inspect the preview, shot for a local capture, and stop to stop only its app/core. Captures and run results must remain local.

The scratch profile has separate HOME, XDG paths, app identity and Unix sockets. The launcher applies a process sandbox and preflight checks before launch. It does not modify installed bundles or replace the user's configuration. Setup refuses a running preview.

Synthetic fixtures demonstrate UI states only: they do not prove tests ran, agents completed tasks or a human approved work. For a disconnected copy of saved workspace metadata, see [snapshot instructions](../../scripts/SNAPSHOT.md).
