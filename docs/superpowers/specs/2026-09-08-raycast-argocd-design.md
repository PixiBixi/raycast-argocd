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

- Managing repositories, clusters or projects.
- Creating, editing or deleting ApplicationSets. The extension reads them and navigates from
  one to the applications it generated; it does not modify them.
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
  search-applicationsets.tsx  command entry point
  manage-instances.tsx        command entry point
```

The `lib/` and `ui/` split is the testability boundary: everything that can fail in an
interesting way lives in `lib/`, is injected with its dependencies (`fetch`, `exec`, clock,
filesystem), and is covered by vitest. `ui/` holds rendering and Raycast plumbing only.

### 4.1 Instance registry

Instances are user data, not build-time config: a Raycast preference cannot hold a variable
number of entries, and hardcoding hostnames would leak internal topology into git.

An instance is:

| field        | type                         | notes                                                        |
| ------------ | ---------------------------- | ------------------------------------------------------------ |
| `id`         | string (uuid)                | stable key for cache files and keychain entries              |
| `name`       | string                       | display name, e.g. `prod-tooling`                            |
| `baseUrl`    | string                       | `https://argocd.example.com`, normalised (no trailing slash) |
| `env`        | `prod` \| `preprod` \| `dev` | drives the colour accent and the write guard default         |
| `authMode`   | `cli` \| `token`             | see 4.2                                                      |
| `allowWrite` | boolean, default `false`     | gates every non-GET call                                     |
| `enabled`    | boolean, default `true`      | excluded from "All instances" when false                     |

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

The ArgoCD API has no field projection. The web UI sends a `fields` query parameter on the
applications list, which reads like one, and it is not: `ApplicationQuery` in the v3.5.1 proto
declares exactly eight fields (`name`, `refresh`, `projects`, `resourceVersion`, `selector`,
`repo`, `appNamespace`, `project`), `fields` is not among them, and the server's own
`swagger.json` does not document it. The parameter is accepted and ignored. An earlier draft of
this design was built on it; it was measured, found to do nothing, and removed. Sending a
parameter that changes nothing would only mislead the next reader.

What the API does offer for narrowing a list is `projects`, `selector`, `repo` and
`appNamespace`. None of them helps when the question is "every application on this instance".

So the read path was measured instead, on a real instance holding 2053 applications:

|                                                          |             |
| -------------------------------------------------------- | ----------- |
| compact JSON of the full list                            | 30.2 MB     |
| the same list gzipped, which is what crosses the network | **2.97 MB** |
| `JSON.parse` of the full list                            | 85 ms       |
| peak heap while projecting                               | ~51 MB      |
| the projection that gets cached                          | 289 kB      |

That settles the design. One full list per refresh is affordable; holding it is not, and
re-deriving it on every keystroke would be absurd. So:

- the response is projected to the row model as soon as it is parsed, and the raw body is
  dropped (`lib/argocd/project.ts`);
- the projection, two orders of magnitude smaller, is what gets cached to disk;
- `Accept-Encoding` is deliberately **not** set by hand: Node's `fetch` negotiates gzip itself
  and decompresses the body, and setting the header manually is how a caller ends up holding a
  compressed buffer.

**Cache.** Each instance gets `<supportPath>/cache/<instanceId>.json`:

