# Layering

Two layers, one rule between them, and a test that enforces it.

```
src/lib/   pure TypeScript. Every outside dependency is an argument.
src/ui/    React, Raycast, and the only place the outside world is touched.
```

## The rule

`src/lib/**` must not import `@raycast/api`, `react`, or anything Raycast-specific.
[`tests/lib/boundaries.test.ts`](../../tests/lib/boundaries.test.ts) walks the tree and fails
if it does.

That is not tidiness. It is the reason 485 tests run in under a second with no Raycast runtime,
no network, no storage and no clock. Every decision worth testing lives in `lib`, and
everything in `lib` takes its dependencies as parameters:

| Module                                                   | What is injected                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`argocd/client.ts`](../../src/lib/argocd/client.ts)     | `fetch`, the token provider, a timeout                                        |
| [`argocd/probe.ts`](../../src/lib/argocd/probe.ts)       | `fetch`, a clock, a timeout                                                   |
| [`auth/secrets.ts`](../../src/lib/auth/secrets.ts)       | a `SecretStore`                                                               |
| [`auth/oidc.ts`](../../src/lib/auth/oidc.ts)             | `fetch`, randomness, a SHA-256                                                |
| [`auth/sso.ts`](../../src/lib/auth/sso.ts)               | session read/write/clear, settings, discovery, refresh, a clock               |
| [`auth/cliSession.ts`](../../src/lib/auth/cliSession.ts) | the CLI config reader, a renewal cache, settings, discovery, refresh, a clock |
| [`cache/store.ts`](../../src/lib/cache/store.ts)         | `readFile`, `writeFile`, `rename`, `mkdir`, a clock                           |

The production values for all of them are assembled in exactly one file:
[`src/ui/deps.ts`](../../src/ui/deps.ts). If you are looking for where this extension talks to
the operating system, that is the file.

## What each layer holds

**`lib` holds the decisions.** Not just parsing, but the judgements: what counts as needing
attention ([`model/status.ts`](../../src/lib/model/status.ts)), how results are ranked
([`search/score.ts`](../../src/lib/search/score.ts)), when a token is renewed
([`auth/session.ts`](../../src/lib/auth/session.ts)), what the menu bar title says when several
things are wrong at once ([`monitor/summary.ts`](../../src/lib/monitor/summary.ts)).

That last one is worth calling out as the pattern. The menu bar aggregation is pure and tested
because its decisions are editorial rather than technical: degraded and missing are counted
separately because one is broken now and the other is a resource that is not there; an
application in both buckets counts once, in the more urgent; a suspended application counts in
neither, being deliberate. None of that is obvious, all of it is arguable, so all of it is
pinned by a test.

**`ui` holds the rendering and the plumbing.** It is validated by `ray build` and `ray lint`
rather than unit tests. Where a `ui` module contains a decision, that decision is pushed down:
[`statusVisuals.ts`](../../src/ui/statusVisuals.ts) is the only place the Raycast-free
`Severity` vocabulary becomes a `Color` and an `Icon`, precisely so `model/status.ts` can stay
in `lib`.

## Where shared logic goes

`src/ui/loadApplications.ts` is the exception that proves the rule. It is the sequential
probe-then-list read path, and it lives in `ui` because it needs `deps.ts`. But it is a plain
async function with `onCached` and `onSettled` callbacks rather than a hook, because two
callers need it: [`useApplications.ts`](../../src/ui/useApplications.ts) turns the callbacks
into React state, and [`monitor.tsx`](../../src/monitor.tsx) simply awaits the result.

It started life inside the hook and was extracted when the menu bar arrived. That ordering,
with its memory reasoning, took four separate corrections to get right, and two copies of it
would have drifted. If you find yourself needing the read path from a third place, extend that
function rather than reimplementing the sequence.

## Adding to `lib`

1. Put the module under the directory that names its domain, and mirror it under `tests/lib/`.
2. Take every outside dependency as a parameter, with the production value supplied in
   `deps.ts` and never as a default inside `lib`.
3. Test the decisions, not the plumbing. The valuable tests in this repository are the ones
   asserting a judgement: that `needsLogin` is false while a refresh token exists however stale
   the id token is, that an uncompared resource is not the same as an unknown one, that an
   error message never contains a token.

## What to watch out for

- **Do not import from `ui` into `lib`.** The boundary test only checks Raycast and React
  imports, so this one is on you.
- **`lib` may import from `lib` across directories**, and does: `argocd/project.ts` uses
  `diff/` and `model/`, `monitor/summary.ts` uses `argocd/errors.ts` and `auth/provider.ts`.
  Keep those edges acyclic; there is no test for cycles.
- **A `ui` module with an interesting decision in it is a smell.** The last one found was a
  menu item routed by `problem?.includes("VPN")`, matching words in a message when the error
  type was the actual information. It became `classifyProblem` in `lib` with a test.
