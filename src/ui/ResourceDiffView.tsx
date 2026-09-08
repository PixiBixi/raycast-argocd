/**
 * The diff of what is out of sync.
 *
 * ArgoCD precomputes the `diff` string per resource, so nothing here diffs anything. The
 * managed-resources response is streamed and the live and target states are dropped on
 * projection, because on an application with many resources those two fields are the whole
 * payload.
 */

import { Action, ActionPanel, Detail, Icon } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import type { ResourceDiff, ResourceStatus } from "../lib/argocd/types";
import type { ArgoInstance } from "../lib/config/instances";
import { makeClient } from "./deps";

interface Props {
  appName: string;
  appNamespace: string;
  instance: ArgoInstance;
  /** When set, only this resource is requested, which keeps the common case small. */
  resource?: ResourceStatus;
}

function describe(diff: ResourceDiff): string {
  const identity = [diff.namespace, diff.name].filter(Boolean).join("/");
  return `${diff.kind || "Resource"} ${identity}`;
}

function render(diffs: ResourceDiff[] | undefined, isLoading: boolean, resource?: ResourceStatus): string {
  if (isLoading && !diffs) {
    return "Loading the diff...";
  }

  const modified = (diffs ?? []).filter((diff) => diff.modified && diff.diff.trim().length > 0);
  if (modified.length === 0) {
    return [
      resource ? `# ${resource.kind} ${resource.name}` : "# No diff",
      "",
      diffs && diffs.length > 0
        ? "ArgoCD reports no difference between the desired and the live state. An application can be out of sync while every resource matches, when the difference is a resource that exists on one side only."
        : "ArgoCD returned no managed resource for this application.",
    ].join("\n");
  }

  const lines: string[] = [];
  for (const diff of modified) {
    lines.push(`## ${describe(diff)}`, "", "```diff", diff.diff.trimEnd(), "```", "");
  }
  return lines.join("\n");
}

export function ResourceDiffView({ appName, appNamespace, instance, resource }: Props) {
  const {
    data: diffs,
    isLoading,
    error,
    revalidate,
  } = useCachedPromise(
    (name: string, namespace: string, target: ResourceStatus | undefined) =>
      makeClient(instance).getManagedResources(name, namespace, target),
    [appName, appNamespace, resource],
    { keepPreviousData: true },
  );

  const title = resource ? `Diff of ${resource.kind} ${resource.name}` : `Diff of ${appName}`;

  return (
    <Detail
      isLoading={isLoading}
      navigationTitle={title}
      markdown={error ? `# Could not load the diff\n\n${error.message}` : render(diffs, isLoading, resource)}
      actions={
        <ActionPanel>
          <Action.OpenInBrowser
            title="Open in ArgoCD"
            url={
              resource
                ? makeClient(instance).resourceUrl(appName, appNamespace, resource)
                : makeClient(instance).appUrl(appName, appNamespace)
            }
          />
          <Action title="Reload" icon={Icon.ArrowClockwise} onAction={() => void revalidate()} />
          {diffs && diffs.length > 0 ? (
            <Action.CopyToClipboard
              title="Copy Diff"
              content={diffs
                .filter((diff) => diff.modified)
                .map((diff) => `# ${describe(diff)}\n${diff.diff}`)
                .join("\n\n")}
            />
          ) : null}
        </ActionPanel>
      }
    />
  );
}