```jsonc
{ "schema": 1, "fetchedAt": 1757280000000, "resourceVersion": "…", "apps": [/* projections */] }
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
`GET /api/v1/applications/{name}?appNamespace=…`. One application is a few tens of kilobytes,
so the detail view reads the whole object and projects the extra fields it needs on top of the
row model: `status.conditions`, `status.summary.images`, `status.operationState.message`, and
the most recent `status.history` entry.

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

| form control           | request field                                  |
| ---------------------- | ---------------------------------------------- |
| Revision (optional)    | `revision`                                     |
| Prune                  | `prune`                                        |
| Dry run                | `dryRun`                                       |
| Apply only (no hooks)  | `strategy.apply`                               |
| Force                  | `strategy.apply.force` / `strategy.hook.force` |
| Replace                | `syncOptions.items += "Replace=true"`          |
| Server-side apply      | `syncOptions.items += "ServerSideApply=true"`  |
| Prune last             | `syncOptions.items += "PruneLast=true"`        |
| Skip schema validation | `syncOptions.items += "Validate=false"`        |
| Retry (limit, backoff) | `retryStrategy`                                |

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

**Live status view.** Polls `GET /api/v1/applications/{name}?appNamespace=…` every 2 s while
`status.operationState.phase` is `Running` or `Terminating`, then stops. One application is a
few tens of kilobytes, so the poll is cheap; an SSE stream inside a Raycast view buys nothing
here and fails less gracefully. The view shows phase, message, started/finished time,
the sync result resource list with per-resource status, and the resulting health.

### 4.8 ApplicationSets

Almost every application on the target instances is generated by an ApplicationSet: 2034 of
2053 on one, out of 872 ApplicationSets. "Which applications did this ApplicationSet produce,
and are they all healthy" is therefore a first-class question, not a nice-to-have.

The link is `metadata.ownerReferences[kind == "ApplicationSet"].name`. ArgoCD's ApplicationSet
controller sets it on every application it generates, and because owner references are
namespace-scoped the ApplicationSet always lives in the application's own namespace. So
`(namespace, ownerName)` identifies the parent unambiguously, and no extra API call is needed
to answer the question: the answer is already in the applications cache.

`AppSummary` therefore carries `appSetName: string | undefined`, projected from that owner
reference.

A third command, **Search ApplicationSets**, lists ApplicationSets from
`GET /api/v1/applicationsets` with the same field-projection and caching treatment as
applications. Fetching them rather than deriving the list from the applications cache costs one
small request per instance and buys two things the cache cannot give: ApplicationSets that
currently generate nothing, and `status.conditions`, which is where a broken generator reports
itself.

Each row shows the ApplicationSet name, its project, and a rollup of the applications it owns
computed locally from the applications cache: total, out-of-sync count, degraded count. The
rollup is free, and it is the number an operator actually looks for.

Actions on an ApplicationSet:

1. **Show generated applications** - pushes the application list filtered to that parent, with
   the same rendering, search and actions as the main command.
2. **Open in ArgoCD** - `{baseUrl}/applicationsets/{namespace}/{name}`.
3. **Copy name**.

The application detail view gains the reverse link: when `appSetName` is set, the metadata panel
shows it and an action pushes the same filtered list, so an operator who lands on one broken
application can immediately see its siblings.

The filtered list is a pure client-side filter over the cache, so it opens instantly and is
never a second network round trip.

### 4.9 Reachability

The instances sit behind a VPN. Off it, every request hangs until its timeout, which turns a
15 s request timeout into a 15 s command that ends in a stack of errors. That is the wrong
failure: the operator does not have a broken instance, they have a disconnected laptop, and the
extension should say so in under a second.

`GET {baseUrl}/api/v1/version` answers 200 without authentication on ArgoCD 3.x, which makes it
the right probe: it proves the network path and the server, it costs one small response, and it
cannot be confused with an authorisation problem.

```ts
type ReachabilityState = "reachable" | "unreachable" | "unknown";
interface Reachability {
  state: ReachabilityState;
  checkedAt: number;
  latencyMs: number | undefined;
  version: string | undefined;
  reason: string | undefined;
}
```

The probe uses its own short timeout (`probeTimeoutSeconds`, default 4) rather than the request
timeout: waiting 15 s to learn the VPN is down is the exact problem being solved. Any HTTP
response at all, including a 4xx or a 5xx, counts as `reachable` - the server answered, so the
network path exists. Only a transport failure or the timeout is `unreachable`.

Results are cached per instance in `LocalStorage` with a 30 s TTL, so opening the command twice
in a row does not re-probe, and a VPN that just came up is picked up on the next open.

How it is used:

- **Manage Instances** shows the state per row: a green dot with the server version and the
  round-trip time, a red dot reading `unreachable, check your VPN`, or a grey dot before the
  first probe. `⌘T` re-probes every instance.
- **Search Applications** probes every enabled instance concurrently on mount, before any
  applications call. An instance that comes back `unreachable` is not queried at all: its
  section renders from cache with the subtitle `cached N minutes ago, instance unreachable`.
  This is what keeps the command fast off the VPN instead of slow and broken.
- Because the probe is unauthenticated, a `reachable` instance that then answers 401 is
  unambiguously an expired session, and the UI offers the SSO login rather than a network
  error.

### 4.7 Error handling

Errors are typed in `lib/argocd/errors.ts` and each maps to one recoverable UI state:

| error                   | trigger                     | UI                                            |
| ----------------------- | --------------------------- | --------------------------------------------- |
| `AuthError`             | 401, or locally-expired JWT | "Log in with SSO" action                      |
| `ForbiddenError`        | 403                         | "your account cannot do this on `<instance>`" |
| `NotFoundError`         | 404                         | app removed; offer a refresh                  |
| `TimeoutError`          | abort                       | falls back to cache, shows staleness          |
| `NetworkError`          | fetch reject                | falls back to cache, shows staleness          |
| `UnreachableError`      | probe says unreachable      | "check your VPN", cache still rendered        |
| `ReadOnlyInstanceError` | local guard                 | should be unreachable; shown as a bug         |
| `ApiError`              | any other non-2xx           | status + server message                       |

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
- `argocd/client`: URL assembly with no query parameter the API would ignore, `appNamespace`
  handling, no hand-set `Accept-Encoding`, timeout via an injected abort signal,
  status-to-error mapping, and the read-only guard refusing a write before `fetch` is reached.
- `argocd/project`: projecting a raw application (full and already-projected) into the summary,
  tolerating absent `status`, multi-source applications.
- `argocd/sync`: every checkbox combination that changes the body shape, and that an all-default
  form produces `{}` plus nothing else.
- `cache/store`: TTL boundaries, corrupt JSON, wrong schema version, concurrent write safety.
- `search/score`: ranking order, cap, empty query behaviour, no-match, case folding, filtering
  by parent ApplicationSet.
- `argocd/probe`: 200 is reachable with a latency and a version, 4xx and 5xx are reachable, a
  transport failure and an abort are unreachable, the probe carries no Authorization header,
  and the TTL logic re-probes only after it lapses.
- `argocd/appset`: projecting an ApplicationSet, and rolling up the applications a given
  ApplicationSet owns out of the applications cache.
- `model/status`: exhaustive mapping of ArgoCD health and sync vocabularies, unknown values.

Fixtures use `https://argocd.example.com`, application names like `app-one`, project `team-a`.
No fixture is derived from a real cluster.

