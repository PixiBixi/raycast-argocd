# Authentication

Three modes. Only one of them never asks the operator for anything again, and it is the default.

| Mode | Module | Renews itself | Needs from the identity provider |
|---|---|---|---|
| `sso` | [`auth/sso.ts`](../../src/lib/auth/sso.ts) | **Yes** | A public OIDC client, via `oidc.cliClientID` |
| `cli` | [`auth/cliConfig.ts`](../../src/lib/auth/cliConfig.ts) | No | The same redirect URI, for `argocd login --sso` |
| `token` | [`auth/keychain.ts`](../../src/lib/auth/keychain.ts) | No | Nothing |

[`auth/provider.ts`](../../src/lib/auth/provider.ts) dispatches on the instance's mode and is
the only thing the client knows about. Every failure is an `AuthError` carrying the instance id
and the host, because the only useful recovery is "log in to that host" and the UI needs both
to offer it.

## Single sign-on, and why it is the point

The requirement that produced this was blunt and correct: pasting a token every few days is not
an authentication method, it is a chore with a deadline.

[`ui/oidcLogin.ts`](../../src/ui/oidcLogin.ts) runs the OIDC authorization code flow with PKCE
in a browser, once. The provider returns a refresh token alongside the id token, and from then
on [`auth/sso.ts`](../../src/lib/auth/sso.ts) mints a fresh id token from it before any request
that needs one.

**Renewal happens ahead of expiry, not on a 401.** That is the deliberate part. A 401 is
something the operator sees and has to retry; a renewal thirty seconds early is something they
never see. `RENEW_AHEAD_MS` is 60 seconds, and an expired id token is explicitly **not** a
reason to ask for a login while a refresh token exists. That property is what the whole feature
rests on, and it has its own test.

The policy in `createSsoTokenReader`, in order:

- A session that is still good is returned **with no request at all**, so the common path costs
  nothing.
- A lapsing session is renewed and stored.
- A refresh token the provider **refuses** (`invalid_grant`) is discarded, because keeping it
  would retry the same failure on every request.
- A provider **outage** keeps the session, since it is worth retrying.
- A session minted against a different issuer or client is voided rather than left to produce a
  puzzling 401.

Nothing about the provider is configured in the extension.
[`argocd/settings.ts`](../../src/lib/argocd/settings.ts) reads it from the instance's own
unauthenticated `/api/v1/settings`, which is also what makes a first login possible: the
extension has to know the issuer and the client before it can ask anyone for a token.

### What it needs, once

**A public OIDC client.** ArgoCD's own web client is confidential, meaning it has a secret, and
a provider refuses a token exchange on it from a client that cannot present one. Tested against
the real provider: the exchange comes back `invalid_client`. That is not a guess.

Also tested: the provider advertises the **device authorization grant**, which needs no redirect
URI at all, and it too answers `invalid_client` on that client. So no flow avoids one provider
change.

ArgoCD provides `oidc.cliClientID` in `argocd-cm` for exactly this, and `/api/v1/settings`
already exposes the field, currently null. Evidence in the live response, not inference.

So, once:

1. Create an OIDC client of type Native or public: no secret, PKCE required, token endpoint
   auth method `none`. Grants `authorization_code` and `refresh_token`. Redirect URI
   `http://localhost:8085/auth/callback`. Same group assignment as the ArgoCD app.
2. Set `oidc.cliClientID: <the new client id>` in `argocd-cm`, per instance.

The port and path match what `argocd login --sso` uses, deliberately, so that one redirect URI
serves the CLI and this extension both and nobody has to register a second one.

`exchangeCode` recognises `invalid_client` and raises `PublicClientRequiredError`, which names
`oidc.cliClientID` as the fix rather than failing obscurely.

### What is confirmed about the provider

Read from the provider's own discovery document, which is public:

- `refresh_token` among `grant_types_supported`
- `offline_access` among `scopes_supported`, and already requested by the ArgoCD config
- `none` among `token_endpoint_auth_methods_supported`, so a public client is possible
- `S256` among `code_challenge_methods_supported`

`withOfflineAccess` adds `offline_access` and `openid` if the instance's reported scopes lack
them, because without the first there is no refresh token and without the second there is no id
token to use as a bearer.

### What is still unverified

