/**
 * The diff of what is out of sync.
 *
 * The diff is computed in `lib/argocd/project.ts` from the two states ArgoCD returns, because
 * its own `diff` field is declared but not populated. The response is streamed and the states
 * are dropped as soon as each resource is diffed, since on an application with many resources
 * those fields are the whole payload.
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

function stats(diff: ResourceDiff): string {
  if (diff.tooLarge) {
    return "too large to diff";
  }
  const parts = [
    diff.added > 0 ? `+${diff.added}` : undefined,
    diff.removed > 0 ? `-${diff.removed}` : undefined,
  ];
  return parts.filter(Boolean).join(" ");
}

function render(diffs: ResourceDiff[] | undefined, isLoading: boolean, resource?: ResourceStatus): string {
  if (isLoading && !diffs) {
    return "Loading the diff...";
  }

  const modified = (diffs ?? []).filter((diff) => diff.modified);
  if (modified.length === 0) {
    return [
      resource ? `# ${resource.kind} ${resource.name}` : "# No difference",
      "",
      diffs && diffs.length > 0
        ? `Comparing the desired state against the live one found no difference across ${diffs.length} managed resource${diffs.length === 1 ? "" : "s"}. An application can still be out of sync when the difference is a resource present on one side only, which the resources view shows.`
        : "ArgoCD returned no managed resource for this application.",
    ].join("\n");
  }

  const lines: string[] = [];
  const heading = resource
    ? []
    : [`# ${modified.length} resource${modified.length === 1 ? "" : "s"} differ`, ""];
  lines.push(...heading);

  for (const diff of modified) {
    const summary = stats(diff);
    lines.push(`## ${describe(diff)}${summary ? ` (${summary})` : ""}`, "");
    if (diff.tooLarge) {
      lines.push(
        "The manifest is past the diff line limit, so it was not compared. Open it in ArgoCD to see the difference.",
        "",
      );
      continue;
    }
    lines.push("```diff", diff.diff.trimEnd(), "```", "");
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
