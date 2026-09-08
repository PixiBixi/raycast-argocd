# ArgoCD for Raycast

Search applications across several ArgoCD instances from Raycast, then open, inspect or sync
the one you found. Built for instances holding thousands of applications behind a VPN.

## Commands

| Command                | What it does                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Search Applications    | Searches every configured instance at once, or one of them. Renders from a local cache first, then refreshes behind you. |
| Search ApplicationSets | Lists ApplicationSets with a rollup of the applications each one generated, and jumps to them.                           |
| Manage Instances       | Adds, edits and removes instances, shows whether each is reachable, and handles the SSO login and API tokens.            |
| ArgoCD Monitor         | A menu bar counter of what is degraded or out of sync across every instance. Also keeps the cache warm.                  |

## Install

Requires Raycast on macOS, Node 22.22.2 or later, and the `argocd` CLI if you use the SSO
authentication mode.

```sh
npm install
npm run dev
```

The three commands appear at the top of Raycast's root search. `Ctrl-C` stops the dev server and
leaves the extension installed.

## The menu bar

`ArgoCD Monitor` runs every 10 minutes and does two jobs. It reports, and it refreshes the
on-disk cache, which is what keeps `Search Applications` painting instantly the rest of the
time. That is only affordable because the read path streams: around 3 MB gzipped per instance,
projected element by element.

A menu bar command appears only after it has been run once: open Raycast, run **ArgoCD
Monitor**, and the icon installs itself next to the clock. Nothing happens inside Raycast, which
is expected.

If the icon does not appear, the usual reason is macOS rather than the extension: a full menu
bar silently drops the items that do not fit, which a notched MacBook makes worse.

The title is quiet by default:

| Title                    | Meaning                                                      |
| ------------------------ | ------------------------------------------------------------ |
| nothing, just the icon   | everything healthy and synced                                |
| `2 degraded, 5 drifting` | degraded leads, because one is broken and the other is drift |
| `5 out of sync`          | nothing is degraded                                          |
| `prod unreachable`       | shown only once nothing else is known to be wrong            |

Turn on **When everything is healthy** in the command preferences to see the total instead of
nothing. The tooltip always lists every instance with its counts.

The menu lists the degraded applications first, then the out-of-sync ones, capped at 12 per
section with the rest left to the search command. Selecting one opens it in ArgoCD.

A background command cannot ask for a login, so an instance that fails is reported with the
reason and an item that opens where it gets fixed, routed on the kind of failure. The last
numbers it had stay on screen rather than the menu emptying.

## Adding an instance

Open **Manage Instances**, add one, and fill in:

| Field                  | Notes                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| Name                   | How the instance is labelled in results, for example `prod-tooling`.                      |
| Server URL             | The base URL of the ArgoCD web UI. `https` only.                                          |
| Environment            | `prod`, `preprod` or `dev`. Drives the colour of the badge and the write guard.           |
| Authentication         | `argocd CLI session (SSO)` or `API token in the keychain`. See below.                     |
| Allow write operations | Off by default. When off, the sync actions do not exist. Forced off on a `prod` instance. |
| Include in searches    | Off keeps the instance configured without querying it.                                    |

Instances are stored in Raycast's local storage. Nothing leaves the Mac, and no hostname is
committed to this repository.

## Authentication

Three modes. Only one of them never asks you for anything again, and it is the default.

### Single sign-on, renewed silently

The extension runs the OIDC authorization code flow with PKCE against your identity provider,
in a browser, once. The provider returns a refresh token alongside the id token, and from then
on every request that needs a token mints a fresh one from it, ahead of expiry, with no prompt
and no toast. Nothing is ever pasted, and nothing expires that you have to notice.

Renewal happens before expiry rather than on a 401, deliberately: a 401 is something you see
and retry, a renewal thirty seconds early is something you never do.

The session lives in the macOS keychain under the service `raycast-argocd`, in its own account
per instance. `Manage Instances` shows `signed in` or `sign in needed` per instance, so the
state is visible before it fails.

**It needs a public OIDC client.** ArgoCD's own web client is confidential, meaning it has a
secret, and an identity provider refuses a token exchange on it from a client that cannot
present one: the exchange comes back `invalid_client`. ArgoCD provides `oidc.cliClientID` in
`argocd-cm` for exactly this case, and `/api/v1/settings` exposes it, which is where the
extension reads it from. Nothing about the provider is configured in the extension.

