# The read path

Everything about how this extension reads from ArgoCD follows from one number: **a Raycast
command gets a 100 MB JS heap**, and one applications list does not fit in it.

## The measurements

Taken against a real instance holding 2053 applications, with
`node --max-old-space-size=100`, before and after the fix. Not estimated.

|                                                          |             |
| -------------------------------------------------------- | ----------- |
| Compact JSON of the full applications list               | 30.2 MB     |
| The same list gzipped, which is what crosses the network | **2.97 MB** |
| `JSON.parse` of the whole list                           | 85 ms       |
| Peak heap holding the body (`response.json()`)           | **58 MB**   |
| Peak heap streaming and projecting element by element    | **35 MB**   |
| Peak heap for two instances read one after the other     | 43 MB       |
| The projection that gets cached                          | 1.49 MB     |
| Applications the projection drops                        | 0 of 2053   |
| Ranking the whole corpus, worst case                     | 7.4 ms      |

58 MB for one instance is why two instances refreshing in parallel hit the limit and Raycast
killed the command. The transfer was never the problem; **holding** the response was.

These numbers are kept in code, in
[`src/lib/argocd/fields.ts`](../../src/lib/argocd/fields.ts), so the reasoning sits next to
what depends on it.

## The four consequences

### 1. List responses are streamed, never materialised

[`src/lib/argocd/stream.ts`](../../src/lib/argocd/stream.ts) consumes the response body as a
stream and yields the elements of the top-level `items` array one at a time. Each is projected
to the row model and dropped. `response.json()` is never called on a list; a test asserts that,
so the regression cannot come back quietly.

The scanner does not parse JSON. It finds the named array, then tracks brace and bracket depth,
string state and escapes to know where each element ends, handing that slice to `JSON.parse`.
That is narrow enough to test exhaustively, which a general streaming parser would not be, and
it is tested at every chunk size from one byte upward, with braces and commas inside strings,
escaped quotes straddling chunk boundaries, and multi-byte characters split byte by byte.

`decodeStream` in the same file decodes bytes with `TextDecoder({stream: true})` so a character
split across chunks is not mangled, and accepts either an async iterable or a web
`ReadableStream`.

Single-application reads still use `response.json()`. They are tens of kilobytes.

### 2. Only the projection is kept

[`src/lib/argocd/project.ts`](../../src/lib/argocd/project.ts) turns each raw application into
an `AppSummary`: the fields the list renders and searches on, and nothing else. 30.2 MB becomes
1.49 MB.

Every accessor is defensive, and an application that cannot be identified is **dropped** rather
than replaced with a placeholder, which would appear as a phantom row. On the real corpus
nothing is dropped, which the optional
[`tests/lib/real-instance.test.ts`](../../tests/lib/real-instance.test.ts) re-checks against
your own instance when `REAL_APPS_JSON` points at a `kubectl get applications -A -o json` dump.

Each summary carries a precomputed lowercased `haystack`. Building it once at projection time is
why a keystroke never re-lowercases a few thousand strings.

### 3. Instances are refreshed one at a time

[`src/ui/loadApplications.ts`](../../src/ui/loadApplications.ts) is the whole read path, and its
ordering is the point:

1. **Every instance's cache is read from disk** and handed to the caller via `onCached`, so the
   list paints before any network call.
2. **Every instance is probed concurrently** with a short timeout, so a VPN that is down is
   known in well under a second.
3. **The reachable instances whose cache is stale are listed sequentially.**

Step 3 is sequential deliberately. It saves 4 MB today (43 versus 47), which is not the reason;
the reason is that sequential keeps the peak **flat** as instances are added, where concurrent
grows it linearly against a fixed heap. The refresh happens behind an already-rendered cache,
so nothing about it is visible.

An instance that fails at any step keeps its cached applications and carries the reason. One
broken or unreachable instance never empties a list.

### 4. The list never renders more than a capped number of rows

