# Development

## The gate

Everything below has to pass before a commit. Nothing here is optional, and each of the five
catches something the other four do not.

```sh
npm test                      # vitest over src/lib, 476 tests
npm run typecheck             # tsc --noEmit
npm run lint                  # ray lint: manifest, icons, eslint, prettier
npm run build                 # ray build: bundles every command with esbuild
./scripts/check-no-secrets.sh # the leak gate
```

`npm run build` earns its place: it is the only thing that catches a command declared in
`package.json` with no matching `src/<name>.tsx`. `npx ray lint --fix` applies the formatting
and shortcut rewrites rather than reporting them.

Both `ray lint` and `ray build` work offline and need no Raycast login.

## Tests

`tests/lib/` mirrors `src/lib/`. Nothing under `src/ui/` is unit-tested; it is covered by
`ray build` and `ray lint`. The reason that split works is in
[layering](architecture/layering.md).

Two tests are unusual and worth knowing about.

**[`tests/lib/boundaries.test.ts`](../tests/lib/boundaries.test.ts)** walks `src/lib` and fails
if any file imports `@raycast/api` or `react`. It is what keeps the suite runnable without a
Raycast runtime.

**[`tests/lib/real-instance.test.ts`](../tests/lib/real-instance.test.ts)** validates the
projection and the ranking against a real corpus, which no hand-written fixture can stand in
for. Skipped unless `REAL_APPS_JSON` is set:

```sh
kubectl --context <argocd cluster> get applications.argoproj.io -A -o json > /tmp/apps.json
REAL_APPS_JSON=/tmp/apps.json npm test
```

It asserts that nothing is dropped, that every row is searchable, that the ApplicationSet
reconstruction produces something, and that ranking the whole corpus stays under 60 ms. **Never
commit that dump**: it carries cluster, project and repository names.

Note what it does _not_ cover: the 100 MB heap limit. A change to the streaming read path is
worth re-measuring the way A8 in the
[implementation plan](../docs/superpowers/plans/2026-09-08-raycast-argocd.md) describes, by
bundling the real modules with esbuild and running them under `--max-old-space-size=100`.

### What a good test looks like here

The valuable tests in this repository pin a **judgement**, not a mechanism. Some examples worth
imitating:

- `needsLogin` is false while a refresh token exists, however stale the id token is.
- An uncompared resource is not the same as an unknown one.
- A keychain write that exits 0 having stored nothing must throw.
- A reachable probe on a 404 is reachable, and says so, rather than reading as healthy.
- No error message contains a token.

The keychain bug is the cautionary tale. Its original test asserted only that the token was
absent from argv, never that it arrived, which is exactly why it could not catch a write that
stored nothing. See
[authentication](domain/authentication.md#the-keychain-and-two-bugs-worth-remembering).

## The leak gate

[`scripts/check-no-secrets.sh`](../scripts/check-no-secrets.sh) fails when anything identifying
a real ArgoCD deployment, or anything shaped like a credential, reaches the tracked tree.

Its patterns are **structural rather than a list of the organisation's own names**, and that is
the whole design: a deny-list naming the private hosts would leak them into the repository it
exists to protect. So it matches on shape:

- JWT literals (`eyJ...`) and hardcoded bearer values
- GKE context names (`gke_<project>_...`), which embed project, region and cluster
- URLs pointing at any host outside a short allowlist of example and public hosts
- `*.internal.*` and `*.local.*` hostnames
- Email addresses that are not a noreply or example address

Fixtures use `https://argocd.example.com`, application names like `app-one`, project `team-a`.
When you add a fixture with a new legitimate host, add it to `allowed_host` in the script rather
than working around the check.

## CI

Two workflows, hardened. Every job pins its actions by commit SHA, runs
`step-security/harden-runner` in audit mode, checks out with `persist-credentials: false`, and
inherits `permissions: contents: read`.

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml): `quality` (lint, format check,
typecheck, build), `test` on Node 22, 24 and 26, `coverage` with an uploaded artifact, and
`secrets` running the leak gate.

[`.github/workflows/github-actions.yml`](../.github/workflows/github-actions.yml) runs zizmor
over the workflows themselves, so the SHA pinning and the least-privilege permissions cannot rot
unnoticed.

[`.github/dependabot.yml`](../.github/dependabot.yml) groups `@raycast/*` with `@types/node` and
`@types/react`, because `@raycast/api` pins both and they only ever move together.

## Toolchain notes

