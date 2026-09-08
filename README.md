# ArgoCD for Raycast

Search applications across several ArgoCD instances from Raycast, then open, inspect or sync the
one you found. Built for instances holding thousands of applications behind a VPN.

This file is the usage reference. For how it works and why, start at
[`openwiki/quickstart.md`](openwiki/quickstart.md).

## Commands

| Command                | Mode                   | What it does                                                                                                             |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Search Applications    | view                   | Searches every configured instance at once, or one of them. Renders from a local cache first, then refreshes behind you. |
| Search ApplicationSets | view                   | Lists ApplicationSets with a rollup of the applications each one generated, and jumps to them.                           |
| Manage Instances       | view                   | Adds, edits and removes instances, shows whether each is reachable, and handles logins and API tokens.                   |
| ArgoCD Monitor         | menu bar, every 10 min | Counts what is degraded or out of sync across every instance. Also keeps the cache warm.                                 |

## Install

Requires Raycast on macOS and Node 22.22.2 or later. The `argocd` CLI is needed only for the
CLI session authentication mode.

```sh
npm install
npm run dev
```

The four commands appear at the top of Raycast's root search. `Ctrl-C` stops the dev server and
leaves the extension installed.

## Adding an instance

Open **Manage Instances**, add one, and fill in:

| Field                  | Notes                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| Name                   | How the instance is labelled in results, for example `prod-tooling`.                      |
| Server URL             | The base URL of the ArgoCD web UI. `https` only.                                          |
| Environment            | `prod`, `preprod` or `dev`. Drives the colour of the badge and the write guard.           |
| Authentication         | `Single sign-on`, `argocd CLI session`, or `API token in the keychain`.                   |
| Allow write operations | Off by default. When off, the sync actions do not exist. Forced off on a `prod` instance. |
| Include in searches    | Off keeps the instance configured without querying it.                                    |

Instances are stored in Raycast's local storage. Nothing leaves the Mac, and no hostname is
committed to this repository.

## Authentication

| Mode                      | Renews itself     | Setup                                                         |
| ------------------------- | ----------------- | ------------------------------------------------------------- |
| Single sign-on            | **Yes**, silently | One browser login, after a one-time provider change. Default. |
| argocd CLI session        | No                | `argocd login <host> --sso --grpc-web`                        |
| API token in the keychain | No                | Store a token with **Set API token**                          |

Why single sign-on is the only mode that never asks again, and what the renewal does, is in
[`openwiki/domain/authentication.md`](openwiki/domain/authentication.md).

### Single sign-on setup

It needs a **public** OIDC client, because ArgoCD's own web client is confidential and a token
exchange on it without a secret is refused. Once, with whoever administers your identity
provider:

1. Create an OIDC client of type Native or public: no secret, PKCE required, token endpoint
   auth method `none`. Grants `authorization_code` and `refresh_token`. Redirect URI
   `http://localhost:8085/auth/callback`. Same group assignment as the ArgoCD app.
2. Set `oidc.cliClientID: <the new client id>` in `argocd-cm`, on each instance.

The port and path match `argocd login --sso`, so that one redirect URI serves the CLI and this
extension both.

Then use **Log in with single sign-on** from Manage Instances. The browser opens once. If the
client is not public, the extension says so and names `oidc.cliClientID` as the fix.

### API token setup

```sh
argocd account generate-token --account <account-with-apiKey> --server argocd.example.com --grpc-web
```

Without `--expires-in` the token does not expire. That command needs a session of its own, so if
the CLI login is blocked, bootstrap it from the web session: log in to the ArgoCD web UI, copy
the `argocd.token` cookie, and pass it as `--auth-token`. The cookie is itself a valid bearer
token, with that session's lifetime.

Generating a token **writes to the server**: the token id is stored in `argocd-secret`. On an
instance you are only supposed to read, do not run it.

Set the instance's mode to `API token in the keychain`, then use **Set API token**. Inspect or
remove what is stored with:

```sh
security find-generic-password -s raycast-argocd -a <instance-id> -w
security delete-generic-password -s raycast-argocd -a <instance-id>
```

## Preferences

| Preference                 | Default  | Range       | Notes                                                       |
| -------------------------- | -------- | ----------- | ----------------------------------------------------------- |
| Cache TTL                  | `60`     | 5 to 3600 s | How stale a cached list may be before a background refresh. |
| Request Timeout            | `15`     | 3 to 120 s  | Per API request.                                            |
| Reachability Probe Timeout | `4`      | 1 to 30 s   | Kept short on purpose.                                      |
| Max Results                | `60`     | 10 to 200   | Rows rendered at once.                                      |
| argocd CLI Path            | `argocd` |             | Used by the CLI session login action.                       |

A value that does not parse falls back to the default; a value out of range is clamped.

`ArgoCD Monitor` has one command preference, **When everything is healthy**, off by default, so
the menu bar stays quiet until something needs attention.

## Application actions

