# Security

Kady's backend can execute a shell, read files and change credentials as the
host OS user. The project workspace is not an OS sandbox. See the
[local shell trust boundary](limitations.md#local-shell-trust-boundary).

## API access

Both services bind to loopback by default. The backend checks browser Origin,
Host and cross-site embed headers before handlers run. Only the UI's configured
port/origins are trusted; another local web server is not automatically trusted.
These protections complement token authentication; they do not isolate
same-user processes.

On a shared host, enable **`KADY_REQUIRE_AUTH=1`**: other OS users can reach
loopback. Binding beyond loopback enables token authentication automatically
unless explicitly disabled. Prefer an SSH tunnel for remote use; see
[Installation](installation.md#troubleshooting).

The launcher generates a token and opens a URL containing `#kady-token=…`.
The browser stores it, removes the fragment and sends `X-Kady-Token`. Browser
resource URLs use `kady_token`; request logs redact that parameter and API
responses set `Referrer-Policy: no-referrer`. Child processes inherit the token,
so it is accessible to same-user shell tools.

## Settings

| Variable | Default / purpose |
|---|---|
| `KADY_HOST` | Backend bind address; default `127.0.0.1`. |
| `KADY_FRONTEND_HOST` | UI bind address; loopback unless configured/exposed through the launcher. |
| `KADY_FRONTEND_PORT` | UI port and trusted-origin port; default `3000`. |
| `KADY_ALLOWED_ORIGINS` / `KADY_ALLOWED_HOSTS` | Additional trusted UI origins / backend hostnames. |
| `KADY_REQUIRE_AUTH` | `1` forces tokens; `0` disables them, suitable only behind your own authenticating proxy. |
| `KADY_AUTH_TOKEN` | Fixed token of at least 16 characters; otherwise generated per launch. |
| `KADY_UMASK` | Default `077`; an explicit mask also skips launcher directory tightening. |

For direct remote access, set `NEXT_PUBLIC_ADK_API_URL` to the browser-reachable
backend URL before starting/building the frontend and configure allowed hosts
and origins. The standard launcher runs Next.js in development mode.

## Files and credentials

- Settings keys are stored in repo-root `.env` with `0600` permissions. The launcher tightens `.env`, `projects/` and `~/.kady` unless permissions are explicitly overridden.
- Control characters are refused in persisted environment values. Custom-server keys are literals or explicit whole-value `$VAR` references; shell-command expansion is not allowed through that UI.
- Raw file responses carry sandbox CSP and `nosniff`; PDFs are exempt from sandbox CSP for browser viewing. Notebook HTML uses a scriptless/networkless iframe; SVG outputs render as images. Chat Markdown is sanitized and Mermaid uses strict mode.
- LaTeX compilation uses `latexmk -norc` without shell escape. Project-local rc files are not executed; the user's own rc file may be loaded explicitly.
- Connector environment values, headers and OAuth client secrets are currently **unmasked** in Settings. Review who can see the screen/configuration.

## External data flow

Hosted models, web search, remote connectors and Modal receive the task data sent
to them. Keyless web search uses a shared third-party fallback. Local models and
previews do not prevent other tools from making network requests. Skills,
connectors and model-written specialist memory can introduce instructions with
the agent's permissions; review their sources.

Implementation: [`request-guard.ts`](../server/src/request-guard.ts),
[`auth.ts`](../server/src/auth.ts) and [`api-auth.ts`](../web/src/lib/api-auth.ts).
