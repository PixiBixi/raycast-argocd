# What the ArgoCD API does not do

This is the most useful page in the wiki for anyone changing how the extension talks to ArgoCD,
because everything on it was learned the expensive way: by shipping code that assumed the
server did something, and finding out it did not.

The pattern is always the same. **A field is declared, or a parameter is accepted, and that was
treated as evidence the server does something with it.** It is not. Verify against the proto,
the live `swagger.json`, or a real response before relying on any of it.

Verified against ArgoCD **3.5.1**.

## There is no field projection

`GET /api/v1/applications` accepts a `fields` query parameter and **ignores it**.

The ArgoCD web UI sends one, on that exact endpoint, which is what made this look real. But
`ApplicationQuery` in the v3.5.1 proto (`server/application/application.proto`) declares exactly
eight fields, and `fields` is not among them:

```
name, refresh, projects, resourceVersion, selector, repo, appNamespace, project
```

The server's own `swagger.json`, publicly readable at `<argocd>/swagger.json`, does not document
it either. The parameter is accepted and discarded, so sending it would only mislead the next
reader.

The four parameters that **do** narrow a list are recorded in
[`src/lib/argocd/fields.ts`](../../src/lib/argocd/fields.ts) as `SUPPORTED_LIST_FILTERS`:
`projects`, `selector`, `repo`, `appNamespace`. None helps when the question is "every
application on this instance", which is why the read path is built the way
[read-path.md](../architecture/read-path.md) describes.

An earlier design was built entirely on `fields`. It was measured, found to do nothing, and
removed. **Do not add it back.**

## The version endpoint is not under `/v1`

`GET /api/version` is the version endpoint. `GET /api/v1/version` is a **404**.

The consequence was worse than the typo. The reachability probe treats any HTTP answer as
reachable, by design, because the server answering proves the network path exists. So a 404
rendered as a green dot with a latency and no version, which reads as healthy. The path was
wrong for hours without anything saying so.

[`probe.ts`](../../src/lib/argocd/probe.ts) now exports `VERSION_PATH` and the test asserts the
exact path **and** that it contains no `/v1/`, because getting it wrong is silent by
construction. A reachable probe also keeps its non-2xx status in `reason`, which the UI always
shows, and the dot turns amber when the answer was not a 2xx or carried no version.

## The `diff` field is declared and empty

`GET /api/v1/applications/{name}/managed-resources` returns entries whose schema
(`v1alpha1ResourceDiff`) declares a `diff` field. **ArgoCD does not populate it.** Its own web
UI computes the diff in the browser from `targetState` and `normalizedLiveState`.

The first version of the diff view rendered that field, and reported no difference on an
application whose web UI showed a clear change to an `ExternalSecret` tracking-id annotation.

So the extension computes the diff:

- [`src/lib/diff/manifest.ts`](../../src/lib/diff/manifest.ts) renders each state to stable
  YAML-shaped text **with sorted keys**. Sorting is load-bearing, not cosmetic: two
  serialisations of the same object order their keys differently, and a raw diff would call
  every line changed. It also drops what ArgoCD's own diff ignores, which is `status` (the
  cluster writes it, not git) and, under `metadata`, `managedFields`, `creationTimestamp`,
  `generation`, `resourceVersion`, `uid` and `selfLink`. Annotations are kept, since a
  tracking-id change is exactly the kind of difference that matters.
- [`src/lib/diff/lineDiff.ts`](../../src/lib/diff/lineDiff.ts) computes a longest common
  subsequence over lines and renders hunks with three lines of context. The table is quadratic,
  which is the right trade for readable code on manifests of hundreds of lines, and
  `MAX_LINES = 4000` is the guard that keeps it true. Past that, the resource is reported as
  too large rather than compared.

`projectResourceDiff` derives `modified` from the computed diff rather than trusting the API's
flag, reports `added` and `removed` counts, and drops `liveState`, `targetState` and
`predictedLiveState` as soon as the diff is rendered, since those three are the whole payload.

