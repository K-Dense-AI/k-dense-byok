# K-Dense BYOK for VS Code

K-Dense BYOK for VS Code brings the first v1 extension surface into the editor. It adds a workspace-scoped **Kady Chat** sidebar and an explicit **Kady Preview** flow for supported research files without replacing normal VS Code editing.

## What ships in v1

- **Kady Chat sidebar** in the activity bar, with typed webview bootstrapping and persisted sidebar state.
- **Explicit Kady Preview** entry points from the explorer and editor title for supported files.
- **Native editing stays native**. Files still open in the standard text editor by default. Kady Preview is opt-in and read-only.
- **Workspace trust awareness**. Restricted Mode keeps browsing and explicit preview available while write, execution, backend start, and secret-sensitive flows stay blocked until the workspace is trusted.
- **Host-owned backend status plumbing** for the current preview build, including startup state reporting from the extension host.
- **Repo bootstrap parity for backend startup**. Trusted backend actions stay host-owned, but the extension now splits the repo lifecycle into workspace initialization (`./initialize_kdense_workspace.sh` → `prep_sandbox.py`) and backend-only runtime start (`./start_kdense_backend.sh`). It verifies the prepared sandbox runtime (`sandbox/.venv`, `sandbox/.gemini/settings.json`, `sandbox/.gemini/skills`) before treating the sidebar/backend path as ready.

## Supported preview formats in this v1 package

- Markdown and related extensions
- LaTeX sources
- CSV and TSV data files
- FASTA and FASTQ sequence files
- VCF, GFF, GFF3, BED, SAM, and BCF bioinformatics formats

Kady Preview focuses on rich inspection for these files, including rendered Markdown, math, Mermaid, and format-aware summaries where appropriate.

## Packaging notes

This VSIX intentionally ships only the runtime assets required by the extension:

- bundled files in `dist/`
- extension media in `media/`
- manifest and localization metadata
- this README and the license file

Development sources, tests, build scripts, config files, dependency trees, and source maps stay out of the packaged extension.

## Package locally

From `vscode-extension/`:

```bash
npm ci
npm run package:vsix
```

The command writes `kdense-vscode-extension.vsix` in the same folder.

## Install locally

Use **Extensions: Install from VSIX...** in VS Code, or run:

```bash
code --install-extension kdense-vscode-extension.vsix
```
