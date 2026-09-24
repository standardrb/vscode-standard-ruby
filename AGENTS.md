# Agent guide

## Repository shape

This repo builds the Standard Ruby VS Code extension. Keep work centered on the files that own the behavior:

- `src/extension.ts` owns activation, command registration, Standard command discovery, language-client setup, formatting guards, document sync, and the status bar.
- `src/test/suite/` holds Mocha tests that exercise exported helpers and extension behavior through the VS Code test host.
- `package.json` is the source of truth for scripts, contributed commands, settings, activation events, dependency versions, and extension metadata.
- `README.md` is user-facing extension documentation. Update it when settings or visible behavior change.
- `out/`, `node_modules/`, and `.vscode-test/` are generated or installed artifacts. Leave them out of hand edits.

## Work loop

1. Read `package.json` before changing commands, settings, activation events, or release metadata.
2. Add or update tests with code changes. Prefer focused unit coverage in `src/test/suite/index.test.ts` when changing exported helpers or middleware behavior.
3. Keep extension behavior and package contributions aligned: if a setting changes in `package.json`, update the code that reads it and the README that explains it.
4. Preserve VS Code extension constraints. Tests may run inside an Electron host, and full `yarn test` can need a GUI/Xvfb-capable environment.

## Checks

Use the scripts in `package.json` as the command source of truth:

- `yarn lint` for TypeScript style. It runs `ts-standard --fix`, so review edits after it runs.
- `yarn test-compile` for TypeScript compile checks across source and tests.
- `yarn compile` when you need bundled extension output in `out/`.
- `yarn test` for the VS Code integration suite after compiling tests; make `standardrb` available first when the environment does not already have it.

## Design seams

- Language support flows through `normalizeAdditionalLanguages`, `formattingSupportedDocument`, `diagnosticsSupportedDocument`, and `buildDocumentSelector`.
- Standard executable selection flows through mode checks, Bundler detection, `standardRuby.commandPath`, and version validation before `buildExecutable` creates the language-server command.
- Formatting is gated in `buildLanguageClientOptions().middleware.provideDocumentFormattingEdits`; preserve the autofix and file-scheme rules there.
- Lifecycle commands (`start`, `stop`, `restart`) update the shared `languageClient`, output channel, document sync, and status bar together.
- Status text is user-visible. Treat changes there as UX changes and cover them with tests when practical.

## Style

- Follow existing TypeScript style: single quotes, no semicolons, explicit return types on functions, and `async`/`await` over promise chains.
- Keep comments for invariants or VS Code/LSP edge cases. Let names and tests carry routine control flow.
- Prefer small exported pure helpers for behavior that needs focused tests; keep VS Code side effects behind the extension lifecycle functions.
