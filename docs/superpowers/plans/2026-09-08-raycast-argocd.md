# Raycast ArgoCD Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** A Raycast extension that searches applications across several ArgoCD instances in one
keystroke and lets the operator open, inspect and sync a selected application.

**Architecture:** A pure, dependency-injected `src/lib/` layer holds every fallible behaviour
(HTTP client, auth, cache, scoring, validation) and is covered by vitest; `src/ui/` holds React
components and Raycast plumbing only. Applications are fetched with a server-side field
projection, persisted to a per-instance JSON cache, and rendered stale-while-revalidate with a
hard cap of 60 rendered rows.

**Tech Stack:** TypeScript, React, `@raycast/api` 2.x, `@raycast/utils` 2.x, vitest 5.x, Node 22
(Raycast runtime), `yaml` for parsing the argocd CLI config.

**Spec:** `docs/superpowers/specs/2026-09-08-raycast-argocd-design.md`

**Deviation from the skill's default format:** this plan is executed by its author in the same
session, so per-step test bodies are specified as an enumerated list of cases with their exact
expected behaviour rather than transcribed verbatim twice. Signatures, file paths, commands and
commit messages are exact. Every test case listed is mandatory.

## Global Constraints

- No internal hostname, cluster name, project name, token or user identity in any committed
  file, including test fixtures. Fixtures use `https://argocd.example.com`, `app-one`, `team-a`.
- `src/lib/**` must not import `@raycast/api`, `react`, or anything Raycast-specific. Enforced
  by a vitest test that greps the tree.
- Every dependency of a `lib` function that touches the outside world (`fetch`, `exec`, clock,
  filesystem, `process.env`) is a constructor or parameter argument with a production default.
- Write operations (`POST`/`PUT`/`DELETE`) are refused by the client layer unless the instance
  carries `allowWrite: true`. This check is independent from the UI hiding the action.
- Prod instances are created with `allowWrite: false` and cannot be created otherwise.
- Never log, copy to clipboard, or render a bearer token, an `Authorization` header, or a raw
  response body.
- Conventional Commits, one scope per commit, every commit signed (`-S`).
- No em dash, en dash, or bullet character in any prose we write.

---

