# Raycast ArgoCD extension - design

Date: 2026-09-08
Status: approved (autonomous mode, user explicitly delegated spec + plan + implementation)

## 1. Problem

Operators run several ArgoCD instances (one per environment). Finding an application means
opening the right web UI, waiting for the applications list to render, then filtering. On a
large instance that list is thousands of applications and the UI is slow to become useful.

Once the application is found, the three actions that matter are: open it in the web UI, look
at its sync status, and trigger a sync.

Raycast is already the operator's launcher. A Raycast extension collapses "find an app across
N ArgoCD instances and act on it" into a few keystrokes, with no browser tab.

## 2. Constraints

- **Scale**: the target instances hold ~2000 and ~2200 `Application` objects across ~70 and
  ~36 projects. Any design that fetches or renders full application objects is dead on arrival.
- **Auth**: the instances use Okta OIDC with PKCE, `admin.enabled: false`. The user does not
  want to generate long-lived API tokens.
- **Production is read-only** for the user. Write paths must be off by default and must never
  be reachable by accident.
- **No secrets in the repository.** No internal hostname, token, project name or cluster name
  in any committed file, including tests and fixtures.
- ArgoCD server version 3.5.x on both instances.

## 3. Non-goals (v1)

- Managing repositories, clusters, projects, or ApplicationSets.
- Rolling back, deleting, or terminating applications.
- Editing manifests or viewing live resource diffs.
- A menu-bar command polling every instance in the background (revisit once the read path is
  proven; it multiplies the cost of the constraint in section 2).

## 4. Architecture

```
src/
  lib/            pure TypeScript, no @raycast/api import, 100% unit-testable
    argocd/       REST client, field projection, sync request builder
    auth/         token providers (argocd CLI config, macOS keychain)
    cache/        on-disk projection cache with TTL
    search/       scorer and ranking
    config/       instance registry validation
    model/        status vocabulary (semantic enums, no Raycast types)
  ui/             React components, Raycast-aware
  search-applications.tsx     command entry point
  manage-instances.tsx        command entry point
```

The `lib/` and `ui/` split is the testability boundary: everything that can fail in an
interesting way lives in `lib/`, is injected with its dependencies (`fetch`, `exec`, clock,
filesystem), and is covered by vitest. `ui/` holds rendering and Raycast plumbing only.

### 4.1 Instance registry

Instances are user data, not build-time config: a Raycast preference cannot hold a variable
number of entries, and hardcoding hostnames would leak internal topology into git.

An instance is:

| field        | type                          | notes |
|--------------|-------------------------------|-------|
| `id`         | string (uuid)                 | stable key for cache files and keychain entries |
| `name`       | string                        | display name, e.g. `prod-tooling` |
| `baseUrl`    | string                        | `https://argocd.example.com`, normalised (no trailing slash) |
| `env`        | `prod` \| `preprod` \| `dev`  | drives the colour accent and the write guard default |
| `authMode`   | `cli` \| `token`              | see 4.2 |
| `allowWrite` | boolean, default `false`      | gates every non-GET call |
| `enabled`    | boolean, default `true`       | excluded from "All instances" when false |

Stored as JSON in Raycast `LocalStorage` under `instances/v1`. The `Manage Instances` command
is the only writer. Validation (URL shape, https-only, unique id, unique name) lives in
`lib/config/instances.ts` and is unit-tested.

Creating an instance with `env: prod` forces `allowWrite: false`; enabling writes on a prod
instance is a deliberate second step in the edit form. This is a UI guard on top of the
server-side RBAC, not a replacement for it.

### 4.2 Authentication

Two modes, no OAuth implementation of our own.

**`cli` (default).** The official `argocd` CLI already implements the Okta PKCE loopback flow
(`argocd login <host> --sso`) and persists the resulting bearer token, plus a refresh token,
in `~/.config/argocd/config` (mode 0600). The extension reads that file, finds the `users[]`
entry whose `name` matches the instance host, and uses `auth-token` as `Authorization: Bearer`.

Rationale: no new Okta redirect URI to register, no client secret in the extension, no secret
written by us, and the token lifecycle stays owned by the tool that already owns it. The cost
is a dependency on the `argocd` binary being installed and logged in.

Expiry is detected locally by decoding the JWT `exp` claim (decode only, never verify - the
server is the authority). When the token is expired or the server answers 401, the UI shows a
recoverable error with a **Log in with SSO** action that spawns
`argocd login <host> --sso --grpc-web` detached, polls the config file for a new token for up
to 120 s, and retries the request. Nothing about the token is ever logged or copied to the
clipboard.