**TypeScript is pinned to 5.9, not 7.x**, because `@raycast/eslint-config` declares a peer range
of `>=4.8.4 <6.1.0`. The linter cannot run against 7.x. That is recorded in
`package.json` rather than left to be rediscovered.

**Node 22.22.2 is the floor**, from `@raycast/api`'s own `engines`. `.nvmrc` pins 24 and CI
tests 22, 24 and 26.

`assets/argocd.png` is generated by [`scripts/generate-icon.mjs`](../scripts/generate-icon.mjs)
as an abstract sync mark, deliberately, so no upstream ArgoCD trademark asset lands in the
repository.

## Conventions

Taken from the repository's own history, which is consistent about all of it.

- **Conventional Commits, one scope per commit.** Scopes in use: `argocd`, `auth`, `app`,
  `cache`, `config`, `diff`, `model`, `monitor`, `probe`, `search`, `sync`, `ui`, `ci`, `docs`,
  `test`, `chore`, `perf`, `refactor`, `style`.
- **Every commit is signed.** `git log --format="%h %G? %s"` should be `G` throughout.
- **The commit body carries the why, and especially the evidence.** The useful commits in this
  history say what was measured and what it disproved. `perf(argocd): stream list responses
instead of holding them` is the model to imitate.
- **Comments state the decision and why it must not be undone**, in one to three lines. The
  investigation goes in the commit body or in the plan amendment, not inline.
- **No em dash, en dash, or bullet character** in anything written here, including code
  comments and Markdown.

## Where to record a correction

When something turns out to work differently from what the code assumed, append a numbered
amendment to
[`docs/superpowers/plans/2026-09-08-raycast-argocd.md`](../docs/superpowers/plans/2026-09-08-raycast-argocd.md).
There are eleven, and they are the most useful history in the repository: each says what was
believed, what was measured, and what changed as a result. Then update the wiki page that
carries the claim, which for anything about the ArgoCD API is
[domain/argocd-api.md](domain/argocd-api.md).

## Publishing to the Raycast Store

Not done, and not a formality. Read the
[store checklist](https://developers.raycast.com/basics/prepare-an-extension-for-store) before
starting, because one of its rules cuts across the whole design.

### The keychain is a rejection

> Extensions requesting Keychain Access will be rejected due to security concerns.

That is every credential this extension stores: the API token and the single sign-on session
both live in the keychain, reached through `/usr/bin/security`. The same page names the
sanctioned alternative, "use preferences API for configuration and credentials", which does not
model a variable number of instances and is exactly why the keychain was chosen. See
[authentication](domain/authentication.md).

There is one interpretive doubt worth recording: the rule may target the macOS Keychain Access
entitlement rather than a shell-out to `security`. Shelling out to `security` is how a process
reaches the keychain without that entitlement, so treat it as a blocker until a reviewer says
otherwise.

The way out is `OAuth.PKCEClient`, Raycast's own encrypted token store, which is designed for
this. It would replace the keychain for the session, at the cost of Raycast's redirect
(`https://raycast.com/redirect`) instead of the loopback `http://localhost:8085/auth/callback`,
so that is the URI the identity provider would have to register. For a public extension that is
the right trade anyway.

### The rest of the checklist

| Requirement                                       | State                                                          |
| ------------------------------------------------- | -------------------------------------------------------------- |
| Three to six screenshots, 2000x1250 PNG           | Absent                                                         |
| `author` set to the Raycast account username      | Set to `pixibixi`, unconfirmed                                 |
| Icon legible on light and dark backgrounds        | Never checked on light                                         |
| Media in a top-level `media/` folder              | The icon is in `assets/`                                       |
| `CHANGELOG.md` as `## [Title] - {PR_MERGE_DATE}`  | Uses Keep a Changelog instead                                  |
| `license: MIT`, one category, `package-lock.json` | Done                                                           |
| Command titles as `<verb> <noun>` or `<noun>`     | `ArgoCD Monitor` is redundant inside an extension named ArgoCD |
| Latest `@raycast/api`, `npm run build` clean      | Done                                                           |

### What publishing actually is

`npm run publish` on a public extension opens a **pull request against the
`raycast/extensions` monorepo**. It publishes the extension directory, not this repository, so
the git history, the CI, `docs/superpowers/` and `openwiki/` are not part of it. Decide
deliberately whether any of that should travel: these notes name internal hosts nowhere, but
they do describe internal topology.

An extension is **not versioned**. There is no `version` field in `package.json`; Raycast reads
`CHANGELOG.md`, where `{PR_MERGE_DATE}` is replaced when the pull request merges. Any git tag in
this repository is for local bookkeeping only and means nothing to Raycast.