ArgoCD's own `diff` string is still used **if** it ever turns out to be non-empty.

One of the manifest tests is built directly from the reported real case, so a regression would
reproduce the original complaint.

## ApplicationSets are filtered silently

`GET /api/v1/applicationsets` returns **200 with an empty list** on the development instance,
while 872 ApplicationSets exist there.

It returns only ApplicationSets whose namespace the server has enabled **for ApplicationSets**,
which is a switch separate from the one enabling applications in any namespace, and it filters
without erroring. There is no error to surface and nothing a client can do about it. Fixing it
properly needs `applicationsetcontroller.namespaces` and the matching argocd-server setting,
which is a server change.

So [`src/lib/argocd/appset.ts`](../../src/lib/argocd/appset.ts) reconstructs them from the
applications cache. The ApplicationSet controller stamps an `ownerReference` on every
application it generates, and owner references are namespace-scoped, so
`(instanceId, namespace, ownerName)` identifies the parent unambiguously with no extra request
and no extra permission. Measured: **807 of the 872 recovered from 2053 applications**, the
missing ones being those that currently generate nothing.

`mergeAppSets` prefers the API's answer wherever it has one, since only it carries
`status.conditions` and only it knows about an ApplicationSet that generated nothing. A
reconstructed entry is marked with a link icon and counted in the section subtitle, so the list
never claims to know more than it does.

The coupling this creates is real and worth remembering: **Search ApplicationSets needs Search
Applications to have run once**, because the reconstruction reads that cache. The empty state
says so.

Whether production behaves the same way is **unmeasured**. Only development was observed.

## What the API does give you, usefully

Worth knowing, because two of these avoid a request entirely.

| Source                                | Contains                                                                             | Cost                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `status.resources` on the application | Every managed object with sync status, health, `hook`, `requiresPruning`, `syncWave` | **Free**, it is inside the application              |
| `metadata.ownerReferences`            | The parent ApplicationSet                                                            | **Free**, and 2034 of 2053 applications carry one   |
| `spec.syncPolicy`                     | `automated` with `prune`, `selfHeal`, `allowEmpty`, plus `syncOptions`               | Free                                                |
| `status.history[]`                    | Past deployments with `revision`, `deployedAt`, `deployStartedAt`, `initiatedBy`     | Free                                                |
| `revisions/{revision}/metadata`       | `author`, `date`, `message` for a revision                                           | One small request                                   |
| `managed-resources`                   | `targetState` and `normalizedLiveState` per resource                                 | Heavy; narrow it with the resource parameters       |
| `POST /{name}/sync`                   | `revision`, `prune`, `dryRun`, `strategy`, `syncOptions`, `retryStrategy`            | Mapped by [`sync.ts`](../../src/lib/argocd/sync.ts) |

Endpoints deliberately **not** used yet, all confirmed present in the swagger: `/events`,
`/logs`, `/resource-tree`, `/syncwindows`, `/resource/actions`, `/rollback`,
`DELETE /operation`.

## One subtlety that is easy to get wrong

On a resource in `status.resources`, an **empty** `status` is not `Unknown`. It means ArgoCD has
not compared that resource yet. `projectResources` preserves the distinction as `""`, and
`resourceNeedsAttention` does not flag it. Collapsing the two would make healthy resources
appear broken.

## How to verify a claim about this API

The instances expose two endpoints without authentication, which is enough to check most
things:

```sh
curl -s https://<argocd>/api/version
curl -s https://<argocd>/swagger.json | python3 -c "
import json,sys
s=json.load(sys.stdin)
op=s['paths']['/api/v1/applications']['get']
print([p.get('name') for p in op['parameters']])"
```

For anything the swagger does not settle, read the proto at the matching tag:
`server/application/application.proto` in `argoproj/argo-cd`. That is what settled `fields`.
