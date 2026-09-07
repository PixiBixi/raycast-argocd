import { Action, ActionPanel, Color, Icon, List, useNavigation, Keyboard } from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import { rollupAppSet, type AppSetSummary } from "./lib/argocd/appset";
import type { AppSummary } from "./lib/argocd/types";
import type { ArgoInstance } from "./lib/config/instances";
import { rankAppSets } from "./lib/search/score";
import { AppSetApplications } from "./ui/AppSetApplications";
import { makeCache, makeClient } from "./ui/deps";
import { readPreferences } from "./ui/preferences";
import { loadInstances, loadScope, saveScope } from "./ui/storage";
import { environmentColor } from "./ui/statusVisuals";
import { useAppSets } from "./ui/useAppSets";

const ALL_SCOPE = "all";

export default function SearchApplicationSets() {
  const { push } = useNavigation();
  const [instances, setInstances] = useState<ArgoInstance[]>([]);
  const [scope, setScope] = useState(ALL_SCOPE);
  const [query, setQuery] = useState("");
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
      const [stored, savedScope] = await Promise.all([loadInstances(), loadScope()]);
      setInstances(stored);
      setScope(savedScope);
      setReady(true);

      // The rollup counts come from the applications cache the other command already fills:
      // reading it here is free and avoids a second full applications request.
      const cache = makeCache();
      const cached = await Promise.all(stored.map((instance) => cache.read(instance.id)));
      setApps(cached.flatMap((entry) => entry?.apps ?? []));
    })();
  }, []);

  const enabled = useMemo(() => instances.filter((instance) => instance.enabled), [instances]);
  const scoped = useMemo(
    () => (scope === ALL_SCOPE ? enabled : enabled.filter((instance) => instance.id === scope)),
    [enabled, scope],
  );

  const { states, loading, refresh } = useAppSets(scoped);
  const { maxResults } = readPreferences();

  const ranked = useMemo(() => {
    const all = states.flatMap((state) => state.appSets);
    if (query.trim().length === 0) {
      const sorted = [...all].sort((a, b) => a.name.localeCompare(b.name));
      return {
        items: sorted.slice(0, maxResults),
        truncated: sorted.length > maxResults,
        total: sorted.length,
      };
    }
    return rankAppSets(all, query, maxResults);
  }, [states, query, maxResults]);

  const grouped = useMemo(() => {
    const map = new Map<string, AppSetSummary[]>();
    for (const appSet of ranked.items) {
      const bucket = map.get(appSet.instanceId);
      if (bucket) {
        bucket.push(appSet);
      } else {
        map.set(appSet.instanceId, [appSet]);
      }
    }
    return map;
  }, [ranked]);

  const showInstance = states.length > 1;

  return (
    <List
      isLoading={!ready || loading}
      filtering={false}
      throttle={false}
      onSearchTextChange={setQuery}
      searchBarPlaceholder="Search ApplicationSets by name, namespace or project"
      searchBarAccessory={
        <List.Dropdown
          tooltip="Which instances to search"
          value={scope}
          onChange={(value) => {
            setScope(value);
            void saveScope(value);
          }}
        >
          <List.Dropdown.Item value={ALL_SCOPE} title="All instances" icon={Icon.Globe} />
          {enabled.map((instance) => (
            <List.Dropdown.Item
              key={instance.id}
              value={instance.id}
              title={instance.name}
              icon={Icon.HardDrive}
            />
          ))}
        </List.Dropdown>
      }
    >
      <List.EmptyView
        icon={Icon.Layers}
        title={instances.length === 0 ? "No ArgoCD instance configured" : "No ApplicationSet found"}
        description={
          instances.length === 0
            ? "Add one from the Manage Instances command."
            : "Refresh to query the instances again."
        }
        actions={
          <ActionPanel>
            <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={refresh} />
          </ActionPanel>
        }
      />

      {states.map((state) => {
        const rows = grouped.get(state.instance.id) ?? [];
        if (rows.length === 0 && !state.error) {
          return null;
        }
        return (
          <List.Section
            key={state.instance.id}
            title={showInstance ? state.instance.name : "ApplicationSets"}
            subtitle={state.error ? `${rows.length} shown, ${state.error.name}` : `${rows.length} shown`}
          >
            {rows.map((appSet) => {
              const rollup = rollupAppSet(apps, appSet);
              const url = makeClient(state.instance).appSetUrl(appSet.name, appSet.namespace);
              return (
                <List.Item
                  key={`${appSet.instanceId}/${appSet.namespace}/${appSet.name}`}
                  icon={{
                    source: Icon.Layers,
                    tintColor: appSet.conditionError ? Color.Red : Color.SecondaryText,
                  }}
                  title={appSet.name}
                  subtitle={appSet.project ?? appSet.namespace}
                  accessories={[
                    ...(appSet.conditionError
                      ? [
                          {
                            tag: { value: "generator error", color: Color.Red },
                            tooltip: appSet.conditionError,
                          },
                        ]
                      : []),
                    ...(rollup.degraded > 0
                      ? [{ tag: { value: `${rollup.degraded} degraded`, color: Color.Red } }]
                      : []),
                    ...(rollup.outOfSync > 0
                      ? [{ tag: { value: `${rollup.outOfSync} out of sync`, color: Color.Yellow } }]
                      : []),
                    { text: `${rollup.total} apps` },
                    ...(showInstance
                      ? [{ tag: { value: state.instance.name, color: environmentColor(state.instance.env) } }]
                      : []),
                  ]}
                  actions={
                    <ActionPanel>
                      <ActionPanel.Section>
                        <Action
                          title="Show Generated Applications"
                          icon={Icon.Box}
                          onAction={() =>
                            push(
                              <AppSetApplications
                                instance={state.instance}
                                namespace={appSet.namespace}
                                appSetName={appSet.name}
                              />,
                            )
                          }
                        />
                        <Action.OpenInBrowser title="Open in ArgoCD" url={url} />
                      </ActionPanel.Section>
                      <ActionPanel.Section>
                        <Action.CopyToClipboard title="Copy ApplicationSet Name" content={appSet.name} />
                        <Action.CopyToClipboard
                          title="Copy ArgoCD URL"
                          content={url}
                          shortcut={Keyboard.Shortcut.Common.Copy}
                        />
                        <Action
                          title="Refresh"
                          icon={Icon.ArrowClockwise}
                          shortcut={Keyboard.Shortcut.Common.Refresh}
                          onAction={refresh}
                        />
                      </ActionPanel.Section>
                    </ActionPanel>
                  }
                />
              );
            })}
          </List.Section>
        );
      })}

      {ranked.truncated ? (
        <List.Section
          title="Truncated"
          subtitle={`showing ${ranked.items.length} of ${ranked.total}, refine the search`}
        >
          <List.Item
            icon={Icon.Ellipsis}
            title={`${ranked.total - ranked.items.length} more ApplicationSets match`}
            subtitle="Type more of the name, the namespace or the project."
          />
        </List.Section>
      ) : null}
    </List>
  );
}