### Task 1: Scaffold the extension

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`,
  `.prettierrc`, `assets/argocd.png`, `src/lib/.gitkeep`
- Create: `tests/lib/boundaries.test.ts`

**Interfaces:**
- Produces: npm scripts `dev`, `build`, `lint`, `fix-lint`, `test`, `typecheck`.

- [ ] **Step 1:** Write `package.json` with the Raycast manifest: `name: argocd`,
  `title: ArgoCD`, `description`, `icon: argocd.png`, `author: pixibixi`,
  `platforms: ["macOS"]`, `categories: ["Developer Tools"]`, `license: MIT`, and commands
  `search-applications` (mode `view`) and `manage-instances` (mode `view`). Extension
  preferences: `cacheTtlSeconds` (textfield, default `60`), `requestTimeoutSeconds`
  (textfield, default `15`), `maxResults` (textfield, default `60`),
  `argocdCliPath` (textfield, default `argocd`).
- [ ] **Step 2:** Install dependencies. Run:
  `npm i @raycast/api@latest @raycast/utils@latest yaml@latest` and
  `npm i -D @raycast/eslint-config@latest @types/node@latest @types/react@latest eslint@latest prettier@latest typescript@latest vitest@latest`.
  If `typescript@7` breaks `ray build` or `eslint`, pin `typescript@^5.9` and record the
  reason in a comment in `package.json`. Never leave the toolchain broken to chase a version.
- [ ] **Step 3:** Write `tsconfig.json` (Raycast preset: `target ES2023`, `module esnext`,
  `moduleResolution bundler`, `jsx react-jsx`, `strict: true`,
  `noUncheckedIndexedAccess: true`, `isolatedModules: true`, `skipLibCheck: true`).
- [ ] **Step 4:** Write `vitest.config.ts` restricting `include` to `tests/**/*.test.ts`, and
  `eslint.config.js` extending `@raycast/eslint-config`.
- [ ] **Step 5:** Write `tests/lib/boundaries.test.ts`: walk `src/lib` recursively and assert no
  file's source matches `/from ["']@raycast\//` or `/from ["']react["']/`.
- [ ] **Step 6:** Run `npm test` (passes trivially, `src/lib` is empty), `npx tsc --noEmit`,
  and `npx ray lint`. All must succeed before committing.
- [ ] **Step 7:** Generate `assets/argocd.png` (512x512). Use a simple flat mark; do not embed
  the upstream ArgoCD trademark asset.
- [ ] **Step 8:** Commit.

```bash
git add -A
git commit -S -m "chore(scaffold): Raycast extension skeleton with vitest and lib boundary test"
```

---

### Task 2: Status vocabulary

**Files:**
- Create: `src/lib/model/status.ts`
- Test: `tests/lib/model/status.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type HealthStatus = "Healthy" | "Progressing" | "Degraded" | "Suspended" | "Missing" | "Unknown";
  export type SyncStatus = "Synced" | "OutOfSync" | "Unknown";
  export type OperationPhase = "Running" | "Succeeded" | "Failed" | "Error" | "Terminating";
  export type Severity = "ok" | "warn" | "error" | "info" | "muted";
  export function parseHealth(raw: string | undefined): HealthStatus;
  export function parseSync(raw: string | undefined): SyncStatus;
  export function parseOperationPhase(raw: string | undefined): OperationPhase | undefined;
  export function healthSeverity(s: HealthStatus): Severity;
  export function syncSeverity(s: SyncStatus): Severity;
  export function operationSeverity(p: OperationPhase): Severity;
  export function isAttentionWorthy(health: HealthStatus, sync: SyncStatus): boolean;
  ```
  `Severity` is deliberately Raycast-free; the UI maps it to `Color`/`Icon`.

- [ ] **Step 1:** Write the failing tests:
  1. `parseHealth` maps each of the six ArgoCD health strings to itself.
  2. `parseHealth(undefined)` and `parseHealth("Weird")` return `"Unknown"`.
  3. `parseSync` maps `Synced`/`OutOfSync` and falls back to `"Unknown"`.
  4. `parseOperationPhase("Succeeded")` returns `"Succeeded"`; `parseOperationPhase(undefined)`
     returns `undefined`; an unknown string returns `undefined`.
  5. `healthSeverity`: `Healthy -> ok`, `Progressing -> info`, `Degraded -> error`,
     `Missing -> warn`, `Suspended -> muted`, `Unknown -> muted`.
  6. `syncSeverity`: `Synced -> ok`, `OutOfSync -> warn`, `Unknown -> muted`.
  7. `operationSeverity`: `Succeeded -> ok`, `Running -> info`, `Terminating -> warn`,
     `Failed -> error`, `Error -> error`.
  8. `isAttentionWorthy` is true when health is `Degraded` or `Missing`, or sync is
     `OutOfSync`; false for `Healthy` + `Synced`; false for `Suspended` + `Synced`.
- [ ] **Step 2:** Run `npx vitest run tests/lib/model/status.test.ts`. Expected: FAIL, module
  not found.
- [ ] **Step 3:** Implement `src/lib/model/status.ts` with plain lookup records and no `switch`
  fallthrough.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit.

```bash
git add src/lib/model tests/lib/model
git commit -S -m "feat(model): ArgoCD health, sync and operation status vocabulary"
```

---

### Task 3: Instance registry validation

**Files:**
- Create: `src/lib/config/instances.ts`
- Test: `tests/lib/config/instances.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Environment = "prod" | "preprod" | "dev";
  export type AuthMode = "cli" | "token";
  export interface ArgoInstance {
    id: string; name: string; baseUrl: string; env: Environment;
    authMode: AuthMode; allowWrite: boolean; enabled: boolean;
  }
  export interface InstanceDraft {
    id?: string; name: string; baseUrl: string; env: Environment;
    authMode: AuthMode; allowWrite?: boolean; enabled?: boolean;
  }
  export class ValidationError extends Error { readonly field: string; }
  export function normalizeBaseUrl(raw: string): string;
  export function instanceHost(instance: Pick<ArgoInstance, "baseUrl">): string;
  export function validateInstance(draft: InstanceDraft, existing: ArgoInstance[], newId: () => string): ArgoInstance;
  export function upsertInstance(instances: ArgoInstance[], instance: ArgoInstance): ArgoInstance[];
  export function removeInstance(instances: ArgoInstance[], id: string): ArgoInstance[];
  export function parseInstances(raw: string | undefined): ArgoInstance[];
  export function serializeInstances(instances: ArgoInstance[]): string;
  ```

- [ ] **Step 1:** Write the failing tests:
  1. `normalizeBaseUrl(" https://argocd.example.com/ ")` returns
     `"https://argocd.example.com"`; a trailing path is preserved without its trailing slash;
     `argocd.example.com` (no scheme) gets `https://` prepended.
  2. `normalizeBaseUrl("http://argocd.example.com")` throws `ValidationError` with
     `field === "baseUrl"` (https only).
  3. `normalizeBaseUrl("not a url")` throws `ValidationError`.
  4. `instanceHost` returns `argocd.example.com` for a plain URL and `argocd.example.com:8443`
     when a non-default port is present.
  5. `validateInstance` rejects an empty `name`, and a `name` colliding with another instance
     (case-insensitive), and a `baseUrl` colliding with another instance.
  6. `validateInstance` assigns an id from `newId` when the draft has none and preserves the
     draft id when it has one; the name-collision check ignores the instance's own id, so
     editing an instance without renaming it succeeds.
  7. `validateInstance` with `env: "prod"` returns `allowWrite: false` even when the draft asks
     for `true`, and returns `allowWrite: true` for `env: "dev"` when asked.
  8. `validateInstance` defaults `enabled` to `true`.
  9. `upsertInstance` replaces by id and appends when absent, preserving order.
  10. `removeInstance` removes by id and is a no-op for an unknown id.
  11. `parseInstances(undefined)` and `parseInstances("[]")` return `[]`;
      `parseInstances("{bad json")` returns `[]`; an array containing one valid and one
      structurally invalid entry returns only the valid one.
  12. `serializeInstances` then `parseInstances` round-trips.
