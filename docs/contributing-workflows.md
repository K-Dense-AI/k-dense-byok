# Contributing Workflows

The workflow library lives in a single JSON file at `web/src/data/workflows.json`. Adding or improving a workflow is one of the easiest ways to contribute to the project - no backend code required.

## Workflow structure

Each workflow is a JSON object with these fields:

```json
{
  "id": "unique-kebab-case-id",
  "name": "Human-Readable Name",
  "description": "One-sentence summary shown on the card",
  "category": "genomics",
  "icon": "Dna",
  "prompt": "Detailed instructions with {placeholder} syntax for user variables",
  "placeholders": [
    { "key": "placeholder", "label": "What to ask the user", "required": true }
  ],
  "requiresFiles": true
}
```

Set `requiresFiles` to `true` when the workflow needs user-supplied data (datasets, manuscripts, images, etc.). These workflows display a "Needs user data" badge. This describes the task's inputs, not how they must be transferred. Every launch dialog accepts uploads from the browser device, existing project files, and host paths or data URLs; inputs can be combined. An upload is never a prerequisite when the data is already accessible to BYOK.

The launcher adds shared data-access guidance from `web/src/lib/workflow-inputs.ts`: tools run on the BYOK host, inputs must be checked before analysis, originals stay unchanged, and outputs go into the project sandbox for preview/download. Host paths and URLs are references for the agent to resolve using available tools and configured access; the form does not import or verify them itself. Existing project files are passed as chat attachments without re-uploading their bytes. See [workflow data locations](./basic-usage.md#workflow-data-locations) for deployment examples.

## How to add a workflow

1. Open `web/src/data/workflows.json`.
2. Add your workflow object anywhere in the array (it will be grouped by `category` automatically).
3. Pick a `category` from the existing 22 disciplines:

   `paper`, `visual`, `data`, `literature`, `grants`, `scicomm`, `genomics`, `proteomics`, `cellbio`, `chemistry`, `drugdiscovery`, `physics`, `materials`, `clinical`, `neuro`, `ecology`, `finance`, `social`, `math`, `ml`, `engineering`, `astro`

   Or propose a new one.
4. Choose an `icon` name from [Lucide Icons](https://lucide.dev/icons/) (PascalCase, no "Icon" suffix - e.g. `FlaskConical`, `Brain`, `Dna`). If the icon isn't already imported in `workflows-panel.tsx`, add it there too.
5. Use `{placeholder}` syntax in the prompt for any variable the user should fill in, and add a matching entry in `placeholders`.

## Tips for high-quality workflows

- Write prompts with **numbered steps** so the agent follows a clear procedure.
- **Do not name skills.** The agent discovers and loads the skills it needs from what is installed; a hard-coded name can point at a skill the user has disabled or removed.
- Mark placeholders as `"required": true` only when the workflow genuinely can't run without them.
- Say **supplied data/files**, not "uploaded data": BYOK can run on a workstation, server, VM, or container separate from the browser. "Local" compute means the BYOK host; never assume it is the user's laptop. Avoid hard-coded laptop paths or an exclusive `user_data/` lookup.
- Keep descriptions under ~120 characters so they display well on the card.

Submit your addition as a pull request. We review and merge workflow contributions quickly.
