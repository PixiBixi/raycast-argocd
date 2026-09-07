/**
 * Server-side field projections.
 *
 * GET /api/v1/applications accepts a `fields` query parameter: a comma-separated list of
 * dotted paths, optionally prefixed with "-" to turn it into an exclusion list. It is absent
 * from swagger.json but it is what the ArgoCD web UI sends on this same endpoint, and it is
 * the difference between a 66 MB response and a 700 kB one on an instance holding a couple of
 * thousand applications. Measured on a real instance: the unprojected list of 2053
 * applications is 66.7 MB.
 *
 * If a server ever ignores the parameter, the response is merely larger; the projection
 * functions read the same paths either way, so the feature degrades in cost, not correctness.
 */

export const LIST_FIELDS: readonly string[] = [
  "items.metadata.name",
  "items.metadata.namespace",
  "items.metadata.resourceVersion",
  // Links a generated application back to its ApplicationSet. On the target instance 2034 of
  // 2053 applications carry one, which is what makes the ApplicationSet view free.
  "items.metadata.ownerReferences",
  "items.spec.project",
  "items.spec.destination",
  "items.spec.source.repoURL",
  "items.spec.source.path",
  "items.spec.source.targetRevision",
  "items.spec.sources",
  "items.status.sync.status",
  "items.status.sync.revision",
  "items.status.health.status",
  "items.status.operationState.phase",
  "items.status.operationState.finishedAt",
  "metadata.resourceVersion",
];

export const DETAIL_FIELDS: readonly string[] = [
  "metadata.name",
  "metadata.namespace",
  "metadata.resourceVersion",
  "metadata.ownerReferences",
  "spec.project",
  "spec.destination",
  "spec.source",
  "spec.sources",
  "status.sync",
  "status.health",
  "status.conditions",
  "status.summary",
  "status.operationState.phase",
  "status.operationState.message",
  "status.operationState.startedAt",
  "status.operationState.finishedAt",
  "status.operationState.syncResult.resources",
  "status.operationState.syncResult.revision",
  "status.history",
];

/** The narrow projection polled while a sync runs. A few kilobytes per poll. */
export const STATUS_FIELDS: readonly string[] = [
  "metadata.name",
  "metadata.namespace",
  "status.sync.status",
  "status.health.status",
  "status.operationState.phase",
  "status.operationState.message",
  "status.operationState.startedAt",
  "status.operationState.finishedAt",
  "status.operationState.syncResult.resources",
];

export const APPSET_FIELDS: readonly string[] = [
  "items.metadata.name",
  "items.metadata.namespace",
  "items.spec.template.spec.project",
  "items.status.conditions",
  "metadata.resourceVersion",
];
