# Security model and hardening

Kady is a local app: the backend (port 8000) can run an agent with a shell as your OS user, read project data and change credentials. Anything that can send it requests can do the same. This page describes what stands between that API and everything else, and the settings an IT or security team may want to adjust.

## Who can reach the API

| Caller | Default install | What protects you |
|---|---|---|
| Web pages in your browser (any site, intranet page, ad) | Refused | Origin check, Host check, cross-site embed check |
| A DNS-rebinding page (`attacker.example` resolving to 127.0.0.1) | Refused | Host check: only loopback names, IP literals, this machine's hostname and `KADY_ALLOWED_HOSTS` are accepted |
| Other servers on your machine (Jupyter, Streamlit, `python -m http.server`) serving untrusted HTML | Refused | Only the UI's own port (`KADY_FRONTEND_PORT`, default 3000) counts as the UI |
| Other machines on the network | Cannot connect | Both services bind to `127.0.0.1` |
| Other OS users on the same machine | **Can connect** | Opt in to the access token: `KADY_REQUIRE_AUTH=1` |
| Processes running as you (including the agent) | Can connect | Not a boundary; see [Local shell trust boundary](./limitations.md#local-shell-trust-boundary) |

In detail, every request passes through `server/src/request-guard.ts` before any handler runs:

- A browser `Origin` that is not the UI is refused with 403. Preflights are included. This also blocks cross-site `<form>` posts, which CORS alone never stops.
- A `Host` header an attacker could rebind is refused.
- A no-cors subresource load (`<img>`, `<script>`, `<video>`) from another page is refused unless its `Referer` is the UI.

## The access token

When the backend binds beyond loopback (`KADY_HOST=0.0.0.0` or a LAN address), every request needs a token. You can also turn it on for loopback with `KADY_REQUIRE_AUTH=1`. Use that on shared workstations, HPC login nodes and multi-user servers, where other accounts can reach `127.0.0.1`.

- **Setting it up.** The launcher generates a token each run and opens `http://localhost:3000/#kady-token=…`. The fragment never leaves the browser, which stores the token, strips it from the address bar and sends it as `X-Kady-Token`. Set `KADY_AUTH_TOKEN` to keep one token across restarts.
- **When a browser has no token.** It shows a prompt asking for the link or the token.
- **URLs the browser loads itself.** Images, downloads and PDFs carry the token as `kady_token=…`. That parameter is redacted from request logs, and every backend response sends `Referrer-Policy: no-referrer`.
- **Child processes.** They inherit the token in their environment. The agent's shell can therefore read it, which is the same same-user boundary as above.
- **Turning it off.** `KADY_REQUIRE_AUTH=0` disables the token even when the backend is exposed. Only do this behind your own authenticating proxy.

Prefer an SSH tunnel over exposing the port: `ssh -L 3000:localhost:3000 -L 8000:localhost:8000 workstation`.

## Untrusted content

Sandbox files are served from the API origin (`/sandbox/raw`) so previews can load them. Every backend response therefore carries `Content-Security-Policy: sandbox; default-src 'none' …` and `X-Content-Type-Options: nosniff`, so an HTML or SVG file opened in a tab runs no script and gets no access to the API. PDFs are exempt so the browser's own viewer still works.

Other untrusted content is handled like this:

- **Notebook outputs.** HTML outputs render in a script-less, network-less iframe. SVG outputs render as images, so they cannot restyle or overlay the app.
- **Chat markdown.** It goes through Streamdown's sanitizer. Mermaid runs with `securityLevel: "strict"`.
- **LaTeX.** Compile runs `latexmk -norc`, so a `latexmkrc` shipped inside a received LaTeX project (Overleaf exports often contain one) is not executed as Perl. Your own `~/.latexmkrc` is still loaded explicitly. `-shell-escape` is never enabled.
- **Third-party skills.** They are fetched with symlinks checked out as plain files, and the `skills` CLI's telemetry is disabled.

## Credentials

- **Where keys live.** Keys typed in Settings are written to the repo-root `.env` with mode `0600`. The launcher tightens an existing `.env` to `0600` and closes `projects/` and `~/.kady` to `0700` on each start.
- **Value checks.** A value containing a line break or other control character is refused. Without this check, one pasted value could add its own `NODE_OPTIONS=` line and run code at the next launch.
- **Custom model servers.** Keys are stored as literals. Pi's `!command` and `$VAR` expansion only applies to an explicit whole-value `$VAR` reference. Literal keys are masked when read back, and `models.json` is `0600`.
- **File permissions.** Both services run with umask `077`, so new project files are owner-only. `KADY_UMASK=027` (or any octal mask) relaxes this; setting it also skips the directory tightening.
- **Proxies.** With `HTTP(S)_PROXY` set, loopback is always added to `NO_PROXY`. Calls to local model servers, and child-process calls carrying the access token, never go to the proxy.

## Settings reference

| Variable | Default | Purpose |
|---|---|---|
| `KADY_HOST` | `127.0.0.1` | Backend bind address. Anything other than loopback requires the token. |
| `KADY_FRONTEND_HOST` | `127.0.0.1` (or `KADY_HOST` when exposed) | Next.js bind address. |
| `KADY_FRONTEND_PORT` | `3000` | UI port, and the only local port trusted as the UI origin. |
| `KADY_ALLOWED_ORIGINS` | none | Comma-separated extra UI origins, e.g. `https://kady.corp.example`. |
| `KADY_ALLOWED_HOSTS` | none | Extra hostnames the backend may be reached by. |
| `KADY_REQUIRE_AUTH` | on when exposed | `1` forces the access token on, `0` forces it off. |
| `KADY_AUTH_TOKEN` | generated per launch | Fixed access token (16+ characters). |
| `KADY_UMASK` | `077` | File-creation mask for both services. |
| `KADY_SKILLS_AUTO_SYNC` | on | `0` stops the launch and daily catalogue update. Unedited catalogue skills otherwise follow upstream `main`. |

## Known gaps

- **MCP configuration.** `env`, `headers` and OAuth client secrets are shown unmasked in Settings → Connectors.
- **Default install on a shared host.** Without `KADY_REQUIRE_AUTH=1`, other local accounts can use the API.
- **Development server.** The launcher runs `next dev`, a development server, bound to loopback.
- **Web search.** It works without a key through Exa's public MCP endpoint, which sends queries to a third party. Configure a provider key or MCP connector your organization has approved.
