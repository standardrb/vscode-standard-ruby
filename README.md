# vscode-standard-ruby

This is the official VS Code extension for [Standard
Ruby](https://github.com/testdouble/standard), maintained by your friends at
[Test Double](https://testdouble.com)

You can install Standard Ruby from the [Visual Studio
Marketplace](https://marketplace.visualstudio.com/items?itemName=testdouble.vscode-standard-ruby).

## Language Server Capabilities

These are the capabilities of this extension, each enabled by Standard's [built-in LSP server](https://github.com/testdouble/standard#language-server-protocol-support):

| Capability  | Support |
| ------------- | ------------- |
| Diagnostics (Linting) | ✅ |
| Document Formatting  | ✅ |
| Execute Command ([Trigger autofix](https://github.com/testdouble/vscode-standard-ruby#manually-triggering-a-format-with-automatic-fixes)) | ✅ |
| Everything else  | ❌  |

## Requirements

* Version 1.24.3 of the [standard
gem](https://rubygems.org/gems/standard)
* Version 1.75.0 of [VS Code](https://code.visualstudio.com) or higher

## Configuration

The extension only offers a few of its own configuration options, but because it
conforms to the [VS Code Formatting
API](https://code.visualstudio.com/blogs/2016/11/15/formatters-best-practices#_the-formatting-api),
several general editor settings can impact the extension's behavior as well.

## Configuring the VS Code editor to use Standard Ruby

There are two general editor settings that you'll want to verify are set in
order to use Standard Ruby as your formatter.

### editor.formatOnSave

To automatically format your Ruby with Standard Ruby, check **Format on Save** in the
**Formatting** settings under **Text Editor**:

![Format a file on save. A formatter must be available, the file must not be saved after delay, and the editor must not be shutting down.](/docs/format-on-save.png)

Or, in `settings.json`:

```json
"editor.formatOnSave": true,
```

### editor.defaultFormatter

Next, if you have installed multiple extensions that provide formatting for Ruby
files (it's okay if you're not sure—it can be hard to tell), you can specify
Standard as your formatter of choice by setting `editor.defaultFormatter` under
a `"[ruby]"` section of `settings.json` like this:

```json
"[ruby]": {
  "editor.defaultFormatter": "testdouble.vscode-standard-ruby"
},
```

## Configuring Standard Ruby extension options

To edit Standard Ruby's own options, first expand **Extensions** and select
**Standard Ruby** from the sidebar of the Settings editor.

### standardRuby.mode

The Mode setting determines how (and whether) Standard Ruby runs in a given
workspace. Generally, it will try to execute `standardrb` via `bundle exec` if
possible, and fall back on searching for a global `standardrb` bin in your
`PATH`.

![Enable Standard Ruby via the workspace's Gemfile or else fall back on a global installation unless a Gemfile is present and its bundle does not include standard](/docs/mode.png)

* _"Always run—whether via Bundler or globally"_ (JSON: `enableUnconditionally`)
  this mode will first attempt to run via Bundler, but if that fails for any
  reason, it will attempt to run `standardrb` in your PATH
* **[Default]** _"Run unless the bundle excludes standard"_ (JSON:
  `enableViaGemfileOrMissingGemfile`) this mode will attempt to run Standard via
  Bundler, but if a bundle exists and the `standard` gem isn't in it (i.e. you're
  working in a project doesn't use Standard), the extension will disable itself.
  If, however, no bundle is present in the workspace, it will fall back on the
  first `standardrb` executable in your PATH
* _"Run only via Bundler, never globally"_ (JSON: `enableViaGemfile`) the same as
  the default `enableViaGemfileOrMissingGemfile`, but will never run
  `standardrb` from your PATH (as a result, single-file windows and workspace
  folders without a Gemfile may never activate the extension)
* _"Run only globally, never via Bundler"_ (JSON: `onlyRunGlobally`) if you want
  to avoid running the bundled version of Standard, this mode will never
  interact with Bundler and will only run `standardrb` on your PATH
* _"Disable the extension"_ (JSON: `disable`) disable the extension entirely

Or, in `settings.json`:

```json
"standardRuby.mode": "enableViaGemfile",
```

### standardRuby.autofix

The auto-fix option does what it says on the tin. if you don't want Standard to
automatically edit your documents on save, you can disable it here:

![Autofix](/docs/autofix.png)

You might want to disable this if you're using Standard to highlight problems
but don't want it to edit your files automatically. You could also accomplish
this by disabling `editor.formatOnSave`, but as that's a global setting across
all languages, it's more straightforward to uncheck this extension setting.

Or, in `settings.json`:

```json
"standardRuby.autofix": true,
```

### standardRuby.commandPath

As described above, the extension contains logic to determine which version of
`standardrb` to launch. If you want a specific binary to run instead, you can
set it here.

![Command Path](/docs/command-path.png)

This will override whatever search strategy is set in `standardRuby.mode`
(except for `disable`, in which case the extension will remain disabled).

Or, in `settings.json`:

```json
{
  "standardRuby.commandPath": "${userHome}/.rbenv/shims/standardrb"
}
```

### Changing settings only for a specific project

You may want to apply certain settings to a specific project, which you can do
by configuring them in the [Workspace
scope](https://code.visualstudio.com/docs/getstarted/settings#_workspace-settings)
as opposed to the global User scope.

![Workspace scope](/docs/workspace.png)

Clicking "Workspace" before changing a setting will save it to
`.vscode/settings.json` inside the root workspace directory and will not affect
the extension's behavior in other workspace folders.

## Manually triggering a format with automatic fixes

In addition to the built-in VS Code Formatting API, you can trigger the
extension to format and auto-fix the current file listing by running
the command "Standard Ruby: Format with Automatic Fixes":

![Autofix command](/docs/autofix-command.png)

This is handy if you don't want to enable format-on-save, already have another
formatter associated with Ruby files, want to format your code _before_ saving,
or just want to bind a shortcut to Standard's formatting action.

To map a keybind to the command, search for it by name in the [Keyboard Shortcuts
editor](https://code.visualstudio.com/docs/getstarted/keybindings#_keyboard-shortcuts-editor):

![Keybinding](/docs/keybind.png)

Or, in `keybindings.json`:

```json
[
  {
    "key": "ctrl+alt+cmd+f",
    "command": "standardRuby.formatAutoFixes"
  }
]
```

## Decoding the Status Bar item

The extension also includes a status bar item to convey the status of the
current file listing at a glance.

When the file conforms to Standard without issue:

![Status: no issues](/docs/status-ok.png)

When the file contains a low-severity formatting issue:

![Status: info](/docs/status-info.png)

When the file contains a normal linter error:

![Status: info](/docs/status-warn.png)

When the file fails to parse at all:

![Status: parse failure](/docs/status-parse-fail.png)

Clicking the status bar item will open the problems tab:

![Problems tab](/docs/problems.png)

## Limitations

There's some room for improvement yet, but it isn't yet clear whether these
limitations will be a big deal in practice:

* The extension will only launch a single instance of `standardrb --lsp` per
  workspace. If you're using a [multi-root
  workspace](https://code.visualstudio.com/docs/editor/multi-root-workspaces),
  they'll all be handled by whatever Standard version is found in the first one
* Standard's LSP only supports "Full" [text document
  synchronization](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_synchronization),
  both because it seemed hard to implement incremental sync correctly and
  because attempting to pass RuboCop's runner a partial document would result in
  inconsistent formatting results

## Acknowledgements

This extension's codebase was initially based on [Kevin
Newton](https://github.com/kddnewton)'s
[vscode-syntax-tree](https://github.com/ruby-syntax-tree/vscode-syntax-tree)
extension, which has a similar architecture (VS Code language client
communicating with a long-running Ruby process via STDIO). Thank you, Kevin! 💚

## Code of Conduct

This project follows Test Double's [code of
conduct](https://testdouble.com/code-of-conduct) for all community interactions,
including (but not limited to) one-on-one communications, public posts/comments,
code reviews, pull requests, and GitHub issues. If violations occur, Test Double
will take any action they deem appropriate for the infraction, up to and
including blocking a user from the organization's repositories.
