/**
 * Builds the body of POST /api/v1/applications/{name}/sync from the form values.
 *
 * Kept pure and separate from the client so every combination of options can be asserted
 * without a network layer. The defaults mirror the ArgoCD web UI: an untouched form produces
 * an empty body, which is exactly "sync with the application's own settings".
 */

import { ValidationError } from "../config/instances";
import type { AppDetail } from "./types";

export interface SyncFormValues {
  revision: string;
  prune: boolean;
  dryRun: boolean;
  applyOnly: boolean;
  force: boolean;
  replace: boolean;
  serverSideApply: boolean;
  pruneLast: boolean;
  skipSchemaValidation: boolean;
  retry: boolean;
  retryLimit: string;
}

export interface SyncStrategy {
  apply?: { force?: boolean };
  hook?: { force?: boolean };
}

export interface RetryStrategy {
  limit: number;
  backoff: { duration: string; factor: number; maxDuration: string };
}

export interface SyncRequest {
  revision?: string;
  prune?: boolean;
  dryRun?: boolean;
  strategy?: SyncStrategy;
  syncOptions?: { items: string[] };
  retryStrategy?: RetryStrategy;
}

export const DEFAULT_SYNC_FORM: SyncFormValues = {
  revision: "",
  prune: false,
  dryRun: false,
  applyOnly: false,
  force: false,
  replace: false,
  serverSideApply: false,
  pruneLast: false,
  skipSchemaValidation: false,
  retry: false,
  retryLimit: "2",
};

/** Matches the retry defaults ArgoCD's own UI proposes. */
const RETRY_BACKOFF = { duration: "5s", factor: 2, maxDuration: "3m" };

export function buildSyncRequest(values: SyncFormValues): SyncRequest {
  const request: SyncRequest = {};

  const revision = values.revision.trim();
  if (revision.length > 0) {
    request.revision = revision;
  }
  if (values.prune) {
    request.prune = true;
  }
  if (values.dryRun) {
    request.dryRun = true;
  }

  // "Apply only" selects the apply strategy, which skips hooks. Leaving strategy unset lets
  // the server pick its own default, which is the hook strategy.
  if (values.applyOnly) {
    request.strategy = { apply: values.force ? { force: true } : {} };
  } else if (values.force) {
    request.strategy = { hook: { force: true } };
  }

  const items: string[] = [];
  if (values.replace) items.push("Replace=true");
  if (values.serverSideApply) items.push("ServerSideApply=true");
  if (values.pruneLast) items.push("PruneLast=true");
  if (values.skipSchemaValidation) items.push("Validate=false");
  if (items.length > 0) {
    request.syncOptions = { items };
  }

  if (values.retry) {
    const raw = values.retryLimit.trim();
    // Number("") is 0, so an empty field would silently become "retry zero times" instead of
    // telling the operator the field is required.
    const limit = raw.length === 0 ? Number.NaN : Number(raw);
    if (!Number.isInteger(limit) || limit < 0) {
      throw new ValidationError("The retry limit must be a whole number of attempts.", "retryLimit");
    }
    request.retryStrategy = { limit, backoff: { ...RETRY_BACKOFF } };
  }

  return request;
}

/** One line shown under the sync form, so the operator reads what they are about to send. */
export function describeSyncRequest(request: SyncRequest): string {
  const parts: string[] = [];
  if (request.dryRun) parts.push("dry run");
  if (request.prune) parts.push("prunes removed resources");
  if (request.revision) parts.push(`revision ${request.revision}`);
  if (request.strategy?.apply) parts.push("apply only, hooks skipped");
  if (request.strategy?.apply?.force || request.strategy?.hook?.force) parts.push("forced");
  for (const item of request.syncOptions?.items ?? []) {
    parts.push(item);
  }
  if (request.retryStrategy) parts.push(`retries up to ${request.retryStrategy.limit} times`);

  return parts.length === 0 ? "Syncs with the application's default options." : `Syncs with ${parts.join(", ")}.`;
}

/** How long a requested sync may stay unreported by the controller before the watch gives up. */
export const SYNC_PICKUP_TIMEOUT_MS = 60_000;

/** Server and local clocks differ; a start this much before the request still counts as ours. */
const CLOCK_SKEW_MS = 30_000;

/**
 * True once the watch can stop. POST /sync only sets `operation`; the controller writes
 * `operationState` later and clears `operation` when done, so until then the phase on the
 * application is still the previous operation's.
 */
export function isSyncWatchDone(
  detail: Pick<AppDetail, "phase" | "operationPending" | "operationStartedAt">,
  requestedAt: number | undefined,
  now: number,
): boolean {
  if (detail.phase === "Running" || detail.phase === "Terminating") {
    return false;
  }
  const waitedTooLong = requestedAt !== undefined && now - requestedAt > SYNC_PICKUP_TIMEOUT_MS;
  if (detail.operationPending) {
    return waitedTooLong;
  }
  if (requestedAt === undefined) {
    return true;
  }
  const startedAt = detail.operationStartedAt ? Date.parse(detail.operationStartedAt) : Number.NaN;
  const ours = Number.isFinite(startedAt) && startedAt >= requestedAt - CLOCK_SKEW_MS;
  return ours || waitedTooLong;
}
