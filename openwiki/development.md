# Development

## The gate

Everything below has to pass before a commit. Nothing here is optional, and each of the five
catches something the other four do not.

```sh
npm test              # vitest over src/lib, 485 tests
npm run typecheck     # tsc --noEmit
npm run lint          # ray lint: manifest, icons, eslint, prettier over src/
npm run format:check  # prettier over everything else, tests and docs included
npm run build         # ray build: bundles every command with esbuild
npm run check:secrets # the leak gate, over every tracked file
npm run store:payload # store readiness; assembles the monorepo payload
```

`npm run build` earns its place: it is the only thing that catches a command declared in
`package.json` with no matching `src/<name>.tsx`. `npx ray lint --fix` applies the formatting
and shortcut rewrites rather than reporting them.

**`format:check` is not redundant with `lint`.** `ray lint` runs Prettier over `src/` only, so a
tree that satisfies it can still fail `prettier --check .` on test and documentation files. That
is exactly how the first CI run failed, on eight test files, after a local gate that reported
clean. Run both, or use `npx prettier --write .` before committing.

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
[authentication](domain/authentication.md#it-used-to-be-the-macos-keychain-and-that-was-a-mistake-three-times-over).

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
- Real names, since the extension publishes under a Raycast account username

Fixtures use `https://argocd.example.com`, application names like `app-one`, project `team-a`.
When you add a fixture with a new legitimate host, add it to `allowed_host` in the script rather
than working around the check.

It scans **every tracked file**, with two exclusions that carry their reason in the script:
`package-lock.json`, whose registry URLs are all resolved by npm, and the script itself, which
necessarily contains every pattern it searches for.

That default is recent and it mattered. The gate used to scan an allowlist of seven paths, so
it printed "No cluster identity or credential found in the tracked tree" having never opened
`openwiki/`, `docs/`, `LICENSE` or `AGENTS.md`. Widening it found two things the same day: a
host missing from the allowlist, and a real name in the `LICENSE` copyright line. Neither was
serious; both were invisible to a check whose own success message claimed the whole tree.

### The local deny-list

Structural checks cannot recognise an organisation's own vocabulary: a service account name, an
RBAC group, an internal project. Naming those in the script would put them in the repository it
exists to protect, so they live in `.check-no-secrets-denylist`, one extended-regex pattern per
line, **gitignored by design**. Each machine keeps its own.

Create one when working against a real deployment. It exists because the structural checks alone
were not enough: real service account names, RBAC group names and application names taken from
screenshots reached the tracked tree, in test fixtures and in wiki examples, and passed every
check in the list above. The local list caught the last of them, a provider name in a code
comment.

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

### The keychain rejection, resolved

The checklist says:

> Extensions requesting Keychain Access will be rejected due to security concerns.

That used to describe every credential this extension stored. It no longer does: credentials
live in Raycast's own encrypted, extension-private storage, which the same documentation names
as the sanctioned place for access tokens. The keychain, and the shell-out to
`/usr/bin/security` that reached it, are gone. See
[authentication](domain/authentication.md#where-credentials-live) for what that detour cost
before it was removed.

### The rest of the checklist

| Requirement                                        | State                                  |
| -------------------------------------------------- | -------------------------------------- |
| Three to six screenshots in `metadata/`, 2000x1250 | Absent, and only a human can take them |
| `author` set to the Raycast account username       | Set to `pixibixi`, unconfirmed         |
| Icon legible on light and dark backgrounds         | Never checked on light                 |
| Command titles as `<verb> <noun>` or `<noun>`      | Done                                   |
| `CHANGELOG.md` as `## [Title] - {PR_MERGE_DATE}`   | Done, enforced by the payload          |
| `license: MIT`, one category, `package-lock.json`  | Done, enforced by the payload          |
| Latest `@raycast/api`, `npm run build` clean       | Done, enforced by the payload          |
| No personal data in what ships                     | Done, enforced by the leak gate        |

Everything marked enforced is checked by `npm run store:payload`, which refuses to write a
payload rather than reporting a problem and continuing.

Two of those need a person at a keyboard, so they are the real remainder.

**Screenshots.** The validator wants PNGs of exactly 2000x1250 in a top-level `metadata/`
folder, taken on a retina screen, and it says so in those words. It also **skips the check
entirely when the folder does not exist**, which is why `npm run lint` passes today and says
nothing about them. That is the same shape as every other bug in this repository's history: a
check that is named more broadly than what it verifies. Do not read a green `ray lint` as
evidence that the metadata is in order; `npm run store:payload` is what refuses.

Screenshots also cannot be produced from a terminal, and they must not come from a real
instance: an application list is a list of internal service names, and the listing page is
public. Raycast's own checklist says to avoid sensitive data for exactly this reason.

So there is a fake instance instead. `npm run demo` serves an invented corpus on loopback,
150 applications across 5 fictional projects with a realistic spread of health and sync
states, answering every endpoint the extension calls:

```sh
npm run demo   # http://127.0.0.1:8080
npm run dev    # then Manage Instances -> add http://127.0.0.1:8080, auth mode "token", any value
```

Then capture. Raycast has a built-in **Window Capture**, bound in Advanced Preferences, which
writes a correctly sized PNG straight into `metadata/` when "Save to Metadata" is ticked, and
strips the development UI. That is the only way to get 2000x1250 reliably; a manual screenshot
will not match.

Cleartext on loopback is what makes this work, and `normalizeBaseUrl` exempts exactly
`localhost`, `127.0.0.1` and `::1`. Not a substring match: `localhost.example.com` and
`notlocalhost` are both still refused, with tests for each. The exemption is not only for
screenshots, it is also how a port-forwarded ArgoCD is reached.

`tests/lib/demoCorpus.test.ts` keeps the corpus honest. It projects the served data through
the real `projectSummary`, `projectDetail` and `projectResourceDiff` and asserts that nothing
is dropped, that no summary field is empty, that every ApplicationSet is recovered from
`ownerReferences`, and that the diff is non-trivial. Without it a corpus could quietly stop
projecting and put "unknown" in a published screenshot. It is skipped unless `DEMO_ARGOCD`
points at a running server, the same pattern as `real-instance.test.ts`.

**`author`.** It must equal the Raycast account username, not the GitHub one. They happen to be
spelled the same here, which is exactly the sort of coincidence worth confirming rather than
assuming.

### What publishing actually is

Publishing opens a **pull request against the `raycast/extensions` monorepo**, which adds the
extension as `extensions/argocd/`. Raycast owns that repository, so whatever lands there is
public and permanent regardless of what this repository later becomes.

An earlier version of this page claimed `npm run publish` sends the extension directory and
that `docs/superpowers/` and `openwiki/` are "not part of it". That was an assumption, and it
is false. `ray publish` copies the directory minus one hardcoded list, and nothing else:

```
.git  .github  node_modules  raycast-env.d.ts  .direnv
.raycast-swift-build  .swiftpm  compiled_raycast_swift  compiled_raycast_rust
```

`openwiki/` and `docs/` are not on it and the list cannot be extended, so both would travel,
carrying the instance topology and the measured figures with them. That is why the
`publish` script is gone from `package.json` and `npm run store:payload` replaces it.

### The payload

`npm run store:payload` assembles into `dist/store-payload/` exactly what belongs in the pull
request, and **writes nothing at all** when a store requirement is unmet: no screenshots, wrong
screenshot size, a manifest field missing, a `version` field present, a changelog heading
without `{PR_MERGE_DATE}`, a leak-gate failure, or a build failure.

What it keeps is not invented. It is what published extensions actually carry: `jira` and
`brew` both ship `metadata/` and a test directory, `brew` ships a `vitest.config`, `gitlab`
ships `scripts/` and an `AGENTS.md`. So tests travel; the wiki does not, because no published
extension has one and it is not extension content.

Left out deliberately, each for a reason rather than an oversight: `openwiki/` and `docs/`
(repository-side, and they describe internal topology), `.github/` and `scripts/` (this
repository's CI, meaningless in the monorepo), `AGENTS.md` (it links into `openwiki/`, which
does not travel) and `.nvmrc` (the monorepo pins its own toolchain).

Then open the pull request by hand against a fork of `raycast/extensions`, copying
`dist/store-payload/` to `extensions/argocd/`. Doing it by hand is the point: the payload is
reviewable before it leaves.

One thing the payload cannot judge for you: `README.md` becomes the store listing page, and its
Install section currently reads "Not published yet". Rewrite that line in the same commit that
opens the pull request, or the listing contradicts itself. The wiki links in it are absolute
URLs for the same reason: relative ones pointed at `openwiki/`, which does not travel, and the
payload now refuses any relative link it cannot resolve.

An extension is **not versioned**. There is no `version` field in `package.json`; Raycast reads
`CHANGELOG.md`, where `{PR_MERGE_DATE}` is replaced when the pull request merges. Any git tag in
this repository is for local bookkeeping only and means nothing to Raycast.
