/**
 * The read path behind the applications list.
 *
 * Order of operations matters here, and it is the whole point of this hook:
 *   1. every instance's cache is read from disk and rendered, so the first paint costs nothing;
 *   2. every instance is probed concurrently with a short timeout, so a VPN that is down is
 *      known in well under a second;
 *   3. the reachable instances whose cache is stale are queried **one at a time**.
 *
 * That last step is sequential on purpose. A Raycast command gets a 100 MB JS heap, and
 * streaming one applications list of 2053 applications still peaks around 35 MB; two of those
 * at once, plus the rendered list, is how the command was getting killed. Refreshing in
 * sequence keeps the peak to one list at a time, and costs nothing visible because the refresh
 * happens behind an already-rendered cache.
 *
 * An instance that fails at any step keeps its cached applications and records why, so one
 * broken or unreachable instance never empties the list.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UnreachableError } from "../lib/argocd/errors";
import { UNKNOWN_REACHABILITY, isProbeStale, type Reachability } from "../lib/argocd/probe";
import type { AppSummary } from "../lib/argocd/types";
import type { ArgoInstance } from "../lib/config/instances";
import { makeCache, makeClient, probe } from "./deps";
import { readPreferences } from "./preferences";
import { loadReachability, saveReachability } from "./storage";

export interface InstanceState {
  instance: ArgoInstance;
  apps: AppSummary[];
  ageSeconds: number | undefined;
  loading: boolean;
  error: Error | undefined;
  reachability: Reachability;
}

export interface UseApplicationsResult {
  states: InstanceState[];
  apps: AppSummary[];
  loading: boolean;
  refresh: (instanceId?: string) => void;
}

function initialState(instance: ArgoInstance, reachability: Reachability): InstanceState {
  return {
    instance,
    apps: [],
    ageSeconds: undefined,
    loading: true,
    error: undefined,
    reachability,
  };
}

export function useApplications(instances: ArgoInstance[]): UseApplicationsResult {
  const [states, setStates] = useState<InstanceState[]>([]);
  const [generation, setGeneration] = useState(0);
  const forced = useRef<string | "all" | undefined>(undefined);
  const cache = useMemo(() => makeCache(), []);

  const patch = useCallback((instanceId: string, changes: Partial<InstanceState>) => {
    setStates((current) =>
      current.map((state) => (state.instance.id === instanceId ? { ...state, ...changes } : state)),
    );
  }, []);

  useEffect(() => {
    const controllers = instances.map(() => new AbortController());
    let cancelled = false;
    const forceTarget = forced.current;
    forced.current = undefined;

    async function run() {
      const { cacheTtlSeconds } = readPreferences();
      const storedReachability = await loadReachability();
      if (cancelled) {
        return;
      }

      setStates(
        instances.map((instance) =>
          initialState(instance, storedReachability[instance.id] ?? UNKNOWN_REACHABILITY),
        ),
      );

      // Step 1: paint from disk.
      const entries = await Promise.all(
        instances.map(async (instance) => ({ instance, entry: await cache.read(instance.id) })),
      );
      if (cancelled) {
        return;
      }
      for (const { instance, entry } of entries) {
        patch(instance.id, {
          apps: entry?.apps ?? [],
          ageSeconds: entry ? cache.ageSeconds(entry) : undefined,
        });
      }

      // Step 2: probe everything at once. Cheap, and it decides what is worth querying.
      const targets: { instance: ArgoInstance; index: number }[] = [];
      await Promise.all(
        entries.map(async ({ instance, entry }, index) => {
          const shouldFetch =
            forceTarget === "all" || forceTarget === instance.id || cache.isStale(entry, cacheTtlSeconds);
          if (!shouldFetch) {
            patch(instance.id, { loading: false });
            return;
          }

          const known = storedReachability[instance.id] ?? UNKNOWN_REACHABILITY;
          const reachability =
            forceTarget !== undefined || isProbeStale(known, Date.now()) ? await probe(instance) : known;
          if (cancelled) {
            return;
          }
          storedReachability[instance.id] = reachability;
          patch(instance.id, { reachability });

          if (reachability.state === "unreachable") {
            patch(instance.id, {
              loading: false,
              error: new UnreachableError(instance.name, reachability.reason),
            });
            return;
          }
          targets.push({ instance, index });
        }),
      );

      // Step 3: one list at a time, so only one response is ever in flight and on the heap.
      for (const { instance, index } of targets) {
        if (cancelled) {
          return;
        }
        try {
          const result = await makeClient(instance).listApplications(controllers[index]?.signal);
          if (cancelled) {
            return;
          }
          await cache.write(instance.id, result.apps);
          patch(instance.id, { apps: result.apps, ageSeconds: 0, loading: false, error: undefined });
        } catch (error) {
          if (cancelled) {
            return;
          }
          // The cached applications stay on screen: a stale list beats an empty one.
          patch(instance.id, { loading: false, error: error as Error });
        }
      }

      if (!cancelled) {
        await saveReachability(storedReachability);
      }
    }

    void run();

    return () => {
      cancelled = true;
      for (const controller of controllers) {
        controller.abort();
      }
    };
  }, [instances, generation, cache, patch]);

  const refresh = useCallback((instanceId?: string) => {
    forced.current = instanceId ?? "all";
    setGeneration((value) => value + 1);
  }, []);

  const apps = useMemo(() => states.flatMap((state) => state.apps), [states]);
  const loading = states.some((state) => state.loading);

  return { states, apps, loading, refresh };
}
