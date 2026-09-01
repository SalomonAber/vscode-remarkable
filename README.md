# reMarkable Preview

Preview a local `.rmdoc` by rendering it with `reMder-client` and opening the cached PDF in VS Code's normal PDF editor.

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

The commands are available from the Command Palette and from Explorer and editor menus for `.rmdoc` files. Refresh bypasses the selected document's current cache entry.

## Cache

PDFs are stored under the extension's `globalStorageUri/render-cache` directory when it is file-backed. VS Code builds that expose virtual extension storage use `$XDG_CACHE_HOME/vscode-remarkable/render-cache` (or `~/.cache/vscode-remarkable/render-cache`) instead. Keys include the complete `.rmdoc` contents, the renderer executable identity, and render-affecting settings. When the executable can be resolved, its bytes are hashed because the current `reMder-client` has no version flag. Rendering writes `<key>.pdf.tmp` and atomically renames it only after successful completion.

## VS Code API choices

This extension uses current stable APIs: `commands.registerCommand` with `contributes.commands` and resource-filtered `contributes.menus`; `workspace.fs.readFile`; `ExtensionContext.globalStorageUri`; resource-scoped `workspace.getConfiguration`; and the built-in `vscode.open` command with `ViewColumn.Beside`. A future watcher should use `workspace.createFileSystemWatcher` rather than Node filesystem watching.

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
