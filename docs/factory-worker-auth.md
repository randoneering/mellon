# Worker-only Pi model sign-in

This setup stage uses Pi's supported OAuth login for the factory worker.
T3 Code remains the orchestrator and Pi remains the coding provider.
It does not copy the host Pi profile or its existing credentials.

The operator must authorize the model account through the secure sign-in card.
If the browser redirects to an unavailable local callback, copy the full callback URL into that card, never into chat.
The helper checks the callback origin, path and exact OAuth state before passing it to Pi.
A bare authorization code is not accepted.
Malformed input fails the sign-in closed; restart the flow rather than reusing an uncertain code.

## Private storage and lifetime

The fresh session lives under `/tmp/mellon-factory-auth-<id>/`, mode `0700`.
Pi writes only that worker's model credential to `pi-agent/auth.json`, mode `0600`.
These are the real access and refresh credentials, not job-scoped dummy values.
They move into the credential relay, never into the coding worker; see [Model credential relay](#model-credential-relay).

The helper deliberately preserves this store after authorization.
It does not automatically delete it or another profile.
After transferring it to approved worker-only storage, the operator must approve cleanup of the exact temporary session path or revoke the worker login.
Do not leave abandoned worker authorizations indefinitely.
No token, redirect code or credential contents belong in logs, tracked files or status output.

A fresh login is bounded to eight minutes.
The callback/IPC listeners close on completion or cancellation.
Status output uses fixed stages and failure categories; it does not include raw provider errors.

## Provisioning a fresh deployment

Pass the verified image and the exact sign-in session directory:

```sh
node internal/factory-worker/provision-live.mjs sha256:<image-id> /tmp/mellon-factory-auth-<id>
```

The command accepts only a `mellon-factory-auth-<12 hex>` directory directly under the system temp directory.
It writes the login into the new relay volume over stdin and gives the worker an empty login.
If provisioning fails after that step, the stopped containers and the relay volume remain for you to inspect and remove; the command never deletes them.

## Model credential relay

The coding worker can read everything in its own state, so it must not hold the model login.
A filter on exported files cannot reliably catch an encoded or split credential.

The relay is a separate container, `mellon-factory-relay-<suffix>`, with its own volume mounted at `/relay-state`.
It holds `auth.json` and refreshes it through the pinned Pi SDK.
It runs as UID `10001` with a read-only root, all capabilities dropped and no published ports.
It accepts only `POST /backend-api/codex/responses` for `gpt-6.1-sol` and refuses WebSocket upgrades.
It forwards to one fixed upstream URL, replacing the worker's authorization and account headers with trusted values.

The worker keeps an empty `auth.json`.
For each job, the controller issues a grant on the relay, then writes a JWT-shaped capability to the worker's `pi-agent/relay-capability` file over stdin.
`models.json` keeps a fixed `apiKey` of `!cat /worker-state/pi-agent/relay-capability`, which Pi runs on every request, so a session that outlives one grant picks up the next.
The capability names a random grant ID and carries a placeholder account claim, because the unchanged Pi Codex client parses one locally.
Grants expire with the job and cap the request count.
The relay re-reads the grant file on every request, so revocation takes effect immediately.
The controller revokes the grant before it exports any candidate data, and blocks the job if revocation is unconfirmed.
Any credential the worker could encode into that data is already dead.

The worker's egress proxy no longer allows `chatgpt.com` or `auth.openai.com`.
The worker reaches the relay directly on the private network through `NO_PROXY`, limited to its same-suffix relay host.

Model authentication alone does not prove inference, issue dispatch, CI/Qodo evidence, publication or draft-PR completion.
The separate offline bootstrap still uses no model credentials or calls.