So, once, with whoever administers your identity provider:

1. Create an OIDC client of type **Native** or public: no secret, PKCE required, token endpoint
   authentication method `none`. Grants: `authorization_code` and `refresh_token`. Redirect URI
   `http://localhost:8085/auth/callback`. Assign it to the same group as the ArgoCD app.
2. Set `oidc.cliClientID: <the new client id>` in `argocd-cm`, on each instance.

The port and path match what `argocd login --sso` uses, so that one redirect URI serves the CLI
and this extension both, and nobody has to register a second one.

Then, in the extension: **Log in with single sign-on** from Manage Instances. The browser opens
once. That is the last time you are asked.

If the client is not public, the extension says so in as many words rather than failing
obscurely, and names `oidc.cliClientID` as the fix.

### argocd CLI session

Reuses whatever session the `argocd` binary already holds in `~/.config/argocd/config`, for
instances where the public client above is not set up. It needs the same redirect URI
registered, so if that is done, prefer single sign-on: the CLI mode has no silent renewal of its
own here.

Log in with:

```sh
argocd login argocd.example.com --sso --grpc-web
```

A config that only lists `kubernetes` (left by `argocd --core`) or `localhost:8080` (a
port-forward) has no session for the host itself, which is the usual shape when the CLI has only
ever been used in core mode. Being logged in to `gcloud` or having a working `kubectl` is
unrelated: those authenticate to the cluster, not to ArgoCD.

### API token in the keychain

The mode that needs nothing from your identity provider, and the one to leave behind once the
public client exists: an API token has to be created, and eventually recreated, by hand.

```sh
argocd account generate-token --account <account-with-apiKey> --server argocd.example.com --grpc-web
```

Without `--expires-in` the token does not expire, which is what makes this bearable. That
command needs a session of its own, so if the CLI login is what is blocked, bootstrap it from
the web session: log in to the ArgoCD web UI, copy the `argocd.token` cookie, and pass it as
`--auth-token`. The cookie is itself a valid bearer token, with that session's lifetime.

Generating a token **writes to the server**: the token id is stored in `argocd-secret`. On an
instance you are only supposed to read, do not run it.

Set the instance's mode to `API token in the keychain`, then use **Set API token**. The token
goes into the macOS keychain under `raycast-argocd`, keyed by the instance id, never into
Raycast's storage, and never into a log or the clipboard.

It is passed to `/usr/bin/security` in the argument list, which is worth stating rather than
glossing over. `security add-generic-password` cannot read a password from a file descriptor;
its only alternative is a `-w` flag with no value, which prompts on the terminal, and those
prompts do not receive stdin inside Raycast, where the write then stores an empty password and
exits 0. So for the lifetime of one short-lived process the token is visible to processes
running as the same user, which is the boundary that already governs the stored item:
`security find-generic-password -w` hands it to any same-uid process without a prompt. macOS
does not expose another user's arguments without root.

Every write is verified by reading the value back before success is reported, so a write that
did not land fails loudly instead of showing a success toast.

Inspect or remove what is stored with:

```sh
security find-generic-password -s raycast-argocd -a <instance-id> -w
security delete-generic-password -s raycast-argocd -a <instance-id>
```

## Reachability

Instances behind a VPN would otherwise make every command wait out its full request timeout
before failing. Each instance is probed first with an unauthenticated `GET /api/version` and a
short timeout, so a disconnected VPN is reported in under a second and the list still renders
from cache. An instance that comes back unreachable is not queried at all.

Note the path: ArgoCD serves its version outside the versioned API, so `/api/version` and not
`/api/v1/version`. Any HTTP answer counts as reachable, including a 404, so a wrong path reads
as "reachable" and is easy to miss.

**Manage Instances** shows the state per row:

| Dot   | Means                                                                                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------------- |
| green | answered 2xx, with the server version and the round-trip time                                                              |
| amber | answered, but not 2xx or without a version. A wrong URL, a proxy in the way, or a broken server. The status is in the row. |
| red   | nothing answered. `unreachable, check your VPN`.                                                                           |
| grey  | not probed yet                                                                                                             |

`⌘T` re-probes everything. The result is cached for 30 seconds, so a VPN that just came up is
picked up on the next open.

## ApplicationSets

`Search ApplicationSets` merges two sources, because neither is enough on its own.

