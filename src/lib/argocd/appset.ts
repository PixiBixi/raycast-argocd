/**
 * ApplicationSets, and the link back to the applications they generated.
 *
 * The ApplicationSet controller stamps an ownerReference on every application it creates.
 * Owner references are namespace-scoped, so an ApplicationSet always lives in the namespace of
 * the applications it owns, which makes (instanceId, namespace, name) an unambiguous key. The
 * consequence is that the rollup below needs no API call at all: the answer is already in the
 * applications cache.
 */

import { isAttentionWorthy } from "../model/status";
import { buildHaystack } from "./project";
import type { AppSummary } from "./types";

export interface AppSetSummary {
  instanceId: string;
  name: string;
  namespace: string;
  project: string | undefined;
  /** Message of the ErrorOccurred condition, when the generator is currently failing. */
  conditionError: string | undefined;
  haystack: string;
}

export interface AppSetRollup {
  total: number;
  outOfSync: number;
  degraded: number;
  attention: number;
}

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorCondition(status: Dict | undefined): string | undefined {
  const conditions = status?.conditions;
  if (!Array.isArray(conditions)) {
    return undefined;
  }
  for (const entry of conditions) {
    const condition = asDict(entry);
    // ArgoCD always keeps an ErrorOccurred condition on the object; only its status says
    // whether the generator is actually broken right now.
    if (condition?.type === "ErrorOccurred" && condition.status === "True") {
      return asString(condition.message) ?? "The generator reported an error.";
    }
  }
  return undefined;
}

export function projectAppSet(raw: unknown, instanceId: string): AppSetSummary | undefined {
  const appSet = asDict(raw);
  const metadata = asDict(appSet?.metadata);
  const name = asString(metadata?.name);
  if (!appSet || !name) {
    return undefined;
  }

  const namespace = asString(metadata?.namespace) ?? "argocd";
  const project = asString(asDict(asDict(asDict(appSet.spec)?.template)?.spec)?.project);

  return {
    instanceId,
    name,
    namespace,
    project,
    conditionError: errorCondition(asDict(appSet.status)),
    haystack: buildHaystack([name, namespace, project]),
  };
}

export function ownedByAppSet(
  app: AppSummary,
  instanceId: string,
  namespace: string,
  appSetName: string,
): boolean {
  return app.instanceId === instanceId && app.namespace === namespace && app.appSetName === appSetName;
}

export function filterByAppSet(
  apps: AppSummary[],
  instanceId: string,
  namespace: string,
  appSetName: string,
): AppSummary[] {
  return apps.filter((app) => ownedByAppSet(app, instanceId, namespace, appSetName));
}

export function rollupAppSet(apps: AppSummary[], appSet: AppSetSummary): AppSetRollup {
  const rollup: AppSetRollup = { total: 0, outOfSync: 0, degraded: 0, attention: 0 };
  for (const app of apps) {
    if (!ownedByAppSet(app, appSet.instanceId, appSet.namespace, appSet.name)) {
      continue;
    }
    rollup.total += 1;
    if (app.sync === "OutOfSync") rollup.outOfSync += 1;
    if (app.health === "Degraded") rollup.degraded += 1;
    if (isAttentionWorthy(app.health, app.sync)) rollup.attention += 1;
  }
  return rollup;
}
