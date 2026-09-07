/**
 * Turns a raw ArgoCD Application into the row model.
 *
 * Every accessor is defensive: the input is a projected object whose shape depends on which
 * fields the server honoured, and a single malformed item must not be able to poison a list of
 * a few thousand. An item that cannot be identified is dropped by returning undefined rather
 * than substituted with a placeholder, which would show up as a phantom application.
 */

import { parseHealth, parseOperationPhase, parseSync } from "../model/status";
import type { AppCondition, AppDetail, AppSummary, SyncResultResource } from "./types";

/** ArgoCD omits metadata.namespace for applications living in the control-plane namespace. */
const DEFAULT_APP_NAMESPACE = "argocd";

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function dig(root: unknown, ...path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const dict = asDict(current);
    if (!dict) {
      return undefined;
    }
    current = dict[key];
  }
  return current;
}

export function buildHaystack(parts: (string | undefined)[]): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function appSetOwner(metadata: Dict): string | undefined {
  for (const reference of asArray(metadata.ownerReferences)) {
    const owner = asDict(reference);
    if (owner?.kind === "ApplicationSet") {
      return asString(owner.name);
    }
  }
  return undefined;
}

/** Multi-source applications carry spec.sources; single-source ones carry spec.source. */
function primarySource(spec: Dict | undefined): Dict | undefined {
  if (!spec) {
    return undefined;
  }
  const single = asDict(spec.source);
  if (single) {
    return single;
  }
  return asDict(asArray(spec.sources)[0]);
}

export function projectSummary(raw: unknown, instanceId: string): AppSummary | undefined {
  const app = asDict(raw);
  const metadata = asDict(app?.metadata);
  const name = asString(metadata?.name);
  if (!app || !metadata || !name) {
    return undefined;
  }

  const spec = asDict(app.spec);
  const status = asDict(app.status);
  const source = primarySource(spec);
  const destination = asDict(spec?.destination);

  const namespace = asString(metadata.namespace) ?? DEFAULT_APP_NAMESPACE;
  const project = asString(spec?.project) ?? "default";
  const destinationNamespace = asString(destination?.namespace);
  const repoUrl = asString(source?.repoURL);
  const path = asString(source?.path);
  const appSetName = appSetOwner(metadata);

  return {
    instanceId,
    name,
    namespace,
    project,
    health: parseHealth(asString(dig(status, "health", "status"))),
    sync: parseSync(asString(dig(status, "sync", "status"))),
    phase: parseOperationPhase(asString(dig(status, "operationState", "phase"))),
    finishedAt: asString(dig(status, "operationState", "finishedAt")),
    destinationServer: asString(destination?.server),
    destinationName: asString(destination?.name),
    destinationNamespace,
    repoUrl,
    path,
    targetRevision: asString(source?.targetRevision),
    revision: asString(dig(status, "sync", "revision")),
    appSetName,
    haystack: buildHaystack([name, project, namespace, destinationNamespace, repoUrl, path, appSetName]),
  };
}

function projectConditions(status: Dict | undefined): AppCondition[] {
  const conditions: AppCondition[] = [];
  for (const entry of asArray(status?.conditions)) {
    const condition = asDict(entry);
    const type = asString(condition?.type);
    if (!type) {
      continue;
    }
    conditions.push({ type, message: asString(condition?.message) ?? "" });
  }
  return conditions;
}

function projectSyncResources(status: Dict | undefined): SyncResultResource[] {
  const resources: SyncResultResource[] = [];
  const raw = dig(status, "operationState", "syncResult", "resources");
  for (const entry of asArray(raw)) {
    const resource = asDict(entry);
    const name = asString(resource?.name);
    if (!resource || !name) {
      continue;
    }
    resources.push({
      group: asString(resource.group) ?? "",
      kind: asString(resource.kind) ?? "",
      namespace: asString(resource.namespace) ?? "",
      name,
      status: asString(resource.status) ?? "",
      message: asString(resource.message) ?? "",
      hookPhase: asString(resource.hookPhase),
    });
  }
  return resources;
}

export function projectDetail(raw: unknown, instanceId: string): AppDetail | undefined {
  const summary = projectSummary(raw, instanceId);
  if (!summary) {
    return undefined;
  }

  const app = asDict(raw);
  const status = asDict(app?.status);
  const history = asArray(status?.history);
  // status.history is ordered oldest first, so the most recent deployment is the last entry.
  const latest = asDict(history[history.length - 1]);

  const images = asArray(dig(status, "summary", "images"))
    .map((image) => asString(image))
    .filter((image): image is string => image !== undefined);

  return {
    ...summary,
    conditions: projectConditions(status),
    summaryImages: images,
    operationMessage: asString(dig(status, "operationState", "message")),
    operationStartedAt: asString(dig(status, "operationState", "startedAt")),
    lastSyncRevision: asString(latest?.revision),
    lastSyncDeployedAt: asString(latest?.deployedAt),
    syncResources: projectSyncResources(status),
  };
}
