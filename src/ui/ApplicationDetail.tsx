import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Detail,
  Icon,
  Toast,
  confirmAlert,
  showToast,
  useNavigation,
  Keyboard,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useEffect } from "react";
import { healthSeverity, syncSeverity } from "../lib/model/status";
import type { AppDetail, AppSummary } from "../lib/argocd/types";
import type { ArgoInstance } from "../lib/config/instances";
import { appKey } from "../lib/search/score";
import { DEFAULT_SYNC_FORM, buildSyncRequest } from "../lib/argocd/sync";
import { makeClient } from "./deps";
import { pushRecentKey } from "./storage";
import { environmentColor, healthIcon, phaseIcon, severityColor, syncIcon } from "./statusVisuals";
import { SyncForm } from "./SyncForm";
import { SyncStatus } from "./SyncStatus";
import { AppSetApplications } from "./AppSetApplications";

interface Props {
  app: AppSummary;
  instance: ArgoInstance;
  onRefresh: (instanceId?: string) => void;
}

function shorten(revision: string | undefined): string | undefined {
  if (!revision) {
    return undefined;
  }
  return /^[0-9a-f]{40}$/i.test(revision) ? revision.slice(0, 7) : revision;
}

function markdown(app: AppSummary, detail: AppDetail | undefined): string {
  const lines = [`# ${app.name}`];

  if (detail?.operationMessage) {
    lines.push("", `> ${detail.operationMessage}`);
  }

  const conditions = detail?.conditions ?? [];
  if (conditions.length > 0) {
    lines.push("", "## Conditions", "");
    for (const condition of conditions) {
      lines.push(`- **${condition.type}**: ${condition.message || "no message"}`);
    }
  }

  const images = detail?.summaryImages ?? [];
  if (images.length > 0) {
    lines.push("", "## Images", "");
    for (const image of images) {
      lines.push(`- \`${image}\``);
    }
  }

  if (detail && detail.syncResources.length > 0) {
    lines.push("", "## Last sync result", "", "| Kind | Name | Status |", "| --- | --- | --- |");
    for (const resource of detail.syncResources.slice(0, 30)) {
      lines.push(`| ${resource.kind || "?"} | ${resource.name} | ${resource.status || "?"} |`);
    }
    if (detail.syncResources.length > 30) {
      lines.push("", `_and ${detail.syncResources.length - 30} more resources_`);
    }
  }

  return lines.join("\n");
}