Rendering is the bottleneck, not matching. Raycast's own filtering is disabled and
[`src/lib/search/score.ts`](../../src/lib/search/score.ts) ranks instead, capped at
`maxResults` (default 60, clamped 10 to 200). When the result is truncated the section subtitle
says how many more matched.

Ranking the whole 2053-application corpus for a single-letter query, which matches every row,
takes 7.4 ms. A keystroke has roughly 16 ms before it is felt. There is deliberately no fuzzy
subsequence matching: it is measurably slower and, on names shaped like
`apache-druid-bidder-euw1-staging`, produces confident nonsense. A substring match on the name
is what an operator means.

Multi-word queries are AND, which is what makes `team-a redis` a way to narrow thousands of
rows. With an empty query, `defaultOrder` shows recently opened applications first, then
whatever needs attention, then the rest: "the first sixty names alphabetically" is never the
useful answer.

## The cache

[`src/lib/cache/store.ts`](../../src/lib/cache/store.ts), one JSON file per instance under
`<supportPath>/cache/<instanceId>.json`.

Raycast starts a command cold every time it is opened, so without this the first paint waits on
a list of thousands of applications. Writes go through a temporary file and a `rename`, because
a command killed mid-write must not leave a truncated cache that then has to be diagnosed.

A corrupt file, or one from an older `CACHE_SCHEMA`, is **discarded rather than migrated**. It
is derived data that one refresh rebuilds. The schema is currently `2`; it was bumped when
`resourceVersion` left the entry, because streaming reads only the `items` array and never sees
the top-level metadata, and nothing had ever read that field.

An instance id containing a path separator or `..` throws rather than escaping the cache
directory. Ids are generated, but this file is the last place that can tell.

## Reachability

[`src/lib/argocd/probe.ts`](../../src/lib/argocd/probe.ts). `GET {baseUrl}/api/version`,
unauthenticated, with its own short timeout (default 4 s, clamped 1 to 30).

Off the VPN, three instances at a 15 s request timeout means 45 s to arrive at "everything is
broken" when the answer is "you are not connected". The probe makes that a sub-second answer,
and an instance that comes back unreachable is not queried at all.

**Any HTTP answer counts as reachable**, including a 4xx, because the server answered and the
network path exists. Only a transport failure or the timeout is unreachable. That design has a
sharp edge, and it drew blood once: the probe was originally written against
`/api/v1/version`, which is a 404, and a 404 rendered as a green dot with a latency and no
version, which reads as healthy. So a reachable probe now keeps its non-2xx status in `reason`,
the UI always shows it, and the dot turns amber whenever the answer was not a 2xx or carried no
version. See [the ArgoCD API page](../domain/argocd-api.md#the-version-endpoint-is-not-under-v1).

Probe results are cached in `LocalStorage` for 30 seconds, so opening a command twice does not
re-probe and a VPN that just came up is picked up on the next open.

## What to watch out for when changing this

- **Do not add a field to `AppSummary` casually.** It is held for a few thousand applications
  and written to disk. `AppDetail` is the place for anything only one application needs.
- **Do not call `response.json()` on a list endpoint.** There is a test, but understand why:
  the body exists as a UTF-16 string and an object graph at the same time.
- **Do not parallelise step 3.** The 4 MB it saves is not the point; the flat peak is.
- **`AbortSignal` is threaded through by index** from the caller's controllers into
  `loadApplications`. Keep that wiring if you change the signature, or a command that closes
  mid-refresh leaks a request.
- **Relevant checks**: `npm test` covers `stream`, `project`, `store`, `score` and `probe`.
  `REAL_APPS_JSON=/tmp/apps.json npm test` re-validates projection and ranking against a real
  corpus. Neither exercises the 100 MB limit, so a change to the streaming path is worth
  re-measuring the way A8 in the
  [implementation plan](../../docs/superpowers/plans/2026-09-08-raycast-argocd.md) describes:
  bundle the real modules with esbuild and run them under `--max-old-space-size=100`.
