# Basic usage

Kady works in a project containing your files, chats and research records.
The tools run on the **BYOK backend host**, which may differ from the device
running your browser.

## Start a task

1. Create or open a project and connect a model in **Settings → Providers**.
2. Select the model, thinking level and compute beside the composer.
3. Supply data and describe the question, study design and expected outputs.
4. Review tool activity, generated files and the notebook as work proceeds.

For example: “Compare treated and control samples in `counts.csv`; genes are
rows. Check the design and QC, save the analysis script, and plot the results.”
Kady can read/write files, execute code, search sources, use enabled skills and
[delegate to specialists](sub-agents.md). It may ask blocking questions through
an inline form. Generated claims and structured result cards still need review.

## Workspace and chats

The file browser is on the left, previews/editors in the center and chat on the
right. Drag dividers to resize or use the header buttons to hide either side.
Click a file to [preview or edit it](file-previews.md).

A project supports up to **10 chat tabs**, each with its own history and model.
They share project files and budget, so concurrent work can affect the same
outputs. Closing a chat tab inside Kady aborts its active turn; browser refresh
or closing the browser only detaches the view. Reopening reconnects while the
backend remains running. Backend restarts end ordinary active turns; saved
history remains available from Chat history.

During a run, **Steer** supplies text guidance and **Follow up** queues a later
message. Images sent mid-run use follow-up rather than steering. The client
queue holds up to five messages. **Stop** ends the current turn.

Paste, drop or select images to send them directly to a vision-capable model.
Other file attachments use sandbox uploads. Sending data to hosted models,
connectors or remote compute can transfer it off the backend host.

Kady can also **generate images** — schematics, pipeline diagrams, graphical
abstracts, or edits of a sandbox image — with an OpenRouter image model (an
OpenRouter key or sign-in is required). Choose the model under **Settings →
Defaults → Image generation**, or name one in chat. Images are saved under
`figures/generated/` unless you name a path, and are never overwritten. Each one
is billed by OpenRouter and counts toward the project cap. Image models draw;
they do not compute, so data plots are made with code. Check generated labels
for spelling before using a figure.

## Workflows

Open the workflow library, choose a template, fill its fields and click
**Run workflow**. It runs in the active chat. A **Needs user data** badge means
the task needs inputs; it does not require a fresh browser upload.

### Workflow data locations

The launch dialog supports combined input sources:

| Location | How to supply it |
|---|---|
| Existing project data | Use the default project file/folder picker. Files become attachments; folders become relative references without enumerating all contents. |
| Browser device | Upload files or folders and wait for completion. Folder structure is retained. |
| Backend host or mounted volume | Enter a host path, one per line. Relative paths refer to the project sandbox; container paths must exist inside the container. |
| Remote storage | Enter an HTTPS URL or storage URI that the host's tools/connectors can access. A URI does not configure credentials. |

Paths and URLs are references for the agent to resolve, not automatically
imported or verified data. The workflow instructs Kady to check access before
analysis, preserve originals and save outputs in the project sandbox. Avoid
secrets and signed URLs in these fields: references persist in chat. A reference
alone does not authorize remote upload.

To expose host data in previews, put or mount it in a visible subdirectory of
`projects/<projectId>/sandbox/` (under `KADY_PROJECTS_ROOT` if overridden).
External paths may be accessible to the agent's shell but are not served by the
sandbox preview API; escaping symlinks are refused. Files placed directly on
disk do not receive upload provenance, and external paths are not automatically
covered by the [raw-data guard](data-guard.md).

## Records, compute and cost

- **Lab Notebook** records authored hypotheses, methods, observations and decisions; see [the notebook guide](lab-notebook.md).
- **Provenance** in a file's preview shows observed execution and file lineage; see [Provenance](provenance.md).
- **Compute** lists durable [Modal jobs](modal-compute.md), their logs, outputs and controls. Background jobs require explicit cancellation and can survive a stopped chat or backend restart.
- **Automation** provides [schedules, missions and specialist controls](automation.md).
- The header cost pill shows session and project usage. Set the project's spend limit in **Settings → General → General & budget**; [billing rules](model-selection.md#billing-and-budgets) determine what counts.
- The host resource pill displays machine CPU/RAM/GPU activity. It does not automatically route tasks to local or remote compute.

## Settings

| Group | Panels |
|---|---|
| Models | Providers, Defaults, Fusion |
| Project | General, Skills, Prompt templates, Specialists, Connectors |
| Workspace | Services, Appearance |

General includes project metadata/budget, agent instructions, raw-data guard and
context compaction, each saved separately. Skills, specialist definitions and
connector edits generally apply to **new chat tabs**; active sessions keep their
loaded configuration. Provider credentials and local server addresses apply live.
