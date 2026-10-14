# reMarkable Preview

Preview a local `.rmdoc` in a first-class, read-only VS Code editor. The extension renders through `reMder-client`, caches the resulting PDF, and displays it with a bundled local PDF.js viewer; cache filenames stay an implementation detail.

## Requirements

Install and start [reMder](https://git.mal.tc/reMder/about/) on the machine that hosts the VS Code workspace. The current upstream CLI is positional:

```text
reMder-client input.rmdoc output.pdf
```

Set `remarkablePreview.remderPath` when `reMder-client` is not on `PATH`. This is a machine-scoped setting. In Remote SSH, Dev Containers, WSL, and Codespaces, install reMder and configure the setting on the remote machine.

## Commands

- **reMarkable: Open Preview**
- **reMarkable: Open Preview to the Side**
- **reMarkable: Refresh Preview**
- **reMarkable: Export Rendered PDF**

Export renders the current source (reusing the cache when it is still valid) and copies the resulting PDF to a location you choose; the cached file itself stays an implementation detail.

The extension also contributes **reMarkable Preview** to **Open With...** for `.rmdoc` files. Each preview remains identified by its source `.rmdoc` tab, including in multiple editor groups. Refresh rerenders the existing preview in place. Open previews are watched; when their source stabilizes after a change, the existing webview updates only when its actual content hash changed — a rerender that lands on identical pages leaves the viewer untouched rather than reloading it, so reading a document on the tablet never disturbs an open preview. Opening a second view of a document already being previewed hands it the current render directly, without putting the first view through a reload.

Watchers are unreliable on some hosts, so previews also poll their source. Polling follows visibility: it stops for a preview whose tab is not on top, and catches up once when the tab comes back.

The preview is PDF.js's viewer component with no chrome of its own: pages scroll in a plain vertical run, links are clickable, text is selectable and searchable with the editor's find command, and only the pages near the viewport are rendered. Pinch or `Ctrl`+scroll to zoom. Each preview remembers its page, scroll offset, and zoom per document, including across restarts.

The preview uses a restrictive webview policy: PDF.js and its worker are bundled with the extension, resources are exposed through VS Code webview URIs, and no network/CDN resources are used. In Remote SSH and similar windows the source, renderer, and cache remain on the remote extension host; VS Code transports the webview resources to the local UI.

## Cache

PDFs are stored under the extension's `globalStorageUri/render-cache` directory when it is file-backed. VS Code builds that expose virtual extension storage use `$XDG_CACHE_HOME/vscode-remarkable/render-cache` (or `~/.cache/vscode-remarkable/render-cache`) instead. Keys are a canonical hash of the `.rmdoc` bundle and nothing else. The canonical hash covers the page strokes and any imported PDF/EPUB, with zip packing details and the bookkeeping the tablet rewrites as you read — saved zoom and scroll viewport, last-used pen, open timestamps, generated thumbnails — excluded, so reading a document on the device does not invalidate its render. The renderer deliberately does not contribute to the key: `reMder-client` is a generated wrapper script whose bytes change whenever one of its dependencies is rebuilt, so including it discarded the whole cache on days when nothing about rendering had changed. Use **reMarkable: Refresh Preview** to re-render a document after a renderer change that does affect its output. A per-session fingerprint cache avoids rehashing a source when its size and modification time are unchanged; those metadata values are never used as the render cache key. Rendering writes `<key>.pdf.tmp` and atomically renames it only after successful completion.

By default, the extension discovers `.rmdoc` files in the current workspace and warms missing cache entries one at a time in the background. New and changed files are queued automatically. Background failures are written to the output channel and do not interrupt editing; set `remarkablePreview.prewarmCache` to `false` to disable this behavior for a workspace.

A render that does not finish within `remarkablePreview.renderTimeoutSeconds` is stopped. Renders against one reMder instance run one at a time, so without a limit a client that never returns would hold up every other document and could not be refreshed out of.

Unused cache files are cleaned conservatively after activation and successful renders. The oldest entries are removed first, while active previews and in-flight renders are retained. Cleanup failure never blocks a preview. Because the cache directory is shared by every window of the same VS Code install, scratch left by a killed render is only collected once it has sat untouched for far longer than any render may take — a window cannot tell a peer's render in progress from rubble, and deleting its partial PDF would fail a render that was doing nothing wrong.

## Configuration

- `remarkablePreview.remderPath` — command or absolute path for `reMder-client` (machine scope).
- `remarkablePreview.backgroundRemderPath` — optional client connected to a separate reMder instance for background cache warming. The separate instance must use isolated VM state and ports; when unset, background and foreground rendering share the primary instance serially.
- `remarkablePreview.renderTimeoutSeconds` — how long one `reMder-client` run may take before it is stopped; default `300`, clamped to 10–3600.
- `remarkablePreview.autoRefresh` — refresh active previews after source changes; default `true`.
- `remarkablePreview.prewarmCache` — cache workspace previews in the background; default `true`.
- `remarkablePreview.cacheMaxSizeMB` — maximum unused PDF cache size; default `500` MB.

Diagnostics are recorded in the **reMarkable Preview** Output channel. In Remote SSH and similar remote windows, the workspace extension host reads the source, runs reMder, watches the source, and stores the cache on the remote host.

## VS Code API choices

This extension uses `CustomReadonlyEditorProvider` and the `customEditors` contribution for a binary, read-only `.rmdoc` preview. It also uses `workspace.fs.readFile`, `ExtensionContext.globalStorageUri`, resource-scoped configuration, and `workspace.createFileSystemWatcher`. `retainContextWhenHidden` preserves the viewer's in-webview scroll position across temporary tab switches.

The extension declares `extensionKind: ["workspace"]`, so its child process, source path, and extension storage all live together on the local or remote workspace host. It does not implement synchronization, remote filesystems, authentication, `.rm` parsing, or PDF rendering.

## Development

Enter the Nix development shell to make Node.js, npm, `reMder-client`, and `reMder-server` available:

```text
nix develop
```

Start the renderer service in a separate terminal before exercising a real preview:

```text
reMder-server
```

Then install dependencies and run the extension checks:

```text
npm install
npm test
npm run compile
```