- [ ] **Step 2:** Run `npx vitest run tests/lib/config/instances.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. `parseInstances` must be defensive: it reads user-editable storage.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit.

```bash
git add src/lib/config tests/lib/config
git commit -S -m "feat(config): validated ArgoCD instance registry with prod write guard"
```

---

### Task 4: argocd CLI config reader

**Files:**
- Create: `src/lib/auth/cliConfig.ts`
- Test: `tests/lib/auth/cliConfig.test.ts`

**Interfaces:**
- Consumes: `instanceHost` from Task 3.
- Produces:
  ```ts
  export interface CliToken { token: string; expiresAt: Date | undefined; }
  export interface CliConfigReaderDeps {
    readFile?: (path: string) => Promise<string>;
    configPath?: string;
    now?: () => Date;
  }
  export function decodeJwtExpiry(token: string): Date | undefined;
  export function isExpired(token: CliToken, now: Date, skewSeconds?: number): boolean;
  export function extractToken(configYaml: string, host: string): CliToken | undefined;
  export function readCliToken(host: string, deps?: CliConfigReaderDeps): Promise<CliToken | undefined>;
  ```
  `isExpired` defaults `skewSeconds` to 30 and returns `false` when `expiresAt` is undefined
  (an opaque token has no local expiry; let the server decide).

- [ ] **Step 1:** Write the failing tests. Build the JWT fixtures in the test with a helper that
  base64url-encodes `{"exp": <n>}` so no real token is ever committed.
  1. `decodeJwtExpiry` on a three-segment token with `exp: 1757280000` returns that instant.
  2. `decodeJwtExpiry` returns `undefined` for: a token with fewer than three segments, a
     payload that is not valid base64url, valid base64url that is not JSON, and JSON without
     `exp` or with a non-numeric `exp`.
  3. `decodeJwtExpiry` handles a payload whose base64url length is not a multiple of four
     (missing `=` padding).
  4. `isExpired` is true when `expiresAt` is in the past, true when it is within the default
     30 s skew, false when it is comfortably in the future, and false when `expiresAt` is
     `undefined`.
  5. `extractToken` finds the token for `argocd.example.com` in a config whose `users[]` entry
     is named exactly that.
  6. `extractToken` returns `undefined` when the host is absent, when the matching user has no
     `auth-token`, when the YAML is empty, and when the YAML is malformed.
  7. `extractToken` matches a host with a port (`argocd.example.com:8443`) only against the
     user entry carrying the same port, and does not match the port-less entry.
  8. `readCliToken` reads `~/.config/argocd/config` by default, and returns `undefined` when
     `readFile` rejects with `ENOENT` rather than throwing.
- [ ] **Step 2:** Run `npx vitest run tests/lib/auth/cliConfig.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement with the `yaml` package. Decode the JWT payload only; never verify,
  never log it.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit.

```bash
git add src/lib/auth tests/lib/auth
git commit -S -m "feat(auth): read the argocd CLI SSO session token and its local expiry"
```

---

### Task 5: Keychain token store and SSO login trigger

**Files:**
- Create: `src/lib/auth/keychain.ts`, `src/lib/auth/login.ts`
- Test: `tests/lib/auth/keychain.test.ts`, `tests/lib/auth/login.test.ts`

**Interfaces:**
- Consumes: `readCliToken`, `CliToken` from Task 4.
- Produces:
  ```ts
  // keychain.ts
  export type Exec = (file: string, args: string[], opts?: { input?: string }) =>
    Promise<{ stdout: string; stderr: string; code: number }>;
  export const KEYCHAIN_SERVICE = "raycast-argocd";
  export function readTokenArgs(instanceId: string): string[];
  export function writeTokenArgs(instanceId: string, token: string): string[];
  export function deleteTokenArgs(instanceId: string): string[];
  export function readKeychainToken(instanceId: string, exec: Exec): Promise<string | undefined>;
  export function writeKeychainToken(instanceId: string, token: string, exec: Exec): Promise<void>;
  export function deleteKeychainToken(instanceId: string, exec: Exec): Promise<void>;

  // login.ts
  export function ssoLoginArgs(host: string): string[];
  export interface SsoLoginDeps {
    spawn: (file: string, args: string[]) => void;
    readToken: (host: string) => Promise<CliToken | undefined>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
  }
  export function runSsoLogin(host: string, cliPath: string, deps: SsoLoginDeps,
    timeoutMs?: number, pollMs?: number): Promise<CliToken>;
  ```
  `writeTokenArgs` must never place the token in argv: it uses `-w` with the token passed on
  stdin is not supported by `security`, so it uses `-w <token>` only via `input` when
  available. Implement `writeKeychainToken` with `security add-generic-password -U -s <service>
  -a <id> -w` and the token supplied through `opts.input`; assert in the test that no argv
  element equals the token.

- [ ] **Step 1:** Write the failing keychain tests:
  1. `readTokenArgs("i1")` equals
     `["find-generic-password", "-s", "raycast-argocd", "-a", "i1", "-w"]`.
  2. `writeTokenArgs("i1", "secret")` contains `-U`, `-s raycast-argocd`, `-a i1`, `-w`, and
     **no element equal to `"secret"`**.
  3. `deleteTokenArgs("i1")` equals
     `["delete-generic-password", "-s", "raycast-argocd", "-a", "i1"]`.
  4. `readKeychainToken` returns the trimmed stdout on exit code 0.
  5. `readKeychainToken` returns `undefined` on exit code 44 (item not found).
  6. `readKeychainToken` throws on any other non-zero exit code, and the thrown message does
     not contain the token.
  7. `writeKeychainToken` passes the token through `opts.input`.
  8. `deleteKeychainToken` tolerates exit code 44 and throws otherwise.
- [ ] **Step 2:** Write the failing login tests:
  1. `ssoLoginArgs("argocd.example.com")` equals
     `["login", "argocd.example.com", "--sso", "--grpc-web"]`.
  2. `runSsoLogin` resolves with the token once `readToken` starts returning one, and calls
     `spawn` exactly once.
  3. `runSsoLogin` rejects with a `Error` whose message mentions a timeout when `readToken`
     keeps returning `undefined` past `timeoutMs`, using the injected `now`/`sleep`.
  4. `runSsoLogin` ignores a token that is already expired and keeps polling.
- [ ] **Step 3:** Run `npx vitest run tests/lib/auth`. Expected: FAIL.
- [ ] **Step 4:** Implement both modules.
- [ ] **Step 5:** Run tests. Expected: PASS.
- [ ] **Step 6:** Commit.

```bash
git add src/lib/auth tests/lib/auth
git commit -S -m "feat(auth): keychain token store and argocd SSO re-login helper"
```