## 6. Risks

- **List size growth**: the read path is sized on 2.97 MB gzipped for 2053 applications. It
  scales linearly, so an instance an order of magnitude larger would need the `projects`
  filter and per-project caching. The cache is already keyed per instance, so that change is
  local to `useApplications`.
- **The CLI loopback redirect may not be registered.** Verified against the real identity
  provider: `argocd login <host> --sso` serves its callback on
  `http://localhost:8085/auth/callback`, and the OIDC client ArgoCD is configured with does not
  list that URI, so the provider refuses the request outright with "the redirect_uri parameter
  must be a Login redirect URI in the client app settings". The `cli` mode is therefore
  unusable until either that URI is added to the client, or `oidc.cliClientID` in `argocd-cm`
  points at a client that has it. This is why the `token` mode is a first-class path and not a
  fallback: it needs nothing from the identity provider. The README leads with the check.
- **`argocd` CLI dependency**: if absent or never logged in, the `cli` auth mode fails with a
  clear message naming the login command.
- **Okta token lifetime** (60 min): re-login is a two-keystroke action, not a reconfiguration.
- **Raycast `LocalStorage` is not encrypted**: hence no token in it, keychain only.
- **The probe endpoint is unauthenticated**: it is used only to decide whether to attempt a
  request. Nothing in the UI treats a successful probe as an authorisation.
- **ApplicationSets in a namespace the user cannot list**: the applications list is the source
  of truth for the rollup, so an ApplicationSet the user cannot see simply does not appear;
  its applications, if visible, still show their parent name in the detail view.
