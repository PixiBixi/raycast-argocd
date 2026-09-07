# ArgoCD for Raycast

Search applications across several ArgoCD instances from Raycast, then open, inspect or sync
the one you found. Built for instances holding thousands of applications behind a VPN.

## Commands

| Command                | What it does                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Search Applications    | Searches every configured instance at once, or one of them. Renders from a local cache first, then refreshes behind you. |
| Search ApplicationSets | Lists ApplicationSets with a rollup of the applications each one generated, and jumps to them.                           |
| Manage Instances       | Adds, edits and removes instances, shows whether each is reachable, and handles the SSO login and API tokens.            |

## Install

Requires Raycast on macOS, Node 22.22.2 or later, and the `argocd` CLI if you use the SSO
authentication mode.

```sh
npm install
npm run dev
```

The three commands appear at the top of Raycast's root search. `Ctrl-C` stops the dev server and
leaves the extension installed.

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

### argocd CLI session, the default

The official CLI already implements the OIDC PKCE loopback flow and stores the resulting bearer
token in `~/.config/argocd/config` (mode 0600). The extension reads that file, matches the
`users[]` entry against the instance host, and uses the token. Nothing new is registered with
your identity provider, no client secret lives in the extension, and no credential is written by
it.

Log in once per instance:

```sh
argocd login argocd.example.com --sso --grpc-web
```

Verify it worked:

```sh
argocd account get-user-info --server argocd.example.com --grpc-web
```

When the token expires, the extension offers a **Log in with SSO** action that runs that command
for you and waits for the new token.

If your identity provider rejects the CLI's loopback redirect
(`http://localhost:8085/auth/callback`), either register that redirect URI on the OIDC client,
set `oidc.cliClientID` in `argocd-cm` to a client that has it, or use the API token mode below.

### API token in the keychain

For instances where a token is preferred, or where the SSO loopback is not available.

```sh
argocd account generate-token --account <account-name> --server argocd.example.com --grpc-web
```

Set the instance's authentication mode to `API token in the keychain`, then use **Set API
token**. The token goes into the macOS keychain under the service `raycast-argocd`, keyed by the
instance id. It is never written to Raycast's storage, which is not encrypted, and never appears
in a command line, a log or the clipboard.

Inspect or remove it yourself with:

```sh
security find-generic-password -s raycast-argocd -a <instance-id> -w
security delete-generic-password -s raycast-argocd -a <instance-id>
```

## Reachability

Instances behind a VPN would otherwise make every command wait out its full request timeout
before failing. Each instance is probed first with an unauthenticated
`GET /api/v1/version` and a short timeout, so a disconnected VPN is reported in under a second
and the list still renders from cache. An instance that comes back unreachable is not queried at
all.

**Manage Instances** shows the state per row: green with the server version and round-trip time,
red with `unreachable, check your VPN`, or grey before the first probe. `⌘T` re-probes
everything. The result is cached for 30 seconds, so a VPN that just came up is picked up on the
next open.

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

| Action                               | Shortcut          | Notes                                                            |
| ------------------------------------ | ----------------- | ---------------------------------------------------------------- |
| Show details                         | `↵`               | Sync, health, source, destination, conditions, last sync result. |
| Open in ArgoCD                       |                   | Deep link to the application in the web UI.                      |
| Show sync status                     | `⌘Y`              | Follows a running sync until it finishes.                        |
| Refresh application                  | `⌘R`              | `refresh=normal`. A read, so it works on read-only instances.    |
| Hard refresh application             | `⌘⇧R`             | `refresh=hard`.                                                  |
| Sync with options                    |                   | Only on an instance with write operations allowed.               |
| Quick sync                           |                   | Default options, behind a confirmation.                          |
| Show sibling applications            |                   | The other applications the same ApplicationSet generated.        |
| Copy name, copy URL, open repository | `⌘⇧C` for the URL |                                                                  |

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
`localhost:8080` (from a port-forward) has no session for the host itself.

**Everything worked and now returns 401** - the OIDC token has a limited lifetime, typically one
hour. Use **Log in with SSO** from the empty state or from Manage Instances.

**"unreachable, check your VPN"** - the probe got no answer at all. Connect the VPN and press
`⌘T` in Manage Instances, or `⌘⇧R` in the search command. Any HTTP answer, including a 4xx,
counts as reachable, so this really does mean nothing answered.

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