---

### Task 6: Token provider

**Files:**
- Create: `src/lib/auth/provider.ts`
- Test: `tests/lib/auth/provider.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4, 5.
- Produces:
  ```ts
  export class AuthError extends Error {
    constructor(message: string, readonly instanceId: string, readonly host: string);
  }
  export interface TokenProviderDeps {
    readCliToken: (host: string) => Promise<CliToken | undefined>;
    readKeychainToken: (instanceId: string) => Promise<string | undefined>;
    now: () => Date;
  }
  export function createTokenProvider(deps: TokenProviderDeps):
    (instance: ArgoInstance) => Promise<string>;
  ```

- [ ] **Step 1:** Write the failing tests:
  1. `authMode: "cli"` returns the CLI token when present and unexpired.
  2. `authMode: "cli"` throws `AuthError` when no CLI token exists, and the message names the
     host and tells the operator to run the SSO login.
  3. `authMode: "cli"` throws `AuthError` when the CLI token is expired.
  4. `authMode: "token"` returns the keychain token and never calls `readCliToken`.
  5. `authMode: "token"` throws `AuthError` when the keychain has nothing.
  6. No thrown message contains the token value.
- [ ] **Step 2:** Run `npx vitest run tests/lib/auth/provider.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit.

```bash
git add src/lib/auth tests/lib/auth
git commit -S -m "feat(auth): token provider selecting between the CLI session and the keychain"
```

---

### Task 7: Errors, field projection and application summaries

**Files:**
- Create: `src/lib/argocd/errors.ts`, `src/lib/argocd/fields.ts`, `src/lib/argocd/project.ts`,
  `src/lib/argocd/types.ts`
- Test: `tests/lib/argocd/project.test.ts`

**Interfaces:**
- Consumes: Task 2 status parsers, Task 6 `AuthError`.
- Produces:
  ```ts
  // errors.ts
  export class ApiError extends Error { constructor(message: string, readonly status: number); }
  export class ForbiddenError extends ApiError {}
  export class NotFoundError extends ApiError {}
  export class TimeoutError extends Error {}
  export class NetworkError extends Error {}
  export class ReadOnlyInstanceError extends Error { constructor(readonly instanceName: string); }

  // fields.ts
  export const LIST_FIELDS: readonly string[];
  export const DETAIL_FIELDS: readonly string[];
  export const STATUS_FIELDS: readonly string[];

  // types.ts
  export interface AppSummary {
    instanceId: string; name: string; namespace: string; project: string;
    health: HealthStatus; sync: SyncStatus; phase: OperationPhase | undefined;
    finishedAt: string | undefined; destinationServer: string | undefined;
    destinationName: string | undefined; destinationNamespace: string | undefined;
    repoUrl: string | undefined; path: string | undefined; targetRevision: string | undefined;
    revision: string | undefined; haystack: string;
  }
  export interface AppDetail extends AppSummary {
    conditions: { type: string; message: string }[];
    summaryImages: string[];
    operationMessage: string | undefined;
    operationStartedAt: string | undefined;
    lastSyncRevision: string | undefined;
    lastSyncDeployedAt: string | undefined;
    syncResources: { group: string; kind: string; namespace: string; name: string;
                     status: string; message: string; hookPhase: string | undefined }[];
  }

  // project.ts
  export function projectSummary(raw: unknown, instanceId: string): AppSummary | undefined;
  export function projectDetail(raw: unknown, instanceId: string): AppDetail | undefined;
  export function buildHaystack(parts: (string | undefined)[]): string;
  ```
  `LIST_FIELDS` is exactly the list in section 4.3 of the spec. `projectSummary` returns
  `undefined` for input without `metadata.name`, so a malformed item cannot poison the list.

- [ ] **Step 1:** Write the failing tests:
  1. `projectSummary` on a realistic single-source application fills every field and sets
     `haystack` to the lowercased, space-joined name, project, namespace, destination
     namespace and repo path.
  2. `projectSummary` on an application with `spec.sources` (multi-source) takes the first
     source for `repoUrl`/`path`/`targetRevision`.
  3. `projectSummary` on an application with no `status` returns `health: "Unknown"`,
     `sync: "Unknown"`, `phase: undefined`.
  4. `projectSummary(null, "i1")`, `projectSummary({}, "i1")` and
     `projectSummary({metadata:{}}, "i1")` return `undefined`.
  5. `projectSummary` defaults `namespace` to `"argocd"` when absent, because the ArgoCD API
     omits it for applications in the control-plane namespace.
  6. `projectDetail` additionally extracts conditions, `status.summary.images`,
     `status.operationState.message`/`startedAt`, `status.history[0].revision`/`deployedAt`,
     and `status.operationState.syncResult.resources[]`.
  7. `projectDetail` on an application that has never synced returns empty `syncResources`,
     `[]` conditions, and `undefined` for the history fields.
  8. `buildHaystack` drops `undefined`, lowercases, and collapses repeated whitespace.
  9. `LIST_FIELDS` contains `items.metadata.name` and `metadata.resourceVersion` and contains
     no field carrying a manifest or a secret path.
