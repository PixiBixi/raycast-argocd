# Authentication

Three modes. Only one of them never asks the operator for anything again, and it is the default.

| Mode    | Module                                                 | Renews itself | Needs from the identity provider                |
| ------- | ------------------------------------------------------ | ------------- | ----------------------------------------------- |
| `sso`   | [`auth/sso.ts`](../../src/lib/auth/sso.ts)             | **Yes**       | A public OIDC client, via `oidc.cliClientID`    |
| `cli`   | [`auth/cliConfig.ts`](../../src/lib/auth/cliConfig.ts) | No            | The same redirect URI, for `argocd login --sso` |
| `token` | [`auth/secrets.ts`](../../src/lib/auth/secrets.ts)     | No            | Nothing                                         |

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

**The flow has never completed against a real provider.** On the target deployment it cannot
yet: probing the provider's authorize endpoint shows the only redirect URI registered on
ArgoCD's client is ArgoCD's own web callback. The loopback URI and Raycast's own
(`https://raycast.com/redirect`) are both refused with "the redirect_uri parameter must be a
Login redirect URI in the client app settings", while the web callback returns 200, which
proves the probe sound.

Adding `http://localhost:8085/auth/callback` to that client has been requested. It is one line
of provider configuration, and it is the URI the official ArgoCD CLI uses on its default port,
so today nobody on that team can run `argocd login --sso` either. The request is framed as a
security matter rather than a convenience: without it the only workaround is sharing a service
account token, which is what the section above describes.

Once it lands, this is the mode to use everywhere, and the first real login will be the first
real test of the exchange. Every step is covered against stubs: 33 cases in
[`tests/lib/auth/oidc.test.ts`](../../tests/lib/auth/oidc.test.ts) and 15 in
[`tests/lib/auth/sso.test.ts`](../../tests/lib/auth/sso.test.ts), including that the verifier
never appears in the authorization request, that no `client_secret` is ever sent, and that no
error message contains a token. Every step is tested against stubs: 33 cases in
[`tests/lib/auth/oidc.test.ts`](../../tests/lib/auth/oidc.test.ts) and 15 in
[`tests/lib/auth/sso.test.ts`](../../tests/lib/auth/sso.test.ts), including that the verifier
never appears in the authorization request, that no `client_secret` is ever sent, and that no
error message contains a token. The first real login will be the first real test.

`loginWithSso` refuses to report success without a refresh token, since without one this mode
is no better than pasting a token.

## The token mode bypasses per-user RBAC

Worth stating plainly, because the mode is convenient and its cost is invisible.

An ArgoCD account token carries **the account's permissions, not the operator's**. On a
deployment whose RBAC binds identity groups to roles, for example

```
g, argocd-admins, role:admin
g, argocd-rnd,    role:readonly
```

and grants a service account a global read

```
p, sa-argocd-scanner, applications,    get, */*, allow
p, sa-argocd-scanner, applicationsets, get, */*, allow
```

then a token for that account has three consequences.

**Audit trails stop identifying anyone.** Every request the extension makes appears under the
service account. On a production instance that is the opposite of what an audit log is for.

**It can grant more than the operator has.** Someone whose own account is scoped to one project
gets global read across every project by holding the token. Distributing such a token is a
privilege escalation dressed up as configuration.

**It can also grant less.** An administrator using that same token cannot sync anything, since
the account has no `applications, sync`. The extension's write guards are then redundant with
a server-side refusal, which is fine on production and a nuisance on development.

And creating one is not something most operators can do: it needs `accounts, update`, which
here comes only with `role:admin`. So the mode is not a team onboarding path. It is a personal
workaround for an environment where `sso` cannot run, and the extension deliberately does not
make it more welcoming than that: there is no in-app token generation, and the only operation
offered on an existing token is to replace or revoke it.

A token's value is also unrecoverable. ArgoCD returns it once at creation and stores only its
id, so "replace" means delete and create, which invalidates the old one immediately. Give each
installation its own token id for that reason, `raycast-<hostname>` rather than `raycast`, or
configuring a second machine silently breaks the first.

## The argocd CLI session

Reads what the `argocd` binary already holds in `~/.config/argocd/config` (mode 0600), matching
the `users[]` entry whose name equals the instance host. Exact match, port included:
`argocd.example.com` and `argocd.example.com:8443` are two different sessions, which is also
what makes several instances work without any notion of a current context. The CLI's
`current-context` is deliberately ignored.

**It renews itself**, from the `refresh-token` that `argocd login --sso` stores next to the
bearer. Reading only the bearer, which is what this mode did at first, meant an id token lapsed
after roughly an hour and the operator was told to log in again, which made a perfectly good
mode look like a degraded fallback.