`GET /api/v1/applicationsets` is the better one when it works: only it carries
`status.conditions`, so only it can report a broken generator, and only it knows about an
ApplicationSet that has generated nothing. But it returns only ApplicationSets whose namespace
the server has enabled **for ApplicationSets**, which is a switch separate from the one that
enables applications in any namespace, and it filters silently. On a server where that switch is
off, the endpoint answers 200 with an empty list while thousands of ApplicationSets exist, and
there is no error to report.

So the applications cache is the second source. Every generated application carries an
ownerReference naming its parent, and owner references are namespace-scoped, so the parents can
be reconstructed with no extra request and no extra permission. Measured on a real instance:
807 of the 872 ApplicationSets recovered from 2053 applications, the missing ones being those
that currently generate nothing.

A reconstructed entry carries a link icon and its section says how many were reconstructed, so
the list never pretends to know more than it does. The API's answer wins wherever it has one.

This means **`Search Applications` has to have run once** for `Search ApplicationSets` to be
useful: the reconstruction reads that cache. The empty state says so.

To get the full list from the API instead, the ApplicationSet namespaces have to be enabled on
the server side, through `applicationsetcontroller.namespaces` in `argocd-cmd-params-cm` and the
matching argocd-server setting. That is a server change, not something this extension can work
around.

## Preferences

| Preference                 | Default  | Range       | Notes                                                               |
| -------------------------- | -------- | ----------- | ------------------------------------------------------------------- |
| Cache TTL                  | `60`     | 5 to 3600 s | How stale a cached list may be before a background refresh.         |
| Request Timeout            | `15`     | 3 to 120 s  | Per API request.                                                    |
| Reachability Probe Timeout | `4`      | 1 to 30 s   | Kept short on purpose.                                              |
| Max Results                | `60`     | 10 to 200   | Rows rendered at once. Rendering, not searching, is the bottleneck. |
| argocd CLI Path            | `argocd` |             | Used by the SSO login action.                                       |

A value that does not parse falls back to the default; a value out of range is clamped.

## Application actions

| Action                               | Shortcut          | Notes                                                                                                                                                         |
| ------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Show details                         | `↵`               | Leads with the resources that need attention, then the deployed commit, the recent deployments and the images.                                                |
| Show resources                       | `⌘O`              | Every object the application manages, with its sync state, health, sync wave, hook and prune flags. Costs no request: it comes inside the application object. |
| Show diff                            | `⌘D`              | What is out of sync, from `managed-resources`. ArgoCD precomputes the diff. Offered when the application is out of sync.                                      |
| Show sync status                     | `⌘Y`              | Follows a running sync until it finishes.                                                                                                                     |
| Open in ArgoCD                       |                   | Deep link to the application, or to one selected resource from the resources view.                                                                            |
| Refresh application                  | `⌘R`              | `refresh=normal`. A read, so it works on read-only instances.                                                                                                 |
| Hard refresh application             | `⌘⇧R`             | `refresh=hard`.                                                                                                                                               |
| Sync with options                    |                   | Only on an instance with write operations allowed.                                                                                                            |
| Quick sync                           |                   | Default options, behind a confirmation.                                                                                                                       |
| Show sibling applications            |                   | The other applications the same ApplicationSet generated.                                                                                                     |
| Copy name, copy URL, open repository | `⌘⇧C` for the URL |                                                                                                                                                               |

The detail view also shows the **sync policy** as tags: `automated`, `prune`, `self-heal`, or
`manual`. Whether auto-sync is on changes what a manual sync means, so it is next to the sync
status rather than buried.

From the resources view, each resource offers its own diff, a deep link that opens it selected
in the web UI, and a **Copy kubectl command** action that yields a ready
`kubectl -n <namespace> get <kind>.<group> <name> -o yaml`.

### How the diff is computed

ArgoCD's `managed-resources` response declares a `diff` field and does not fill it in: its own
web UI diffs `targetState` against `normalizedLiveState` in the browser. So the extension does
the same. Each state is rendered to stable YAML-shaped text with sorted keys, then diffed line
by line and shown as a unified diff with three lines of context.

Sorting the keys is what keeps the result honest: two serialisations of the same object list
their keys in different orders, and diffing them raw reports every line as changed. The fields
ArgoCD itself ignores are dropped for the same reason: `status`, which the cluster writes rather
than git, and `metadata.managedFields`, `creationTimestamp`, `generation`, `resourceVersion`,
`uid` and `selfLink`, which always differ. Annotations are kept, since a tracking-id annotation
is a difference that matters.

