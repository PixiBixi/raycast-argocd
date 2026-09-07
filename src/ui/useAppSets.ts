/**
 * The ApplicationSets read path.
 *
 * ApplicationSets are fetched rather than derived from the applications cache, which costs one
 * small projected request per instance and buys the two things the cache cannot give: the
 * ApplicationSets that currently generate nothing, and status.conditions, which is where a
 * broken generator reports itself.
 *
 * They are held in memory for the life of the command rather than written to disk: there are an
 * order of magnitude fewer of them than applications, and they change when a generator changes,
 * not when a deployment does.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppSetSummary } from "../lib/argocd/appset";
import { UnreachableError } from "../lib/argocd/errors";
import { UNKNOWN_REACHABILITY, isProbeStale, type Reachability } from "../lib/argocd/probe";
import type { ArgoInstance } from "../lib/config/instances";
import { makeClient, probe } from "./deps";
import { loadReachability, saveReachability } from "./storage";

export interface AppSetInstanceState {
  instance: ArgoInstance;
  appSets: AppSetSummary[];
  loading: boolean;
  error: Error | undefined;
  reachability: Reachability;
}

export interface UseAppSetsResult {
  states: AppSetInstanceState[];
  appSets: AppSetSummary[];
  loading: boolean;
  refresh: () => void;
}

export function useAppSets(instances: ArgoInstance[]): UseAppSetsResult {
  const [states, setStates] = useState<AppSetInstanceState[]>([]);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const controllers = instances.map(() => new AbortController());
    let cancelled = false;

    async function run() {
      const stored = await loadReachability();
      if (cancelled) {
        return;
      }
      setStates(
        instances.map((instance) => ({
          instance,
          appSets: [],
          loading: true,
          error: undefined,
          reachability: stored[instance.id] ?? UNKNOWN_REACHABILITY,
        })),
      );

      await Promise.all(
        instances.map(async (instance, index) => {
          const known = stored[instance.id] ?? UNKNOWN_REACHABILITY;
          const reachability = isProbeStale(known, Date.now()) ? await probe(instance) : known;
          if (cancelled) {
            return;
          }
          stored[instance.id] = reachability;

          const patch = (changes: Partial<AppSetInstanceState>) => {
            setStates((current) =>
              current.map((state) => (state.instance.id === instance.id ? { ...state, ...changes } : state)),
            );
          };
          patch({ reachability });

          if (reachability.state === "unreachable") {
            patch({ loading: false, error: new UnreachableError(instance.name, reachability.reason) });
            return;
          }

          try {
            const result = await makeClient(instance).listApplicationSets(controllers[index]?.signal);
            if (cancelled) {
              return;
            }
            patch({ appSets: result.appSets, loading: false, error: undefined });
          } catch (error) {
            if (cancelled) {
              return;
            }
            patch({ loading: false, error: error as Error });
          }
        }),
      );

      if (!cancelled) {
        await saveReachability(stored);
      }
    }

    void run();

    return () => {
      cancelled = true;
      for (const controller of controllers) {
        controller.abort();
      }
    };
  }, [instances, generation]);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  const appSets = useMemo(() => states.flatMap((state) => state.appSets), [states]);
  const loading = states.some((state) => state.loading);

  return { states, appSets, loading, refresh };
}
