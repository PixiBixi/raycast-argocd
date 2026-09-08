# Quickstart

A Raycast extension for ArgoCD. It searches applications across several ArgoCD instances at
once, then opens, inspects or syncs the one you found.

Everything unusual about this codebase comes from four constraints, all of them measured rather
than assumed. Read them before reading any code, because most design decisions here are a
direct answer to one of them.

| Constraint                                               | Consequence                                                                                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| The target instances hold **2053 and 2220 applications** | The applications list is 30.2 MB of compact JSON. It is streamed, never held.                                                                   |
| A Raycast command gets a **100 MB JS heap**              | `response.json()` on that list peaks at 58 MB, so two instances in parallel killed the command. See [read path](architecture/read-path.md).     |
| The instances sit **behind a VPN**                       | Every instance is probed before it is queried, so a disconnected laptop is reported in under a second instead of after every request times out. |
| One instance is **production, read-only**                | Write operations are refused twice over, by the UI and independently by the client. See [commands](architecture/commands.md).                   |

## Where to start

| If you want to                                          | Read                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Understand how code is organised and why it is testable | [Layering](architecture/layering.md)                                                       |
| Change anything that reads from ArgoCD                  | [Read path](architecture/read-path.md)                                                     |
| Add a command, a view or an action                      | [Commands](architecture/commands.md)                                                       |
| Touch the ArgoCD API                                    | [What the ArgoCD API does not do](domain/argocd-api.md)                                    |
| Touch anything about tokens or logins                   | [Authentication](domain/authentication.md)                                                 |
| Run the tests, the linter, or the CI                    | [Development](development.md)                                                              |
| Publish this to the Raycast Store                       | [Development](development.md#publishing-to-the-raycast-store), which starts with a blocker |

## Running it

```sh
npm install
npm run dev
```

The four commands appear at the top of Raycast's root search. `Ctrl-C` stops the dev server and
leaves the extension installed.

Then add an instance from **Manage Instances**. Instances are user data held in Raycast's
`LocalStorage`, not build-time configuration: a Raycast preference cannot hold a variable
number of entries, and hardcoding hostnames would put internal topology in the repository. That
second reason is enforced, not merely intended, by
[`scripts/check-no-secrets.sh`](development.md#the-leak-gate).

## The commands

| Command                | Mode          | What it does                                                             |
| ---------------------- | ------------- | ------------------------------------------------------------------------ |
| Search Applications    | view          | Searches every configured instance at once, or one of them.              |
| Search ApplicationSets | view          | Lists ApplicationSets with a rollup of the applications each generated.  |
| Manage Instances       | view          | Adds and edits instances, shows reachability, handles logins and tokens. |
| ArgoCD Monitor         | menu-bar, 10m | Counts what is degraded or out of sync, and keeps the cache warm.        |

Declared in [`package.json`](../package.json); each `name` maps to `src/<name>.tsx`.

## Layout

```
src/
  lib/            pure TypeScript, no @raycast/api import, all 476 tests live here
    argocd/       REST client, streaming projector, probe, sync builder, ApplicationSets
    auth/         OIDC with silent renewal, keychain, argocd CLI session, token provider
    cache/        the on-disk projection cache
    config/       instance registry and preference clamping
    diff/         line diff and manifest rendering, because ArgoCD does not send a diff
    model/        the status vocabulary, deliberately Raycast-free
    monitor/      the menu bar aggregation
    search/       scoring and default ordering
  ui/             React components and every call to the outside world
  *.tsx           one file per command
tests/lib/        mirrors src/lib
docs/superpowers/ the design spec and the implementation plan
scripts/          icon generation and the leak gate
```

The `lib`/`ui` split is the load-bearing boundary. [Layering](architecture/layering.md)
explains it.

## The other documentation in this repository

- [`README.md`](../README.md) is the **usage** reference: commands, preferences, sync options,
  troubleshooting. This wiki does not repeat it; it explains the code behind it.
- [`docs/superpowers/specs/2026-09-08-raycast-argocd-design.md`](../docs/superpowers/specs/2026-09-08-raycast-argocd-design.md)
  is the design, with the measurements.
- [`docs/superpowers/plans/2026-09-08-raycast-argocd.md`](../docs/superpowers/plans/2026-09-08-raycast-argocd.md)
  is the implementation plan followed by **eleven numbered amendments**. Each records a
  correction made after something was measured and found to be different from what was
  believed. It is the most useful history in the repository and worth reading before changing
  the read path or the auth layer.

## One recurring failure worth knowing about

Four separate bugs in this repository came from the same mistake: **a field being declared, or
a parameter being accepted, was treated as evidence that the server does something with it.**

- The ArgoCD web UI sends a `fields` query parameter; the server ignores it.
- `ResourceDiff` declares a `diff` field; the server does not populate it.
- `/api/v1/version` looks like the version endpoint; it is a 404, and the real path is
  `/api/version`.
- `security add-generic-password` exits 0 after storing nothing.

Each is documented where it applies, in [the ArgoCD API page](domain/argocd-api.md) and
[authentication](domain/authentication.md). The general lesson is in the code as comments
next to the guard that now catches each one: **a success path that is not verified against the
thing it claims to have done will eventually claim something false.**

## Known gaps

Three things are unverified rather than unknown, and are stated here so nobody assumes
otherwise.

- **The single sign-on flow has never completed against the real identity provider.**
  `oidc.cliClientID` is null on both instances, so the public client it needs does not exist
  yet. The flow is tested end to end against stubs. See
  [authentication](domain/authentication.md#what-is-still-unverified).
- **`ArgoClient.resourceUrl` is inferred.** Its deep-link shape was read off an observed
  browser URL and has not been confirmed to select the right resource.
- **ApplicationSets on production are unmeasured.** The development instance returns an empty
  list; production was never observed. See
  [ApplicationSets](domain/argocd-api.md#applicationsets-are-filtered-silently).