**`token`.** For instances where a project API token is preferred. The token is stored in the
macOS keychain through `/usr/bin/security` (service `raycast-argocd`, account `<instance id>`),
never in `LocalStorage` and never in the repo. `security` is a system binary, so this keeps the
extension free of native dependencies.

### 4.3 Read path and cache

The whole design rests on one ArgoCD API detail: `GET /api/v1/applications` accepts a `fields`
query parameter (a comma-separated list of dotted paths, `-`-prefixed to invert it into an
exclusion list). It is undocumented in `swagger.json` but it is what the ArgoCD web UI itself
uses for its applications list, on the same endpoint, in this exact version. Without it the
response carries the full spec, status, resource list, operation state and sync history of
every application: tens of megabytes.

The projection requested is:

```
items.metadata.name
items.metadata.namespace
items.metadata.resourceVersion
items.spec.project
items.spec.destination
items.spec.source.repoURL
items.spec.source.path
items.spec.source.targetRevision
items.spec.sources
items.status.sync.status
items.status.sync.revision
items.status.health.status
items.status.operationState.phase
items.status.operationState.finishedAt
metadata.resourceVersion
```

That is roughly 300 bytes per application, so ~700 kB for 2200 applications before transport
compression. The client sends `accept-encoding: gzip`.

**Degradation.** If a server ignores `fields` (older or patched build), the response is simply
larger; the projection function reads the same paths either way, so the feature degrades in
cost, not in correctness. No feature detection needed.

**Cache.** Each instance gets `<supportPath>/cache/<instanceId>.json`:

```jsonc
{ "schema": 1, "fetchedAt": 1757280000000, "resourceVersion": "…", "apps": [ /* projections */ ] }
```

Read synchronously on mount, so the list renders from disk with zero network latency. A
refresh is kicked off in the background when the entry is older than `cacheTtlSeconds`
(extension preference, default 60) and on demand with `⌘R`. This is stale-while-revalidate:
the user always sees something instantly and the freshness indicator says how stale it is.

A corrupt or schema-mismatched cache file is discarded, not repaired.

Refreshes across instances run concurrently, each with its own `AbortController` timeout
(`requestTimeoutSeconds`, default 15). One unreachable instance degrades to "showing cached
data from N minutes ago" for that instance only; the others still refresh.

`resourceVersion` is persisted for a future delta refresh via `/api/v1/stream/applications`.
v1 does a full projected refresh: at ~700 kB and sub-second it is not worth the complexity of
maintaining a watch inside a short-lived Raycast command.

### 4.4 Search and rendering

Rendering is the bottleneck, not filtering. 4000+ `List.Item` nodes will not be rendered:

- Raycast's built-in filtering is disabled (`filtering={false}`); the extension owns the query.
- Each cached application carries a precomputed lowercase haystack (`name project namespace
  destinationNamespace repoPath`) built once at load, so a keystroke never re-lowercases the
  corpus.
- The scorer is a cheap two-tier match: exact/prefix/substring on the name (highest weight),
  then substring on the haystack. Ties break on instance order then name. No fuzzy
  subsequence matching in v1 - it is measurably slower and, for application names, worse.
- Results are capped at 60 items. The footer states when results were truncated.
- With an empty query, the list shows a **Recent** section (last 10 applications opened,
  tracked in `LocalStorage`) followed by out-of-sync and degraded applications, then the
  head of the alphabetical list. An operator's empty-query view should be "what is broken",
  not "the first 60 names alphabetically".

The scope dropdown offers `All instances` plus one entry per enabled instance. In `All`
mode results are grouped in a `List.Section` per instance.

### 4.5 Application actions

Selecting an application pushes a detail view fed by
`GET /api/v1/applications/{name}?appNamespace=…&fields=…` (a wider projection than the list,
including `status.conditions`, `status.summary`, `status.operationState.message`,
`status.history[0]`).

Actions, in order:

1. **Open in ArgoCD** - `{baseUrl}/applications/{namespace}/{name}`.
2. **Show sync status** - pushes the live status view (4.6).
3. **Refresh application** - `GET …?refresh=normal`, and `refresh=hard` behind `⌘⇧R`. This is
   a GET, so it stays available on read-only instances.
4. **Sync…** - opens the sync form (4.6). Hidden entirely when `allowWrite` is false.
5. **Quick sync** - sync with default options, behind a confirmation alert.
6. Copy application name, copy URL, open repository URL.