- [ ] **Step 2:** Run `npx vitest run tests/lib/argocd/project.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit.

```bash
git add src/lib/argocd tests/lib/argocd
git commit -S -m "feat(argocd): field projection and application summary model"
```

---

### Task 8: REST client

**Files:**
- Create: `src/lib/argocd/client.ts`
- Test: `tests/lib/argocd/client.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 6, 7.
- Produces:
  ```ts
  export interface ClientDeps {
    fetch: typeof globalThis.fetch;
    getToken: (instance: ArgoInstance) => Promise<string>;
    timeoutMs?: number;
  }
  export interface ListResult { apps: AppSummary[]; resourceVersion: string | undefined; }
  export class ArgoClient {
    constructor(instance: ArgoInstance, deps: ClientDeps);
    listApplications(signal?: AbortSignal): Promise<ListResult>;
    getApplication(name: string, appNamespace: string, refresh?: "normal" | "hard"): Promise<AppDetail>;
    getApplicationStatus(name: string, appNamespace: string): Promise<AppDetail>;
    sync(name: string, appNamespace: string, body: SyncRequest): Promise<void>;
    appUrl(name: string, appNamespace: string): string;
  }
  ```

- [ ] **Step 1:** Write the failing tests with a stub `fetch` that records the request:
  1. `listApplications` requests `${baseUrl}/api/v1/applications` with `fields` equal to
     `LIST_FIELDS.join(",")` and no other query parameter.
  2. The request carries `Authorization: Bearer <token>` and `accept-encoding: gzip`, and
     `Accept: application/json`.
  3. `listApplications` returns projected summaries and the top-level
     `metadata.resourceVersion`, and silently drops items that fail to project.
  4. `getApplication("app-one", "argocd")` requests
     `/api/v1/applications/app-one?appNamespace=argocd&fields=<DETAIL_FIELDS>`, and adds
     `refresh=hard` only when asked.
  5. A 401 response throws `AuthError`; 403 throws `ForbiddenError`; 404 throws
     `NotFoundError`; 500 throws `ApiError` carrying status 500 and the server's `message`
     field when the body is JSON, or a generic message when it is not.
  6. A `fetch` rejection throws `NetworkError`; an `AbortError` throws `TimeoutError`.
  7. `sync` on an instance with `allowWrite: false` throws `ReadOnlyInstanceError` and
     **`fetch` is never called**.
  8. `sync` on an instance with `allowWrite: true` issues
     `POST /api/v1/applications/app-one/sync?appNamespace=argocd` with the JSON body and
     `Content-Type: application/json`.
  9. `appUrl` returns `${baseUrl}/applications/argocd/app-one`.
  10. No error message produced by any path contains the token.
- [ ] **Step 2:** Run `npx vitest run tests/lib/argocd/client.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Use `AbortSignal.any` to combine the caller signal with the
  internal timeout signal.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit.

```bash
git add src/lib/argocd tests/lib/argocd
git commit -S -m "feat(argocd): projected REST client with a client-side read-only guard"
```

---

### Task 9: Sync request builder

**Files:**
- Create: `src/lib/argocd/sync.ts`
- Test: `tests/lib/argocd/sync.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SyncFormValues {
    revision: string; prune: boolean; dryRun: boolean; applyOnly: boolean; force: boolean;
    replace: boolean; serverSideApply: boolean; pruneLast: boolean; skipSchemaValidation: boolean;
    retry: boolean; retryLimit: string;
  }
  export interface SyncRequest {
    revision?: string; prune?: boolean; dryRun?: boolean;
    strategy?: { apply?: { force?: boolean }; hook?: { force?: boolean } };
    syncOptions?: { items: string[] };
    retryStrategy?: { limit: number; backoff: { duration: string; factor: number; maxDuration: string } };
  }
  export const DEFAULT_SYNC_FORM: SyncFormValues;
  export function buildSyncRequest(values: SyncFormValues): SyncRequest;
  export function describeSyncRequest(request: SyncRequest): string;
  ```

- [ ] **Step 1:** Write the failing tests:
  1. `buildSyncRequest(DEFAULT_SYNC_FORM)` returns `{}` exactly (no undefined keys, verified
     with `Object.keys`).
  2. A non-empty `revision` sets `revision`; a whitespace-only revision does not.
  3. `prune` and `dryRun` set their booleans and are omitted when false.
  4. `applyOnly: true` sets `strategy.apply` and leaves `strategy.hook` unset.
  5. `force: true` with `applyOnly: true` sets `strategy.apply.force`.
  6. `force: true` with `applyOnly: false` sets `strategy.hook.force`.
  7. `replace`, `serverSideApply`, `pruneLast` and `skipSchemaValidation` append exactly
     `Replace=true`, `ServerSideApply=true`, `PruneLast=true`, `Validate=false` in that order,
     and `syncOptions` is absent when none is selected.
  8. `retry: true` with `retryLimit: "3"` sets
     `{limit: 3, backoff: {duration: "5s", factor: 2, maxDuration: "3m"}}`.
  9. `retry: true` with a non-numeric or negative `retryLimit` throws a `ValidationError`
     naming the `retryLimit` field.
  10. `describeSyncRequest` on `{}` returns a sentence saying default options, and on a
      pruning dry run mentions both.
- [ ] **Step 2:** Run `npx vitest run tests/lib/argocd/sync.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit.

```bash
git add src/lib/argocd tests/lib/argocd
git commit -S -m "feat(argocd): sync request builder covering the ArgoCD sync options"
```

---

### Task 10: On-disk projection cache

**Files:**
- Create: `src/lib/cache/store.ts`
- Test: `tests/lib/cache/store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const CACHE_SCHEMA = 1;
  export interface CacheEntry {
    schema: number; fetchedAt: number; resourceVersion: string | undefined; apps: AppSummary[];
  }
  export interface CacheDeps {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, data: string) => Promise<void>;
    rename: (from: string, to: string) => Promise<void>;
    mkdir: (path: string) => Promise<void>;
    now: () => number;
  }
  export class ProjectionCache {
    constructor(rootDir: string, deps: CacheDeps);
    read(instanceId: string): Promise<CacheEntry | undefined>;
    write(instanceId: string, apps: AppSummary[], resourceVersion: string | undefined): Promise<void>;
    isStale(entry: CacheEntry | undefined, ttlSeconds: number): boolean;
    ageSeconds(entry: CacheEntry): number;
  }
  ```

