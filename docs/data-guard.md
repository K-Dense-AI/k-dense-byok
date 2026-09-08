# Raw-data guard

Kady runs the agent's tools as your own user, so nothing stops a badly worded
`rm -rf` from deleting the very data you uploaded. The raw-data guard adds a
policy layer in front of the file and shell tools, for Kady itself and for the
background specialists it delegates to.

## What it does

- **Protected paths are read-only for the agent.** By default everything under
  `user_data/` (your uploads). `write`/`edit` into a protected path and shell
  commands that would mutate one (`rm`, `mv`, `cp … into`, `sed -i`, `>`
  redirects, `find … -delete`, `chmod`, `git rm`, …) are refused before they
  run, with a reason that tells the model to copy the data into a working
  folder such as `derived/` and operate on the copy. Reading is unaffected.
- **Destructive commands elsewhere ask first.** `rm -rf <dir>`, `git clean -f`,
  `git reset --hard`, `git checkout -- .`, `find … -delete`, `shred`, `dd`
  pause the run and show a card in the chat with the exact command; you allow
  it once or deny it. No answer within ten minutes, or stopping the run, counts
  as a denial. Routine clean-ups (`.venv`, `node_modules`, `__pycache__`,
  `/tmp`, …) are not flagged.
- **Background specialists** get the same protected-path block from the
  vendored `kady-guard` Pi package. They have no way to ask you, so destructive
  commands are blocked outright with instructions to report back to Kady.

## Configuring it

Edit project → **Raw-data guard**:

- *Protected paths*: one sandbox-relative glob per line (`user_data/**`,
  `raw/*.csv`, `reference`). A plain path protects its whole subtree. Changes
  apply immediately, including to live chats.
- *Ask before destructive shell commands*: turn off to let Kady delete freely
  outside protected paths (protected paths stay protected).

The policy lives in `sandbox/.kady/policy.json`, so the lead session and child
processes read one file.

## Limits

This is a heuristic guard, not a security boundary. It tokenizes shell commands
and recognizes common mutation patterns; it does not execute or fully parse
them. A script that deletes files from inside Python, a command hidden behind
an alias, or an unusual utility can slip through. Treat it as protection
against ordinary agent mistakes, keep backups of irreplaceable raw data, and
see [limitations](./limitations.md#local-shell-trust-boundary) for the trust
model.