export function ApplicationDetail({ app, instance, onRefresh }: Props) {
  const { push } = useNavigation();
  const client = makeClient(instance);
  const url = client.appUrl(app.name, app.namespace);

  useEffect(() => {
    void pushRecentKey(appKey(app));
  }, [app]);

  const {
    data: detail,
    isLoading,
    revalidate,
  } = useCachedPromise(
    (name: string, namespace: string) => makeClient(instance).getApplication(name, namespace),
    [app.name, app.namespace],
    { keepPreviousData: true },
  );

  const current = detail ?? app;

  async function refreshApplication(mode: "normal" | "hard") {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: mode === "hard" ? "Hard refreshing" : "Refreshing",
    });
    try {
      await client.getApplication(app.name, app.namespace, mode);
      await revalidate();
      onRefresh(instance.id);
      toast.style = Toast.Style.Success;
      toast.title = "Refreshed";
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Refresh failed";
      toast.message = (error as Error).message;
    }
  }

  async function quickSync() {
    const confirmed = await confirmAlert({
      title: `Sync ${app.name}?`,
      message: `On ${instance.name} (${instance.env}), with the application's default sync options.`,
      icon: Icon.ArrowClockwise,
      primaryAction: { title: "Sync", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) {
      return;
    }
    try {
      await client.sync(app.name, app.namespace, buildSyncRequest(DEFAULT_SYNC_FORM));
      await showToast({ style: Toast.Style.Success, title: `Sync started for ${app.name}` });
      push(<SyncStatus app={app} instance={instance} />);
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Sync was refused",
        message: (error as Error).message,
      });
    }
  }

  return (
    <Detail
      isLoading={isLoading}
      navigationTitle={`${app.name} on ${instance.name}`}
      markdown={markdown(app, detail)}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.TagList title="Instance">
            <Detail.Metadata.TagList.Item text={instance.name} color={environmentColor(instance.env)} />
            <Detail.Metadata.TagList.Item
              text={instance.allowWrite ? "write enabled" : "read-only"}
              color={instance.allowWrite ? Color.Orange : Color.SecondaryText}
            />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Label title="Sync" text={current.sync} icon={syncIcon(current.sync)} />
          <Detail.Metadata.Label title="Health" text={current.health} icon={healthIcon(current.health)} />
          {current.phase ? (
            <Detail.Metadata.Label
              title="Last operation"
              text={`${current.phase}${current.finishedAt ? ` at ${current.finishedAt}` : ""}`}
              icon={phaseIcon(current.phase)}
            />
          ) : null}
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label title="Project" text={current.project} />
          <Detail.Metadata.Label title="Namespace" text={current.namespace} />
          {current.destinationNamespace ? (
            <Detail.Metadata.Label title="Destination namespace" text={current.destinationNamespace} />
          ) : null}
          {current.destinationServer || current.destinationName ? (
            <Detail.Metadata.Label
              title="Destination cluster"
              text={current.destinationName ?? current.destinationServer ?? ""}
            />
          ) : null}
          {current.appSetName ? (
            <Detail.Metadata.Label title="ApplicationSet" text={current.appSetName} icon={Icon.Layers} />
          ) : null}
          <Detail.Metadata.Separator />
          {current.repoUrl ? (
            <Detail.Metadata.Link title="Repository" target={current.repoUrl} text={current.repoUrl} />
          ) : null}
          {current.path ? <Detail.Metadata.Label title="Path" text={current.path} /> : null}
          {current.targetRevision ? (
            <Detail.Metadata.Label title="Target revision" text={current.targetRevision} />
          ) : null}
          {shorten(current.revision) ? (
            <Detail.Metadata.Label
              title="Current revision"
              text={shorten(current.revision)}
              icon={{ source: Icon.Dot, tintColor: severityColor(syncSeverity(current.sync)) }}
            />
          ) : null}
          {detail?.lastSyncDeployedAt ? (
            <Detail.Metadata.Label
              title="Last deployed"
              text={`${shorten(detail.lastSyncRevision) ?? "unknown"} at ${detail.lastSyncDeployedAt}`}
              icon={{ source: Icon.Clock, tintColor: severityColor(healthSeverity(current.health)) }}
            />
          ) : null}
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            <Action.OpenInBrowser title="Open in ArgoCD" url={url} />
            <Action
              title="Show Sync Status"
              icon={Icon.Clock}
              shortcut={Keyboard.Shortcut.Common.ToggleQuickLook}
              onAction={() => push(<SyncStatus app={app} instance={instance} />)}
            />
          </ActionPanel.Section>
          <ActionPanel.Section title="Refresh">
            <Action
              title="Refresh Application"
              icon={Icon.ArrowClockwise}
              shortcut={Keyboard.Shortcut.Common.Refresh}
              onAction={() => void refreshApplication("normal")}
            />
            <Action
              title="Hard Refresh Application"
              icon={Icon.ArrowClockwise}
              shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
              onAction={() => void refreshApplication("hard")}
            />
          </ActionPanel.Section>
          {instance.allowWrite ? (
            <ActionPanel.Section title="Sync">
              <Action
                title="Sync with Options"
                icon={Icon.Gear}
                onAction={() => push(<SyncForm app={app} instance={instance} />)}
              />
              <Action
                title="Quick Sync"
                icon={Icon.ArrowClockwise}
                style={Action.Style.Destructive}
                onAction={() => void quickSync()}
              />
            </ActionPanel.Section>
          ) : null}
          <ActionPanel.Section>
            {current.appSetName ? (
              <Action
                title="Show Sibling Applications"
                icon={Icon.Layers}
                onAction={() =>
                  push(
                    <AppSetApplications
                      instance={instance}
                      namespace={current.namespace}
                      appSetName={current.appSetName ?? ""}
                    />,
                  )
                }
              />
            ) : null}
            <Action.CopyToClipboard title="Copy Application Name" content={app.name} />
            <Action.CopyToClipboard
              title="Copy ArgoCD URL"
              content={url}
              shortcut={Keyboard.Shortcut.Common.Copy}
            />
            {current.repoUrl ? (
              <Action.OpenInBrowser title="Open Source Repository" url={current.repoUrl} />
            ) : null}
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}
