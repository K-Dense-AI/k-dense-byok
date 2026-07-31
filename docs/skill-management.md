# Skill management

Skills are markdown instruction sets (`SKILL.md` + optional supporting files)
that the agent activates when a task matches their description. Kady ships the
[K-Dense scientific catalogue](https://github.com/K-Dense-AI/scientific-agent-skills)
and lets you install skills from anywhere else, write your own, edit them, and
remove them — per project or for every project at once.

Settings → **Skills** (the gear in the header) is the whole surface.

## Where skills live

| Scope | On disk | Who sees it |
|---|---|---|
| This project | `projects/<id>/sandbox/.pi/skills/` | chat tabs and subagents in that project |
| All projects | `~/.kady/pi-agent/skills/` | every project, plus subagent child processes |

Disabling is non-destructive: the skill moves to a sibling `skills-disabled/`
directory, so it stays on disk but disappears from agent discovery. Live chat
tabs keep the skill set they loaded — toggles apply to **new** tabs.

If the same name exists in both scopes, the **project** copy wins. Pi resolves
project skills before user-level ones and skill-name collisions are first-wins,
so the global copy is simply inert; the Skills tab labels this rather than
leaving you guessing.

## Origins, and what "update" means for each

Every skill carries an origin, shown as a badge:

- **K-Dense** — from the shipped catalogue. Synced automatically at launch and
  daily. Sync is non-destructive: an untouched skill is updated in place, a
  skill you edited is preserved and flagged for review, and a skill removed
  upstream is archived to `.pi/skills-archived/`.
- **Installed** — fetched from a source you named. **Never auto-updated.** A
  third-party skill is instructions the agent will follow, so a new version
  waits behind a badge until you ask for it. Use the refresh button on the row
  to check its source, then *Use upstream* to take the change.
- **Local** — written here. No upstream, nothing to update.

## Installing from a source

**Add** → paste a source → **Look up** → tick the skills you want → confirm the
trust checkbox → **Install**.

Sources are resolved by the [`skills` CLI](https://github.com/vercel-labs/skills),
so anything it understands works:

```
owner/repo                                           GitHub shorthand
https://github.com/owner/repo                         full URL
https://github.com/owner/repo/tree/main/skills/one    one skill in a repo
https://gitlab.com/org/repo                           GitLab
git@github.com:owner/repo.git                         any git URL
./my-local-skills                                     a local path
```

An optional branch/tag field pins a ref.

"Look up" downloads the source to a staging cache and reads the real parsed
names and descriptions out of it, so the picker shows what you are actually
getting rather than what a README claims. The install then copies exactly the
trees you reviewed. Skills you pick install **enabled** — you asked for them by
name.

The trust checkbox is enforced by the server, not just the dialog: skills run
with the agent's full permissions, and an install is the moment third-party
instructions enter the loop. Review a source you do not know before installing
it, and see [limitations.md](limitations.md) for the local trust boundary.

## Writing and editing

**New skill** creates a `SKILL.md` from a template and opens it for editing. Names
follow Pi's rule: lowercase letters, digits and single hyphens (`rna-seq-qc`).

The pencil on any row edits its `SKILL.md` in place, whatever the origin. Editing
a catalogue skill is expected and safe — the daily sync preserves local edits and
marks the skill *Customized*, offering *Use upstream* if you later want the
catalogue's version back.

The `description` is what the model matches against when deciding whether to
activate a skill, so it earns more care than the body.

## Removing

- **Installed** and **Local** skills are deleted.
- **K-Dense** skills are moved to `.pi/skills-archived/` and tombstoned in the
  project manifest, so the next catalogue sync does not reinstall them. Without
  the tombstone the deletion would silently undo itself the following day. Taking
  the upstream copy again (*Use upstream*) clears the tombstone.

## How it works

`server/src/agent/skills-fetch.ts` wraps the bundled `skills` CLI as a pure
**fetcher**: it downloads into a disposable staging cache
(`~/.kady/skills-cache/`, override with `KADY_SKILLS_CACHE_DIR`) laid out as
`.pi/skills/<name>/`, which is the directory shape Pi discovers. Nothing else
about the CLI is trusted — its human-readable output is never parsed; the staged
directory and its `skills-lock.json` are the record.

`server/src/agent/skills-sync.ts` stays the **only writer** of live skill
directories, installing from staging with an atomic replace. That split is what
lets the catalogue and user-installed skills share one fetch mechanism while
keeping the tested sync semantics: tree hashing to detect local edits, the
default-disabled policy for package-reference skills, atomic per-skill
replacement, and archive-on-upstream-removal. Because the CLI only ever writes
to staging, where nothing is user-edited, its update rules cannot collide with
ours.

`server/src/agent/skills-install.ts` decides *what* happens — scope, names,
provenance, tombstones — and `server/src/api/skills.ts` exposes it.

Per-project state lives in `sandbox/.kady/skills-sync.json` (manifest v2:
per-skill origin and source, the catalogue content digest, and the `removed`
tombstones); user-level state in `~/.kady/pi-agent/kady-skills/`.

If the CLI is missing or fails, catalogue seeding falls back to a shallow `git
clone`, so a broken CLI cannot leave a new project with no skills.

## Configuration

| Variable | Effect |
|---|---|
| `KADY_SKILLS_REPO` | catalogue repo (default `K-Dense-AI/scientific-agent-skills`) |
| `KADY_SKILLS_BRANCH` | catalogue branch (default `main`) |
| `KADY_SKILLS_SYNC_INTERVAL_MS` | catalogue sync cadence (default 24h, minimum 60s) |
| `KADY_SKILLS_CACHE_DIR` | staging cache location |
| `KADY_PI_AGENT_DIR` | relocates the user-level skill root along with the agent dir |

Download limits come from the CLI: 10 MiB per download, 25 MiB extracted, 1000
files. Raise them with `SKILLS_DOWNLOAD_MAX_BYTES`, `SKILLS_EXTRACT_MAX_BYTES`
and `SKILLS_EXTRACT_MAX_FILES` for a source you trust.