### 4.6 Sync

`POST /api/v1/applications/{name}/sync` with a body assembled by
`lib/argocd/sync.ts::buildSyncRequest`, a pure function over the form values:

| form control              | request field |
|---------------------------|---------------|
| Revision (optional)       | `revision` |
| Prune                     | `prune` |
| Dry run                   | `dryRun` |
| Apply only (no hooks)     | `strategy.apply` |
| Force                     | `strategy.apply.force` / `strategy.hook.force` |
| Replace                   | `syncOptions.items += "Replace=true"` |
| Server-side apply         | `syncOptions.items += "ServerSideApply=true"` |
| Prune last                | `syncOptions.items += "PruneLast=true"` |
| Skip schema validation    | `syncOptions.items += "Validate=false"` |
| Retry (limit, backoff)    | `retryStrategy` |

Defaults mirror the ArgoCD UI: everything off, no revision override, no retry. `strategy` is
omitted when "apply only" is off so the server applies its own default (hook strategy).

Guards, in order:
1. `allowWrite` false on the instance: the action does not exist in the UI, and the client
   layer throws `ReadOnlyInstanceError` before building a request. Two independent checks, so
   a UI regression cannot produce a write.
2. A confirmation alert naming the instance and the application, with the instance environment
   in the title.
3. `dryRun` is offered prominently as the first thing in the form.

After submission the sync form pops and pushes the live status view.

**Live status view.** Polls `GET /api/v1/applications/{name}?fields=<status projection>` every
2 s while `status.operationState.phase` is `Running` or `Terminating`, then stops. Polling a
single projected application is a few kilobytes; an SSE stream inside a Raycast view buys
nothing here and fails less gracefully. The view shows phase, message, started/finished time,
the sync result resource list with per-resource status, and the resulting health.

### 4.7 Error handling

Errors are typed in `lib/argocd/errors.ts` and each maps to one recoverable UI state:

| error                   | trigger                    | UI |
|-------------------------|----------------------------|----|
| `AuthError`             | 401, or locally-expired JWT | "Log in with SSO" action |
| `ForbiddenError`        | 403                        | "your account cannot do this on `<instance>`" |
| `NotFoundError`         | 404                        | app removed; offer a refresh |
| `TimeoutError`          | abort                      | falls back to cache, shows staleness |
| `NetworkError`          | fetch reject               | falls back to cache, shows staleness |
| `ReadOnlyInstanceError` | local guard                | should be unreachable; shown as a bug |
| `ApiError`              | any other non-2xx          | status + server message |

No error path logs a token, a URL with a query string, or a response body verbatim.

## 5. Testing

vitest, on `src/lib/**` only. The Raycast runtime is not exercised; `ui/` is validated by
`ray build` and `ray lint`.

Covered:

- `config/instances`: URL normalisation, https enforcement, duplicate detection, prod forcing
  `allowWrite: false` on create.
- `auth/cliConfig`: YAML parsing, host matching (with and without port, scheme-stripped),
  missing user entry, JWT `exp` decoding including malformed and unpadded base64url.
- `auth/keychain`: argv construction for read/write/delete, injected `exec`, non-zero exit.
- `argocd/client`: URL and `fields` assembly, `appNamespace` handling, gzip header, timeout via
  injected `AbortController`, status-to-error mapping, read-only guard on writes.
- `argocd/project`: projecting a raw application (full and already-projected) into the summary,
  tolerating absent `status`, multi-source applications.
- `argocd/sync`: every checkbox combination that changes the body shape, and that an all-default
  form produces `{}` plus nothing else.
- `cache/store`: TTL boundaries, corrupt JSON, wrong schema version, concurrent write safety.
- `search/score`: ranking order, cap, empty query behaviour, no-match, case folding.
- `model/status`: exhaustive mapping of ArgoCD health and sync vocabularies, unknown values.

Fixtures use `https://argocd.example.com`, application names like `app-one`, project `team-a`.
No fixture is derived from a real cluster.

## 6. Risks

- **`fields` support**: undocumented in swagger. Mitigated by the degradation property in 4.3.
- **`argocd` CLI dependency**: if absent or never logged in, the `cli` auth mode fails with a
  clear message and the `token` mode is the fallback. Both are surfaced in the onboarding empty
  state.
- **Okta token lifetime** (60 min): re-login is a two-keystroke action, not a reconfiguration.
- **Raycast `LocalStorage` is not encrypted**: hence no token in it, keychain only.
