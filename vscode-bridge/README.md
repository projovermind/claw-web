# Claw Web Bridge (VS Code extension)

Push the current editor state — open files, active file, selection, cursor — from VS Code to a running Claw Web instance so the agents can see what you're working on.

## Install (dev)

```bash
cd vscode-bridge
npm install
npm run compile
```

Then in VS Code: **Extensions → "..." menu → Install from VSIX...** after packaging with `vsce package`, or open this folder in VS Code and press **F5** to launch an Extension Development Host for local testing.

## Configure

- `clawWebBridge.endpoint` — base URL of the Claw Web server (default `http://localhost:3838`).
- `clawWebBridge.authToken` — bearer token if the server has auth enabled.
- `clawWebBridge.enabled` — toggle the bridge on/off.
- `clawWebBridge.throttleMs` — minimum interval between pushes (default 800 ms).
- `clawWebBridge.includeSelectionText` — include the selected text (up to 64 KB) with each push.

## Commands

- `Claw Web: Push editor state now` — manual push.
- `Claw Web: Toggle bridge on/off`.

## Server endpoint

The extension POSTs to `/api/bridge/context`. GET the same path to inspect the most recently reported state for each workspace (5-minute TTL — stale data is dropped).
