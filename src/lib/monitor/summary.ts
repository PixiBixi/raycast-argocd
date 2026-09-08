/**
 * The aggregation behind the menu bar command: what is wrong, across every instance, in the
 * few characters a menu bar title can hold.
 *
 * Kept pure and separate because the interesting decisions here are editorial rather than
 * technical: what counts as worth interrupting someone for, what the title says when several
 * things are wrong at once, and what it says when nothing is.
 */

import { UnreachableError } from "../argocd/errors";
import { AuthError } from "../auth/provider";
import type { AppSummary } from "../argocd/types";
import type { ArgoInstance, Environment } from "../config/instances";
import { isAttentionWorthy } from "../model/status";

/**
 * What kind of problem stopped an instance from refreshing. The kind matters rather than the
 * message, because the menu bar cannot ask for anything and each kind is fixed somewhere else:
 * a VPN in the network settings, a session in Manage Instances.
 */
export type ProblemKind = "unreachable" | "auth" | "other";

export interface MonitorInstance {
  id: string;
  name: string;
  env: Environment;
  degraded: AppSummary[];
  outOfSync: AppSummary[];
  total: number;
  /** Why this instance's numbers may be stale, when they are. */
  problem: string | undefined;
  problemKind: ProblemKind | undefined;
  ageSeconds: number | undefined;
}

export function classifyProblem(error: Error | undefined): ProblemKind | undefined {
  if (!error) {
    return undefined;
  }
  if (error instanceof UnreachableError) {
    return "unreachable";
  }
  if (error instanceof AuthError) {
    return "auth";
  }
  return "other";
}

export interface MonitorSummary {
  instances: MonitorInstance[];
  degradedCount: number;
  outOfSyncCount: number;
  totalCount: number;
  /** Instances that could not be refreshed at all, so their numbers mean nothing new. */
  unreportedInstances: string[];
}

export interface InstanceReport {
  instance: ArgoInstance;
  apps: AppSummary[];
  error: Error | undefined;
  ageSeconds: number | undefined;
}

/**
 * An application is degraded or missing, or it is out of sync. Those two are counted separately
 * because they call for different reactions: degraded is broken now, out of sync is a drift
 * that auto-sync may well be about to fix.
 */
export function summarize(reports: InstanceReport[]): MonitorSummary {
  const instances: MonitorInstance[] = [];
  const unreportedInstances: string[] = [];

  for (const report of reports) {
    const degraded: AppSummary[] = [];
    const outOfSync: AppSummary[] = [];

    for (const app of report.apps) {
      if (!isAttentionWorthy(app.health, app.sync)) {
        continue;
      }
      if (app.health === "Degraded" || app.health === "Missing") {
        degraded.push(app);
      } else if (app.sync === "OutOfSync") {
        outOfSync.push(app);
      }
    }

    const byName = (a: AppSummary, b: AppSummary) => a.name.localeCompare(b.name);
    degraded.sort(byName);
    outOfSync.sort(byName);

    if (report.error) {
      unreportedInstances.push(report.instance.name);
    }

    instances.push({
      id: report.instance.id,
      name: report.instance.name,
      env: report.instance.env,
      degraded,
      outOfSync,
      total: report.apps.length,
      problem: report.error ? report.error.message : undefined,
      problemKind: classifyProblem(report.error),
      ageSeconds: report.ageSeconds,
    });
  }

  return {
    instances,
    degradedCount: instances.reduce((sum, instance) => sum + instance.degraded.length, 0),
    outOfSyncCount: instances.reduce((sum, instance) => sum + instance.outOfSync.length, 0),
    totalCount: instances.reduce((sum, instance) => sum + instance.total, 0),
    unreportedInstances,
  };
}

export type MonitorState = "degraded" | "drifting" | "stale" | "healthy" | "empty";

export function monitorState(summary: MonitorSummary): MonitorState {
  if (summary.instances.length === 0) {
    return "empty";
  }
  if (summary.degradedCount > 0) {
    return "degraded";
  }
  if (summary.outOfSyncCount > 0) {
    return "drifting";
  }
  // Only once nothing is known to be wrong does a stale instance become the headline: a real
  // failure is more urgent than not knowing.
  if (summary.unreportedInstances.length > 0) {
    return "stale";
  }
  return "healthy";
}

export interface TitleOptions {
  /** When false, a healthy state shows the icon alone rather than a count. */
  showWhenHealthy: boolean;
}

/**
 * The menu bar title. Degraded wins over out of sync, because one is broken and the other is
 * drift. Nothing is shown when everything is fine unless asked, so the menu bar stays quiet.
 */
export function monitorTitle(summary: MonitorSummary, options: TitleOptions): string | undefined {
  switch (monitorState(summary)) {
    case "empty":
      return undefined;
    case "degraded": {
      const drift = summary.outOfSyncCount > 0 ? `, ${summary.outOfSyncCount} drifting` : "";
      return `${summary.degradedCount} degraded${drift}`;
    }
    case "drifting":
      return `${summary.outOfSyncCount} out of sync`;
    case "stale":
      return summary.unreportedInstances.length === 1
        ? `${summary.unreportedInstances[0]} unreachable`
        : `${summary.unreportedInstances.length} instances unreachable`;
    default:
      return options.showWhenHealthy ? `${summary.totalCount} healthy` : undefined;
  }
}

export function monitorTooltip(summary: MonitorSummary): string {
  if (summary.instances.length === 0) {
    return "No ArgoCD instance configured";
  }
  return summary.instances
    .map((instance) => {
      const parts = [
        instance.degraded.length > 0 ? `${instance.degraded.length} degraded` : undefined,
        instance.outOfSync.length > 0 ? `${instance.outOfSync.length} out of sync` : undefined,
      ].filter(Boolean);
      const state = parts.length > 0 ? parts.join(", ") : "all healthy";
      return `${instance.name}: ${state} of ${instance.total}`;
    })
    .join("\n");
}