- [ ] **Step 1:** Write the failing tests against an in-memory `Map` filesystem:
  1. `write` then `read` round-trips the apps and the resourceVersion and stamps `fetchedAt`
     from `now`.
  2. `write` creates the directory and writes through a temporary file then `rename`, so a
     crashed write cannot leave a truncated cache. Assert `rename` was called.
  3. `read` returns `undefined` for a missing file (`ENOENT`), for invalid JSON, for
     `schema: 0`, and for a payload whose `apps` is not an array.
  4. `read` drops individual apps that are not objects with a `name`.
  5. `isStale(undefined, 60)` is `true`.
  6. `isStale` is `false` at exactly `ttl - 1` seconds of age and `true` at exactly `ttl`.
  7. `ageSeconds` is computed from `now` and floors to whole seconds.
  8. The file path is `<rootDir>/<instanceId>.json` and an instance id containing `/` or `..`
     throws rather than escaping the directory.
- [ ] **Step 2:** Run `npx vitest run tests/lib/cache/store.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit.

```bash
git add src/lib/cache tests/lib/cache
git commit -S -m "feat(cache): atomic per-instance projection cache with TTL"
```

---

### Task 11: Search scoring and default ordering

**Files:**
- Create: `src/lib/search/score.ts`
- Test: `tests/lib/search/score.test.ts`

**Interfaces:**
- Consumes: Task 7 `AppSummary`, Task 2 `isAttentionWorthy`.
- Produces:
  ```ts
  export interface RankOptions { limit: number; recentKeys?: string[]; }
  export interface RankResult { apps: AppSummary[]; truncated: boolean; total: number; }
  export function appKey(app: AppSummary): string;   // `${instanceId}/${namespace}/${name}`
  export function scoreApp(app: AppSummary, query: string): number;  // 0 means no match
  export function rankApps(apps: AppSummary[], query: string, options: RankOptions): RankResult;
  export function defaultOrder(apps: AppSummary[], recentKeys: string[], limit: number): RankResult;
  ```
  Scoring tiers, highest first: exact name match, name prefix, name substring, haystack
  substring. Ties break on name ascending.

- [ ] **Step 1:** Write the failing tests:
  1. `scoreApp` ranks an exact name match above a prefix match, above a substring match, above
     a haystack-only match.
  2. `scoreApp` is case-insensitive and returns 0 for a query matching nothing.
  3. `scoreApp` with an empty query returns 0 (callers use `defaultOrder` instead).
  4. `rankApps` returns matches sorted by descending score then ascending name.
  5. `rankApps` caps at `limit`, sets `truncated: true` and reports the untruncated `total`.
  6. `rankApps` sets `truncated: false` when the result fits.
  7. `rankApps` with a multi-word query requires every word to match somewhere (AND
     semantics), so `team-a redis` matches an app in project `team-a` named `redis-cache`.
  8. `defaultOrder` puts recent apps first in the order given by `recentKeys`, then apps for
     which `isAttentionWorthy` is true sorted by name, then the rest sorted by name.
  9. `defaultOrder` does not list a recent app twice.
  10. `appKey` is stable and includes the instance id.
- [ ] **Step 2:** Run `npx vitest run tests/lib/search/score.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. No allocation inside the per-app loop beyond the score number:
  the corpus is thousands of items and this runs on every keystroke.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit.

```bash
git add src/lib/search tests/lib/search
git commit -S -m "feat(search): scored ranking with a result cap and an attention-first default"
```

---

### Task 12: Raycast wiring for instances

**Files:**
- Create: `src/ui/preferences.ts`, `src/ui/storage.ts`, `src/ui/deps.ts`,
  `src/manage-instances.tsx`, `src/ui/InstanceForm.tsx`
- Modify: `package.json` (commands already declared in Task 1)

**Interfaces:**
- Consumes: Tasks 3, 5, 6, 8, 10.
- Produces:
  ```ts
  // preferences.ts
  export interface ExtensionPreferences { cacheTtlSeconds: string; requestTimeoutSeconds: string;
    maxResults: string; argocdCliPath: string; }
  export function readPreferences(): { cacheTtlSeconds: number; requestTimeoutSeconds: number;
    maxResults: number; argocdCliPath: string };
  // storage.ts
  export function loadInstances(): Promise<ArgoInstance[]>;
  export function saveInstances(instances: ArgoInstance[]): Promise<void>;
  export function loadRecentKeys(): Promise<string[]>;
  export function pushRecentKey(key: string): Promise<void>;   // keeps the last 10
  // deps.ts
  export function makeClient(instance: ArgoInstance): ArgoClient;
  export function makeCache(): ProjectionCache;
  export const execFileAsync: Exec;
  ```
  `readPreferences` clamps each numeric preference into a sane range
  (`cacheTtlSeconds` 5..3600, `requestTimeoutSeconds` 3..120, `maxResults` 10..200) and falls
  back to the default when the value does not parse.

- [ ] **Step 1:** Write `tests/lib/...` coverage for the clamping logic by extracting it into
  `src/lib/config/preferences.ts` with the signature
  `export function clampPreferences(raw: Partial<Record<"cacheTtlSeconds"|"requestTimeoutSeconds"|"maxResults", string>>): {cacheTtlSeconds: number; requestTimeoutSeconds: number; maxResults: number}`.
  Cases: valid values pass through; `"abc"` falls back to the default; `"0"` clamps to the
  minimum; `"99999"` clamps to the maximum; a missing key falls back to the default.