**The flow has never completed against the real provider**, because the public client does not
exist yet. Every step is tested against stubs: 33 cases in
[`tests/lib/auth/oidc.test.ts`](../../tests/lib/auth/oidc.test.ts) and 15 in
[`tests/lib/auth/sso.test.ts`](../../tests/lib/auth/sso.test.ts), including that the verifier
never appears in the authorization request, that no `client_secret` is ever sent, and that no
error message contains a token. The first real login will be the first real test.

`loginWithSso` refuses to report success without a refresh token, since without one this mode
is no better than pasting a token.

## The argocd CLI session

Reads the token the `argocd` binary already holds in `~/.config/argocd/config` (mode 0600),
matching the `users[]` entry whose name equals the instance host. Exact match, port included:
`argocd.example.com` and `argocd.example.com:8443` are two different sessions.

Expiry is detected by decoding the JWT `exp` claim. **Decode only, never verify**: the server
is the authority; the local decode exists only to offer a re-login before a request that is
certain to fail.

A config that only lists `kubernetes` (left by `argocd --core`) or `localhost:8080` (a
port-forward) has no session for the host itself, which is the usual shape when the CLI has only
ever been used in core mode. Being logged in to `gcloud`, or having a working `kubectl`, is
unrelated: those authenticate to the cluster, not to ArgoCD.

## The keychain, and two bugs worth remembering

Raycast's `LocalStorage` is not encrypted, so it is the wrong home for a credential. Both the
API token and the SSO session live in the macOS keychain under service `raycast-argocd`, keyed
by instance id, with the session under `<id>.sso` so the two never collide. Reached through
`/usr/bin/security`, a system binary, which keeps the extension free of native dependencies
Raycast could not bundle.

Two things went wrong here, and both guards are still in the code.

**The write stored nothing and reported success.** `security add-generic-password -w`, with `-w`
given no value, prompts **twice**: "password data for new item" then "retype password for new
item". Feeding the token to stdin once made `security` print "passwords don't match", store an
**empty** password, and exit **0**. The success toast fired on that exit code, so the operator
was told the token was saved while the keychain held an empty string.

**Then the stdin fix worked in a shell and not in Raycast.** Feeding the value twice was
verified against the real binary from a terminal, and inside Raycast the item was still created
empty. Not the missing controlling terminal, which was ruled out by forking, calling `setsid`,
confirming `/dev/tty` was no longer openable, and writing anyway: it stored the value.
`execFileAsync` wrote the input with `child.stdin?.end(input)`, and that optional chain writes
nothing and reports nothing when stdin is unavailable. A silent no-op in the code whose one job
was to deliver the secret.

The resolution:

- The token is passed in **argv**. `security` cannot read a password from a file descriptor, and
  the prompt form does not receive stdin inside Raycast. The exposure this accepts is stated
  rather than glossed over: for one short-lived process the token is visible to same-uid
  processes, which is the boundary that already governs the stored item, since
  `security find-generic-password -w` hands it to any same-uid process without a prompt. macOS
  does not expose another user's argv without root.
- `execFileAsync` in [`ui/deps.ts`](../../src/ui/deps.ts) **rejects** when a caller supplies
  `input` and the child has no stdin, instead of quietly skipping the write.
- `writeKeychainToken` **reads the value back** and throws if it differs. An exit code of 0 from
  `security` is not evidence that anything was stored. The failure modes are reported apart: a
  read that errored, an absent item, and a differing value, the last naming **lengths only**
  since the message reaches a toast.

The test for this runs against a fake `security` reproducing the store-nothing-and-exit-0
behaviour. The previous test asserted only that the token was absent from argv, never that it
arrived, which is exactly why it could not catch the bug.

## Rules that apply to any change here

- **Never log, render, or copy a token, a refresh token, or an `Authorization` header.** Tests
  assert this on the client and on both providers. Where a diagnostic needs to compare values,
  report lengths.
- **Never trust an exit code or a status as evidence of an effect.** Read back what you wrote.
- **The action offered must match the instance's mode.** An SSO login on a keychain instance
  cannot help, and an earlier version offered exactly that.
- **Relevant checks**: `npm test` covers `oidc`, `session`, `sso`, `provider`, `keychain`,
  `cliConfig`, `login` and `settings`. None of them touch a real provider or a real keychain, so
  a change to the keychain argv or the token exchange is worth a manual round trip against the
  real `security` binary, the way A6, A7 and A11 in the
  [implementation plan](../../docs/superpowers/plans/2026-09-08-raycast-argocd.md) describe.
