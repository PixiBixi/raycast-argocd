/**
 * Everything the extension persists through Raycast, which is user data and never a secret:
 * LocalStorage is not encrypted, so API tokens live in the keychain instead (lib/auth/keychain).
 */

import { LocalStorage } from "@raycast/api";
import { parseInstances, serializeInstances, type ArgoInstance } from "../lib/config/instances";
import { UNKNOWN_REACHABILITY, type Reachability } from "../lib/argocd/probe";

const INSTANCES_KEY = "instances/v1";
const RECENTS_KEY = "recents/v1";
const REACHABILITY_KEY = "reachability/v1";
const SCOPE_KEY = "scope/v1";

const MAX_RECENTS = 10;

export async function loadInstances(): Promise<ArgoInstance[]> {
  return parseInstances(await LocalStorage.getItem<string>(INSTANCES_KEY));
}

export async function saveInstances(instances: ArgoInstance[]): Promise<void> {
  await LocalStorage.setItem(INSTANCES_KEY, serializeInstances(instances));
}

export async function loadRecentKeys(): Promise<string[]> {
  const raw = await LocalStorage.getItem<string>(RECENTS_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

export async function pushRecentKey(key: string): Promise<void> {
  const existing = await loadRecentKeys();
  const next = [key, ...existing.filter((candidate) => candidate !== key)].slice(0, MAX_RECENTS);
  await LocalStorage.setItem(RECENTS_KEY, JSON.stringify(next));
}

export async function loadReachability(): Promise<Record<string, Reachability>> {
  const raw = await LocalStorage.getItem<string>(REACHABILITY_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, Reachability> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<Reachability>;
      if (entry && (entry.state === "reachable" || entry.state === "unreachable")) {
        result[id] = { ...UNKNOWN_REACHABILITY, ...entry, state: entry.state };
      }
    }
    return result;
  } catch {
    return {};
  }
}

export async function saveReachability(map: Record<string, Reachability>): Promise<void> {
  await LocalStorage.setItem(REACHABILITY_KEY, JSON.stringify(map));
}

/** The scope dropdown survives a relaunch: an operator who works in one instance stays there. */
export async function loadScope(): Promise<string> {
  return (await LocalStorage.getItem<string>(SCOPE_KEY)) ?? "all";
}

export async function saveScope(scope: string): Promise<void> {
  await LocalStorage.setItem(SCOPE_KEY, scope);
}