[`auth/cliSession.ts`](../../src/lib/auth/cliSession.ts) holds the precedence rule, and it is
worth understanding because it needs no bookkeeping to stay correct:

1. **A config token that is still good wins**, with no request at all. This is also how a fresh
   `argocd login` takes effect immediately and makes any stale cache irrelevant, and it is the
   branch that serves a non-expiring API token written into the config by hand, since such a
   token has no readable expiry to renew against.
2. **Otherwise a cached renewal that is still good wins**, so opening a command costs no round
   trip.
3. **Otherwise the config's refresh token mints a new one.**

Nothing records which refresh token produced which renewal: re-running `argocd login` refreshes
the config token, which rule 1 then prefers.

What this deliberately does **not** do is write the renewed token back into the CLI's config.
That file belongs to the CLI, and an extension quietly rewriting another tool's configuration is
the kind of helpfulness nobody asks for. The renewal is kept under its own storage key, apart
from the `sso` session, so switching an instance between the two modes cannot make one read the
other's token.

Expiry is detected by decoding the JWT `exp` claim. **Decode only, never verify**: the server
is the authority; the local decode exists only to renew ahead of a request that would fail.

A config that only lists `kubernetes` (left by `argocd --core`) or `localhost:8080` (a
port-forward) has no session for the host itself, which is the usual shape when the CLI has only
ever been used in core mode. Being logged in to `gcloud`, or having a working `kubectl`, is
unrelated: those authenticate to the cluster, not to ArgoCD.

## Where credentials live

Both the API token and the single sign-on session live in Raycast's own storage, which its
documentation describes as a "local encrypted database" whose contents "can only be accessed by
the corresponding extension", and which names `password` preferences as the way to ask for
"values such as access tokens".

[`lib/auth/secrets.ts`](../../src/lib/auth/secrets.ts) owns the key naming and the validation
and takes the store as an argument, so both are tested without Raycast.
[`ui/storage.ts`](../../src/ui/storage.ts) supplies the real one over `LocalStorage`.

### It used to be the macOS keychain, and that was a mistake three times over

The keychain was chosen on the belief that Raycast's storage was unencrypted. That belief was
asserted, in a code comment, without being checked, and it is wrong. The cost was not
theoretical:

**It stored nothing and reported success.** `security add-generic-password -w`, with `-w` given
no value, prompts **twice**: "password data for new item" then "retype password for new item".
Feeding the token to stdin once made `security` print "passwords don't match", store an
**empty** password, and exit **0**. The success toast fired on that exit code, so the operator
was told the token was saved while the store held an empty string.

**Then the stdin fix worked in a shell and not in Raycast.** Feeding the value twice was
verified against the real binary from a terminal, and inside Raycast the item was still created
empty. Not the missing controlling terminal, which was ruled out by forking, calling `setsid`,
confirming `/dev/tty` was no longer openable, and writing anyway: it stored the value. The
cause was `child.stdin?.end(input)` in `execFileAsync`, an optional chain that writes nothing
and reports nothing when stdin is unavailable. A silent no-op in the code whose one job was to
deliver the secret. The resolution at the time was to pass the token through **argv**, where
any same-uid process could read it with `ps`.

**And it would have been rejected from the store.** The Raycast checklist says extensions
requesting Keychain Access are refused, and names the preferences API as the sanctioned place
for credentials. So the detour ended where it should have started.

One habit is worth keeping from it. `writeVerified` **reads the value back** and throws if it
differs, because a write whose effect is never checked is how "stored" came to mean "the call
returned", twice. The same reasoning kills the argv exposure, the `security` dependency, the
double-prompt, and the read-back's original reason all at once.

## Rules that apply to any change here

- **Never log, render, or copy a token, a refresh token, or an `Authorization` header.** Tests
  assert this on the client and on both providers. Where a diagnostic needs to compare values,
  report lengths.
- **Never trust an exit code or a status as evidence of an effect.** Read back what you wrote.
- **The action offered must match the instance's mode.** An SSO login on a token instance
  cannot help, and an earlier version offered exactly that.
- **Relevant checks**: `npm test` covers `oidc`, `session`, `sso`, `provider`, `secrets`,
  `cliConfig`, `login` and `settings`. None of them touch a real provider, so the first real
  login remains the first real test of the exchange. A6, A7, A11 and A12 in the
  [implementation plan](../../docs/superpowers/plans/2026-09-08-raycast-argocd.md) record how
  each of these was got wrong before.
