# Installable distributions

Kady uses a small native Go launcher and private Node, uv, Git, ripgrep and fd runtimes. The
existing Next.js production server and Pi backend run on loopback and open in
the default browser. No global Node/npm/Python installation is needed to launch.

## Build and verify

Build on the target platform and architecture. Install Node 24.21.0 and Go
1.27.1 for the build, then:

```sh
npm ci --prefix server
npm ci --prefix web
npm ci --prefix packaging
npm exec --prefix packaging -- playwright install chromium
npm run dist:build
KADY_SMOKE_BROWSER=1 KADY_SMOKE_HELPERS=1 npm run dist:smoke
npm run dist:installer
```

Linux packaging additionally needs `nfpm` (the workflow installs its pinned
version). Windows needs Inno Setup 6; `ISCC` can override its executable path.
`KADY_GO` and `NFPM` can select build tools outside PATH. Runtime archives are
pinned by URL and SHA-256 in `runtimes.json`, downloaded into `dist/downloads`,
and verified on every build. Changing a runtime requires reviewing that lock.

Outputs are in `dist/<platform>-<arch>/bundle` and `artifacts`. macOS builds a
DMG containing Kady.app; Windows builds a per-user installer; Linux builds DEB,
RPM and a portable archive. The initial matrix is macOS arm64/x64 and Windows
and Linux x64. The Linux CI baseline is Ubuntu 22.04; Alpine/musl is unsupported.

`build.mjs` copies an explicit source allowlist. It transpiles application TS
while retaining `.ts` resource names because Pi dynamically resolves them;
the bundled Node version accepts these JavaScript-only files through its native
TS loader. Production npm dependencies, vendored child extensions, Python helper
scripts and shared frontend protocol modules keep their original relative paths.
Pi patches are applied during staging. Next's standalone server, public files
and static chunks are included. Local `.env`, projects, credentials, virtualenvs,
personal skills and developer dependencies are excluded.

`smoke.mjs` runs with isolated data/auth directories and no developer model keys.
It exercises dynamic ports, real Pi tool execution using a local model stub,
HTTP access controls, production assets, second launch, stop and restart. It
prints the test artifact directory for diagnosis. Unit tests also cover locks,
port conflicts, imports, platform paths and component setup failures.
Set the smoke environment variables with `$env:NAME="1"` in PowerShell.
CI also installs or extracts each installer and exercises its installed payload.
The smoke check interrupts an active model call, verifies its ledger is flushed,
kills the supervisor to exercise orphan cleanup, and reopens from stale state.
Run application tests with `npm test --prefix server` or `npm test --prefix web`.
Root-level Vitest execution is refused because backend tests require their
isolated projects/auth configuration; backend configuration also rejects a test
process using the checkout's real projects directory.

## Runtime and data

| OS | Data and projects | Configuration | Cache |
|---|---|---|---|
| macOS | `~/Library/Application Support/Kady` | Same | `~/Library/Caches/Kady` |
| Windows | `%LOCALAPPDATA%\Kady` | Same | `%LOCALAPPDATA%\Kady\cache` |
| Linux | `$XDG_DATA_HOME/kady` or `~/.local/share/kady` | `$XDG_CONFIG_HOME/kady` or `~/.config/kady` | `$XDG_CACHE_HOME/kady` or `~/.cache/kady` |

`KADY_DATA_DIR`, `KADY_CONFIG_DIR`, `KADY_CACHE_DIR`, and `KADY_PROJECTS_ROOT`
override these defaults. Pi credentials/settings remain in `~/.kady/pi-agent`
to preserve existing logins; explicit `PI_CODING_AGENT_DIR` / `KADY_PI_AGENT_DIR`
remain supported. Credentials saved in Settings use the configuration `.env`.
Never remove these data directories during an upgrade or uninstall.

The launcher keeps a locked per-user instance, owner-only state/token files,
preferred ports with collision fallback, and a startup log. The UI API endpoint
comes from an uncached runtime script, so changing ports does not require a web
rebuild. Streaming retains its separate browser connection pool. The backend
requires a per-launch token even on loopback. Windows uses a kill-on-close job;
Unix shutdown signals owned process groups and observed detached descendants.
Node children additionally monitor the supervisor so orphaned Pi runners exit.

Closing a browser tab leaves the application and schedules running. Settings →
Services offers logs, scientific preview setup, download updates and Stop Kady.
Remote Modal jobs can continue after shutdown and are recovered when reopened.
CLI commands: `kady start`, `stop`, `status`, `logs`, `version`, and
`kady import /path/to/checkout`. On macOS the CLI is inside
`Kady.app/Contents/MacOS/kady`.

Selecting an existing installation uses its projects directory **in place**.
It preserves project IDs, sessions, provenance and budgets without rewriting
them. The source installation must be stopped first. Existing installed-app
credentials win; an old root `.env` is copied only when none exists. This is
also available under Settings → Services and requires reopening Kady.

Python 3.12.14 and scientific packages install on request using bundled uv and
the checked-in helper lockfile. Environments are keyed by that lock in writable
cache storage; partial installs are never reported as ready and can be retried.
Office assets download on first use with the existing hash checks into the user
cache. TeX and user-selected external CLI/MCP programs remain optional tools.
On macOS, the launcher includes the standard Homebrew and MacTeX binary paths
even when started from Finder, which does not load the user's shell startup files.

## Signing and releases

Unsigned development installers are produced on branches. `--require-signing`
or `KADY_RELEASE=1` fails if release signing is unavailable. GitHub's version
workflow calls the distribution workflow directly, waits for every platform's
tests, builds, signing and attestations, then uploads all six installers and
combined checksums to a draft before publishing. It does not depend on a tag
event created by `GITHUB_TOKEN` triggering another workflow.

Configure these repository Actions secrets before the first binary release:

- `MACOS_CERTIFICATE_P12`: base64 Developer ID Application certificate/key.
- `MACOS_CERTIFICATE_PASSWORD`: its export password.
- `MACOS_SIGN_IDENTITY`: the Developer ID Application identity.
- `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`: App Store Connect
  API credentials permitted to submit notarization.
- `WINDOWS_CERTIFICATE_PFX`, `WINDOWS_CERTIFICATE_PASSWORD`: base64 Windows
  Authenticode certificate/key and its password. Hardware/cloud-backed signing
  can instead be integrated at the isolated signing step.

Signing material goes into a temporary runner directory/keychain and is cleaned
up even after failures. macOS signs nested executable code, notarizes and staples
the app, assesses it with Gatekeeper, then signs the DMG. Windows signs the
launcher and installer and verifies Authenticode. Release assets carry GitHub
build-provenance attestations. The app links to the release installer; it does
not replace a running installation automatically. Stop Kady before updating.

The runtime bundle retains dependency licenses. Before public distribution,
review the notices and availability of corresponding sources for redistributed
Git and other dependencies, and validate the actual signed installers on clean
machines. A passing unsigned package test does not establish signing validity.
