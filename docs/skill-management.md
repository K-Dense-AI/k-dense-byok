# Skill management

Skills are `SKILL.md` instructions with optional supporting files. Manage them
in **Settings → Skills**: enable, install, write, edit or remove them.

## Scope and updates

| Scope | Location |
|---|---|
| This project | `projects/<id>/sandbox/.pi/skills/` |
| All projects | `~/.kady/pi-agent/skills/` |

The project copy wins on name collisions. Disable moves a skill to the sibling
`skills-disabled/` directory. New chat tabs load changes; live sessions keep
their existing skill set. Global skills also reach specialist processes.

| Origin | Update policy |
|---|---|
| K-Dense catalogue | Sync at launch and daily, or **Sync catalogue**. Untouched skills update; local edits are preserved and flagged; upstream removals are archived. |
| Installed source | No automatic updates. Check the source with refresh, then choose **Use upstream** to accept changes. |
| Local | No upstream update. |

## Install, write and remove

**Add → Look up** fetches a source into staging. Select skills, review the trust
acknowledgement and install the exact staged content. Sources can be repository
shorthand (`owner/repo`), Git URLs, a repository skill URL or a host-local path;
an optional branch/tag selects the ref. Explicitly selected skills install enabled.

**New skill** creates a template. Names use lowercase letters, digits and single
hyphens. Edit any skill's `SKILL.md` with the pencil; catalogue sync preserves
customizations. The description is what the model uses to decide relevance.

**User-invoked only** sets `disable-model-invocation: true`, removes the skill
from automatic discovery and exposes `/skill:<name>` in the slash menu.
See [Prompt templates](prompt-templates.md).

Removing an installed/local skill deletes it. Catalogue removals are archived
and recorded so sync does not reinstall them; **Use upstream** restores them.
Skills are executable instructions for an agent with shell access; installation
acknowledgement is not a content audit. See [the trust boundary](limitations.md#local-shell-trust-boundary).

## Configuration and implementation

| Variable | Effect |
|---|---|
| `KADY_SKILLS_AUTO_SYNC` | `0` disables automatic catalogue sync. |
| `KADY_SKILLS_REPO` / `KADY_SKILLS_BRANCH` | Catalogue source; defaults to `K-Dense-AI/scientific-agent-skills`, `main`. |
| `KADY_SKILLS_SYNC_INTERVAL_MS` | Default 24 hours; minimum 60 seconds. |
| `KADY_SKILLS_CACHE_DIR` | Staging cache; default `~/.kady/skills-cache`. |
| `KADY_PI_AGENT_DIR` | Shared Pi directory, including global skills. |

[`skills-fetch.ts`](../server/src/agent/skills-fetch.ts) uses the bundled `skills`
CLI only for staging; [`skills-sync.ts`](../server/src/agent/skills-sync.ts)
handles live replacement and local-edit preservation. The staged tree and lock
metadata, not CLI output, determine installed content. Catalogue seeding can
fall back to a shallow clone. Origin/removal state lives in
`.kady/skills-sync.json`; global state in the Pi directory's `kady-skills/`.
