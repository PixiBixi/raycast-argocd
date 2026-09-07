import type { HealthStatus, OperationPhase, SyncStatus } from "../model/status";

/**
 * The row model. Everything the applications list renders and searches on, and nothing else:
 * this is what gets cached to disk and held in memory for a few thousand applications, so
 * every added field has a cost paid thousands of times over.
 */
export interface AppSummary {
  instanceId: string;
  name: string;
  namespace: string;
  project: string;
  health: HealthStatus;
  sync: SyncStatus;
  phase: OperationPhase | undefined;
  finishedAt: string | undefined;
  destinationServer: string | undefined;
  destinationName: string | undefined;
  destinationNamespace: string | undefined;
  repoUrl: string | undefined;
  path: string | undefined;
  targetRevision: string | undefined;
  revision: string | undefined;
  /** Name of the ApplicationSet that generated this application, when there is one. */
  appSetName: string | undefined;
  /**
   * Lowercased, space-joined searchable text, precomputed at projection time. Building it once
   * here is what keeps a keystroke from re-lowercasing a few thousand strings.
   */
  haystack: string;
}

export interface SyncResultResource {
  group: string;
  kind: string;
  namespace: string;
  name: string;
  status: string;
  message: string;
  hookPhase: string | undefined;
}

export interface AppCondition {
  type: string;
  message: string;
}

export interface AppDetail extends AppSummary {
  conditions: AppCondition[];
  summaryImages: string[];
  operationMessage: string | undefined;
  operationStartedAt: string | undefined;
  lastSyncRevision: string | undefined;
  lastSyncDeployedAt: string | undefined;
  syncResources: SyncResultResource[];
}