- [ ] **Step 2:** Run `npx vitest run tests/lib/config/preferences.test.ts`. Expected: FAIL,
  then implement `clampPreferences` and make it pass.
- [ ] **Step 3:** Implement `src/ui/preferences.ts` as a thin `getPreferenceValues` +
  `clampPreferences` wrapper, `src/ui/storage.ts` over `LocalStorage`, and `src/ui/deps.ts`
  wiring `fetch`, `node:child_process.execFile`, `node:fs/promises` and
  `environment.supportPath` into the lib constructors.
- [ ] **Step 4:** Implement `src/manage-instances.tsx`: a `List` of instances showing name,
  base URL, environment tag, auth mode, and a red `read-only` / green `write enabled` accessory.
  Actions: Add, Edit, Remove (with a confirmation alert), Toggle enabled, and, for
  `authMode: "token"`, Set API token (a password `Form.PasswordField` writing to the keychain)
  and Clear API token.
- [ ] **Step 5:** Implement `src/ui/InstanceForm.tsx`: fields name, base URL, environment
  dropdown, auth mode dropdown, `Allow write operations` checkbox that is disabled with an
  explanatory `info` when environment is `prod`, and `Enabled`. Submission runs
  `validateInstance` and surfaces `ValidationError.field` through
  `Form.ItemProps.error` rather than a toast.
- [ ] **Step 6:** Run `npx ray lint && npx tsc --noEmit && npm test`. All pass.
- [ ] **Step 7:** Commit.

```bash
git add package.json src/ui src/manage-instances.tsx src/lib/config tests/lib/config
git commit -S -m "feat(instances): manage ArgoCD instances from Raycast with keychain-backed tokens"
```

---

### Task 13: Search Applications command

**Files:**
- Create: `src/search-applications.tsx`, `src/ui/useApplications.ts`,
  `src/ui/ApplicationListItem.tsx`, `src/ui/statusVisuals.ts`, `src/ui/EmptyStates.tsx`
- Test: `tests/lib/search/score.test.ts` already covers the ranking; no new lib test.

**Interfaces:**
- Consumes: Tasks 2, 7, 8, 10, 11, 12.
- Produces:
  ```ts
  // useApplications.ts
  export interface InstanceState {
    instance: ArgoInstance; apps: AppSummary[]; ageSeconds: number | undefined;
    loading: boolean; error: Error | undefined;
  }
  export function useApplications(instances: ArgoInstance[]):
    { states: InstanceState[]; apps: AppSummary[]; refresh: (instanceId?: string) => void; loading: boolean };
  // statusVisuals.ts
  export function severityColor(s: Severity): Color;
  export function healthIcon(h: HealthStatus): { source: Icon; tintColor: Color };
  export function syncIcon(s: SyncStatus): { source: Icon; tintColor: Color };
  ```

- [ ] **Step 1:** Implement `useApplications`: on mount, read every enabled instance's cache
  entry (concurrently) and set state immediately; then, for each instance whose entry is stale
  or missing, fetch concurrently with its own abort controller and write the cache. A failed
  instance keeps its cached apps and records the error. `refresh()` forces every instance;
  `refresh(id)` forces one.
- [ ] **Step 2:** Implement `src/search-applications.tsx`:
  - `List` with `filtering={false}`, `isLoading`, `onSearchTextChange`, `throttle={false}`.
  - A `List.Dropdown` scope selector: `All instances` plus one item per enabled instance,
    persisted to `LocalStorage` so it survives relaunch.
  - Ranking through `rankApps` when there is a query, `defaultOrder` otherwise, with
    `limit = maxResults`.
  - In `All` scope, group into a `List.Section` per instance titled with the instance name and
    a subtitle stating the count and the cache age; otherwise one section titled by the mode
    (`Recent`, `Needs attention`, `All applications`) as produced by `defaultOrder`.
  - When results are truncated, the section subtitle states
    `showing N of M, refine the search`.
- [ ] **Step 3:** Implement `ApplicationListItem`: title is the application name, subtitle is
  the project, accessories are the sync status icon, the health status icon, and, in `All`
  scope, the instance name tag. Actions: `Show details` (push), `Open in ArgoCD`,
  `Copy application name`, `Refresh` (`⌘R`), `Refresh all instances` (`⌘⇧R`).
- [ ] **Step 4:** Implement `EmptyStates`: no instance configured (action pushes the instance
  form), every instance failing auth (action runs the SSO login through `runSsoLogin` with a
  progress toast, then refreshes), and no match for the query.
- [ ] **Step 5:** Run `npx ray lint && npx tsc --noEmit && npm test`, then `npm run dev` and
  exercise the command against a real instance: confirm the first paint is cache-backed, that
  typing stays responsive, and that a truncated result set reports the total.
- [ ] **Step 6:** Commit.

```bash
git add src/search-applications.tsx src/ui
git commit -S -m "feat(search): cached multi-instance application search with capped rendering"
```

---

### Task 14: Application detail view

**Files:**
- Create: `src/ui/ApplicationDetail.tsx`

**Interfaces:**
- Consumes: Tasks 7, 8, 12, 13.

- [ ] **Step 1:** Implement a `List` with `isShowingDetail` or a `Detail` view (choose `Detail`,
  the content is a single record) rendering: name, instance and environment, project, sync and
  health with their icons in the metadata panel, destination cluster and namespace, source repo
  / path / target revision, current revision (short), last sync revision and time, operation
  phase and message, and any `status.conditions` as a warning list.
- [ ] **Step 2:** Load through `getApplication(name, namespace)` with `useCachedPromise`, seeded
  from the list's `AppSummary` so the view paints immediately.
