# Native installer validation — 2026-09-30

Branch: `feat/installable-distributions`. Application version: `0.14.2`
(unsigned preview builds; no public release made).

## Coverage

Each distribution job runs backend/frontend tests and typechecks, native launcher
race tests, a production build, and an isolated installed-runtime smoke test.
The smoke test uses a local model fixture through the real Pi SDK, with no
developer credentials or real model spending. It checks:

- Occupied preferred ports remain untouched; both services select available ports.
- API authentication and rejection of an unrelated browser origin.
- Production frontend assets, runtime API discovery, token-fragment removal,
  Settings → Services, and the log viewer in Chromium.
- Second-launch instance reuse, real lead writes, detached specialist writes,
  and Node/npm/uv/Git/ripgrep/fd execution through Pi's shell tool.
- Frozen Python helper installation and decoding an actual NumPy file.
- Graceful shutdown during an active model request, terminal streaming frames,
  and the interrupted run's persisted cost ledger.
- Restart persistence, supervisor-crash cleanup, and recovery from stale state.
- Application paths containing spaces and Unicode; read-only application
  resources on macOS/Linux with all mutable state in isolated user directories.

The installer stage mounts the macOS DMG, silently installs/uninstalls the
Windows installer, or extracts each Linux DEB/RPM/archive, then repeats the
browser/runtime smoke against that payload. Linux package contents are tested
on Ubuntu; this does not constitute an installation test on every RPM distro.

## Local macOS checks

The Apple Silicon DMG was built, mounted and tested successfully. The normal
native app launch also opened Chrome, authenticated without asking for a token,
showed the installed-application controls, and stopped through Settings →
Services → Stop Kady. This used isolated temporary projects and credentials.

The scientific-preview smoke installed the locked Python environment and
decoded a NumPy array, verifying a mean of 3. The local native launcher race
tests and backend/frontend typechecks passed.

## Test isolation and platform regressions

Backend tests must run with `npm test --prefix server` (or from `server/`).
Root-level Vitest configuration refuses test discovery, and backend configuration
rejects a test process without an explicit isolated projects root or one using
the checkout's `projects/`. Regression probes import configuration only.

Cross-platform validation also covers Windows drive/UNC/Git Bash paths in the
raw-data guard, canonical Windows paths in Watchdog's Git scope check, temporary
Windows filesystem locks, and an Intel Mac-compatible RDKit wheel in the frozen
helper lockfile. Async tests wait for completion signals instead of assuming
fixed filesystem timing.

## Release boundary

Apple signing/notarization and Windows Authenticode credentials are not
configured in this repository. Installer builds for a release require them and
fail closed when they are absent; until then, a version bump publishes a
source-only release without installers. Unsigned CI preview artifacts do not establish
Gatekeeper, SmartScreen, or signing validity on clean end-user machines.
See [signing configuration](../../packaging/README.md#signing-and-releases).