A manifest past 4000 lines is reported as too large rather than compared, because the diff is a
quadratic table and that is where the trade stops holding. If ArgoCD ever does populate its own
`diff` field, that string is used instead.

## Sync options

Each control maps to one field of the ArgoCD sync request. An untouched form sends an empty
body, which means "sync with the application's own settings".

| Control                | Request                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| Revision               | `revision`                                                            |
| Prune                  | `prune`                                                               |
| Dry run                | `dryRun`                                                              |
| Apply only, skip hooks | `strategy.apply`                                                      |
| Force                  | `strategy.apply.force` or `strategy.hook.force`                       |
| Replace                | `syncOptions.items += Replace=true`                                   |
| Server-side apply      | `syncOptions.items += ServerSideApply=true`                           |
| Prune last             | `syncOptions.items += PruneLast=true`                                 |
| Skip schema validation | `syncOptions.items += Validate=false`                                 |
| Retry, retry limit     | `retryStrategy` with ArgoCD's own backoff: 5s, doubling, capped at 3m |

The form shows in one line what it is about to send. Everything but a dry run goes through a
confirmation naming the application, the instance and its environment.

## Read-only and production instances

- A `prod` instance is created with write operations off and cannot be created with them on.
- With write operations off, the sync actions are absent from the UI **and** the client refuses
  any non-GET request before it builds one. Two independent checks, so a UI regression cannot
  produce a write.
- Server-side RBAC remains the real control. These guards keep an accidental keystroke from
  reaching it.

## Troubleshooting

**"No argocd CLI session for <host>"** - the CLI has never logged in to that host. Run
`argocd login <host> --sso --grpc-web`. A config that only lists `kubernetes` (from `--core`) or
`localhost:8080` (from a port-forward) has no session for the host itself, which is the usual
shape when the CLI has only ever been used in core mode. Being logged in to `gcloud` or having a
working `kubectl` is unrelated: those authenticate to the cluster, not to ArgoCD.

**"No API token stored for <instance>"** - the instance is in keychain mode and the keychain
has nothing usable for it. Use **Set API token** in Manage Instances. Check what is stored with:

```sh
security find-generic-password -s raycast-argocd -a <instance-id> -w
```

An empty answer means the item exists with an empty password, which counts as no token. Store it
again; the extension reads the value back before reporting success, so a write that did not land
now fails loudly instead of showing a success toast.

**Everything worked and now returns 401** - the OIDC token has a limited lifetime, typically one
hour. Use **Log in with SSO** from the empty state or from Manage Instances.

**"unreachable, check your VPN"** - the probe got no answer at all. Connect the VPN and press
`⌘T` in Manage Instances, or `⌘⇧R` in the search command. Any HTTP answer, including a 4xx,
counts as reachable, so this really does mean nothing answered.

**An amber dot with a latency and a status** - the instance answered something other than 2xx on
`/api/version`. Usually the server URL points at something that is not an ArgoCD, or a proxy is
answering instead of it. Check the URL in Manage Instances.

**Search ApplicationSets is empty, or every entry has a link icon** - the ApplicationSet API
returned nothing, either because the server has not enabled those namespaces for
ApplicationSets or because your account cannot list them. See the ApplicationSets section. If it
is empty altogether, open Search Applications once so the reconstruction has a cache to read.

**A section says "cached 12 min ago, refresh failed"** - the refresh failed and the cached list
is still being shown on purpose. The reason is in the section subtitle, and `⌘R` retries that
instance alone.

**The sync action is missing** - the instance has write operations off, or it is a `prod`
instance where they cannot be turned on. Check it in Manage Instances.

**"is configured read-only, so this action was refused"** - the client-side guard fired. That
should be unreachable through the UI; if you see it, the UI let you at an action it should have
hidden.

**Results are truncated** - the list renders at most `Max Results` rows and says how many more
matched. Type more of the name, the project or the namespace.

## Development

```sh
npm test          # vitest over src/lib
npm run typecheck
npm run lint
npm run build
./scripts/check-no-secrets.sh
```

`src/lib` is pure TypeScript with every outside dependency injected, and a test enforces that it
imports nothing from `@raycast/api` or `react`. `src/ui` holds the React components and the
Raycast plumbing, and is covered by `ray build` and `ray lint` rather than unit tests.

The design and the implementation plan, including the measurements the read path is built on,
are in `docs/superpowers/`.