- [ ] **Step 3:** Actions in the order given by spec section 4.5. `Sync…` and `Quick sync` are
  rendered only when `instance.allowWrite` is true. `Refresh application` and
  `Hard refresh` (`⌘⇧R`) call `getApplication` with the `refresh` parameter and show a toast.
- [ ] **Step 4:** On mount, `pushRecentKey(appKey(app))`.
- [ ] **Step 5:** Run `npx ray lint && npx tsc --noEmit && npm test`, then exercise in `npm run dev`.
- [ ] **Step 6:** Commit.

```bash
git add src/ui/ApplicationDetail.tsx
git commit -S -m "feat(app): application detail view with refresh and deep link actions"
```

---

### Task 15: Sync form and live sync status

**Files:**
- Create: `src/ui/SyncForm.tsx`, `src/ui/SyncStatus.tsx`

**Interfaces:**
- Consumes: Tasks 8, 9, 14.

- [ ] **Step 1:** Implement `SyncForm`: a `Form` whose first field is the `Dry run` checkbox,
  then `Revision` (placeholder `leave empty to use the target revision`), `Prune`,
  `Apply only (skip hooks)`, `Force`, `Replace`, `Server-side apply`, `Prune last`,
  `Skip schema validation`, `Retry` and `Retry limit`. The form's navigation title carries the
  instance name and environment. A `Form.Description` shows `describeSyncRequest` of the
  current values.
- [ ] **Step 2:** On submit, build the body with `buildSyncRequest`, surface a `ValidationError`
  on the `retryLimit` field, then show a `confirmAlert` whose title is
  `Sync <app> on <instance>?` with a destructive primary action, unless `dryRun` is set.
- [ ] **Step 3:** Call `client.sync(...)`, show a success toast, `pop()` the form and push
  `SyncStatus`.
- [ ] **Step 4:** Implement `SyncStatus`: poll `getApplicationStatus` every 2000 ms while the
  phase is `Running` or `Terminating`, stop otherwise, and always stop on unmount. Render the
  phase with its severity colour, the message, started and finished timestamps, and the sync
  result resources as a list with per-resource status and message. Provide
  `Open in ArgoCD` and `Stop watching` actions.
- [ ] **Step 5:** Verify the read-only path: point the extension at a `prod` instance, confirm
  `Sync…` and `Quick sync` do not appear, then temporarily flip `allowWrite` in a scratch
  instance pointing at a non-production ArgoCD and confirm a dry-run sync completes and the
  status view follows it to `Succeeded`.
- [ ] **Step 6:** Run `npx ray lint && npx tsc --noEmit && npm test`.
- [ ] **Step 7:** Commit.

```bash
git add src/ui/SyncForm.tsx src/ui/SyncStatus.tsx
git commit -S -m "feat(sync): sync form with ArgoCD sync options and a live status view"
```

---

### Task 16: Documentation and release hygiene

**Files:**
- Create: `README.md`, `CHANGELOG.md`, `LICENSE`
- Modify: `package.json` (final metadata)

- [ ] **Step 1:** Write `README.md` as a usage reference: what the extension does, how to
  install it (`npm install && npm run dev`), how to add an instance, the two auth modes with
  the exact `argocd login` command to run, a table of commands, a table of preferences, a table
  of the sync options and the ArgoCD field each maps to, and a troubleshooting section covering
  "no token found", "401 after an hour", "instance shows cached data", and
  "sync action is missing". No internal hostname anywhere.
- [ ] **Step 2:** Write `CHANGELOG.md` with an `Unreleased` entry listing the initial feature
  set, and `LICENSE` (MIT).
- [ ] **Step 3:** Run the full gate: `npm test && npx tsc --noEmit && npx ray lint && npx ray build`.
- [ ] **Step 4:** Verify no secret leaked:
  `git grep -niE "eqtv|equativ|okta|internal\.|Bearer [A-Za-z0-9]" -- . ':!docs'` returns
  nothing actionable.
- [ ] **Step 5:** Commit.

```bash
git add README.md CHANGELOG.md LICENSE package.json
git commit -S -m "docs: usage reference, changelog and licence for the ArgoCD extension"
```

---

## Self-review

**Spec coverage.** 4.1 instance registry: Tasks 3 and 12. 4.2 auth: Tasks 4, 5, 6, and the
login action in Task 13. 4.3 read path and cache: Tasks 7, 8, 10, and the hook in Task 13.
4.4 search and rendering: Tasks 11 and 13. 4.5 actions: Task 14. 4.6 sync: Tasks 9 and 15.
4.7 errors: Task 7 defines them, Task 8 raises them, Tasks 13 to 15 render them. Section 5
testing: every listed module has a task. Section 2 "no secrets in the repository" is a global
constraint plus the Task 16 grep gate.

**Type consistency.** `AppSummary` and `AppDetail` are defined once in Task 7 and consumed
unchanged in Tasks 8, 10, 11, 13, 14. `ArgoInstance` is defined in Task 3 and consumed in
Tasks 6, 8, 12, 13. `CliToken` is defined in Task 4 and consumed in Tasks 5 and 6. `Exec` is
defined in Task 5 and re-exported through `src/ui/deps.ts` in Task 12. `SyncRequest` is
defined in Task 9 and referenced by `ArgoClient.sync` in Task 8, so Task 8 imports the type
from `src/lib/argocd/sync.ts`; that import direction is the only cross-reference between the
two and is acyclic because `sync.ts` imports nothing from `client.ts`.

**Ordering note.** Task 8 depends on the `SyncRequest` type from Task 9. Implement the type
declarations of Task 9 first if Task 8 is executed alone, or execute 9 before 8.
