# Releasing

Releases are fully automated by the [`Release`
workflow](.github/workflows/release.yml). To cut one:

1. Go to **Actions → Release → Run workflow**.
2. Pick the version bump (`patch`, `minor`, or `major`) and run it.

The workflow lints and compiles, bumps the version in `package.json`, packages
the extension once, and publishes it to both the [Open VSX
Registry](https://open-vsx.org) and the [Visual Studio
Marketplace](https://marketplace.visualstudio.com). After both publishes pass, it
creates the version-bump commit and matching `vX.Y.Z` tag through GitHub's API so
GitHub can mark the bot commit as verified under signed-commit branch rules.

## Required secrets

Both are configured under the repository's Actions secrets:

- `OPEN_VSX_TOKEN` — Open VSX access token.
- `VS_MARKETPLACE_TOKEN` — Azure DevOps personal access token scoped to publish
  under the `testdouble` publisher. See [Get a personal access
  token](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token).