| Action                               | Shortcut          | Notes                                                                                                                 |
| ------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| Show details                         | `↵`               | Leads with the resources that need attention, then the deployed commit, the recent deployments and the images.        |
| Show resources                       | `⌘O`              | Every object the application manages, with its sync state, health, sync wave, hook and prune flags. Costs no request. |
| Show diff                            | `⌘D`              | What is out of sync. Offered when the application is out of sync.                                                     |
| Show sync status                     | `⌘Y`              | Follows a running sync until it finishes.                                                                             |
| Refresh application                  | `⌘R`              | `refresh=normal`. A read, so it works on read-only instances.                                                         |
| Hard refresh application             | `⌘⇧R`             | `refresh=hard`.                                                                                                       |
| Sync with options                    |                   | Only on an instance with write operations allowed.                                                                    |
| Quick sync                           |                   | Default options, behind a confirmation.                                                                               |
| Show sibling applications            |                   | The other applications the same ApplicationSet generated.                                                             |
| Open in ArgoCD                       |                   | Deep link to the application, or to one selected resource from the resources view.                                    |
| Copy name, copy URL, open repository | `⌘⇧C` for the URL |                                                                                                                       |

From the resources view, each resource also offers its own diff, a deep link that opens it
selected in the web UI, and **Copy kubectl command**.

The detail view shows the sync policy as tags: `automated`, `prune`, `self-heal`, or `manual`.

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

On a `prod` instance, write operations cannot be turned on at all, and the sync actions do not
exist. See
[`openwiki/architecture/commands.md`](openwiki/architecture/commands.md#the-write-guards).

## The menu bar

A menu bar command appears only after it has been run once: open Raycast, run **ArgoCD
Monitor**, and the icon installs itself next to the clock. Nothing happens inside Raycast, which
is expected. If the icon does not appear, the usual reason is a full macOS menu bar silently
dropping the items that do not fit.

| Title                 | Meaning                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| the ArgoCD icon alone | everything healthy and synced                                                  |
| `2 degraded`          | leads with the most urgent count; the breakdown is in the tooltip and the menu |
| `3 missing`           | nothing degraded                                                               |
| `5 out of sync`       | nothing degraded or missing                                                    |
| `prod unreachable`    | shown only once nothing else is known to be wrong                              |

The menu lists the degraded applications first, then missing, then out of sync, capped at 12 per
section. Selecting one opens it in ArgoCD.

## Reachability

Every instance is probed before it is queried, so a disconnected VPN is reported in under a
second and lists still render from cache. **Manage Instances** shows the state per row:

| Dot   | Means                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------ |
| green | answered 2xx, with the server version and the round-trip time                                    |
| amber | answered, but not 2xx or without a version. A wrong URL, a proxy in the way, or a broken server. |
| red   | nothing answered. `unreachable, check your VPN`.                                                 |
| grey  | not probed yet                                                                                   |

`⌘T` re-probes everything. The result is cached for 30 seconds.

## Troubleshooting

**"There is no single sign-on session yet"** - run **Log in with single sign-on** from Manage
Instances. If the login fails naming `oidc.cliClientID`, the provider client is not public yet;
see the setup above.

**"No argocd CLI session for \<host\>"** - the CLI has never logged in to that host. Run
`argocd login <host> --sso --grpc-web`. A config that only lists `kubernetes` (from `--core`) or
`localhost:8080` (from a port-forward) has no session for the host itself. Being logged in to
`gcloud` or having a working `kubectl` is unrelated: those authenticate to the cluster, not to
ArgoCD.

**"No API token stored for \<instance\>"** - use **Set API token**. Check what is stored with
`security find-generic-password -s raycast-argocd -a <instance-id> -w`. An empty answer means
the item exists with an empty password, which counts as no token.

**"unreachable, check your VPN"** - the probe got no answer at all. Connect the VPN and press
`⌘T` in Manage Instances, or `⌘⇧R` in the search command.

**An amber dot with a latency and a status** - the instance answered something other than 2xx on
`/api/version`. Usually the server URL points at something that is not an ArgoCD, or a proxy is
answering instead of it.

**A section says "cached 12 min ago, refresh failed"** - the cached list is still shown on
purpose. The reason is in the section subtitle, and `⌘R` retries that instance alone.

**Search ApplicationSets is empty, or every entry has a link icon** - the ApplicationSet API
returned nothing. Open Search Applications once so the reconstruction has a cache to read, and
see
[`openwiki/domain/argocd-api.md`](openwiki/domain/argocd-api.md#applicationsets-are-filtered-silently).

**The sync action is missing** - the instance has write operations off, or it is a `prod`
instance where they cannot be turned on.

**Results are truncated** - the list renders at most `Max Results` rows and says how many more
matched. Type more of the name, the project or the namespace.

## Development

```sh
npm test
npm run typecheck
npm run lint
npm run build
./scripts/check-no-secrets.sh
```

All five are required before a commit.
[`openwiki/development.md`](openwiki/development.md) explains what each one catches, how to run
the optional real-instance test, and the repository conventions.
