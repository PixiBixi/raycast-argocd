import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Form,
  Icon,
  List,
  Toast,
  confirmAlert,
  showToast,
  useNavigation,
  Keyboard,
} from "@raycast/api";
import { useCallback, useEffect, useState } from "react";
import { UNKNOWN_REACHABILITY, type Reachability } from "./lib/argocd/probe";
import { instanceHost, removeInstance, upsertInstance, type ArgoInstance } from "./lib/config/instances";
import { deleteKeychainToken, readKeychainToken, writeKeychainToken } from "./lib/auth/keychain";
import { InstanceForm } from "./ui/InstanceForm";
import { execFileAsync, probe, ssoLogin } from "./ui/deps";
import { loadInstances, loadReachability, saveInstances, saveReachability } from "./ui/storage";
import { environmentColor, reachabilityIcon, reachabilityText } from "./ui/statusVisuals";

export default function ManageInstances() {
  const { push } = useNavigation();
  const [instances, setInstances] = useState<ArgoInstance[]>([]);
  const [reachability, setReachability] = useState<Record<string, Reachability>>({});
  const [loading, setLoading] = useState(true);

  const persist = useCallback(async (next: ArgoInstance[]) => {
    await saveInstances(next);
    setInstances(next);
  }, []);

  const checkAll = useCallback(async (targets: ArgoInstance[]) => {
    const results = await Promise.all(
      targets.map(async (instance) => [instance.id, await probe(instance)] as const),
    );
    const map = Object.fromEntries(results);
    setReachability((current) => ({ ...current, ...map }));
    await saveReachability({ ...(await loadReachability()), ...map });
  }, []);

  useEffect(() => {
    void (async () => {
      const stored = await loadInstances();
      setInstances(stored);
      setReachability(await loadReachability());
      setLoading(false);
      await checkAll(stored);
    })();
  }, [checkAll]);

  async function remove(instance: ArgoInstance) {
    const confirmed = await confirmAlert({
      title: `Remove ${instance.name}?`,
      message: "The extension stops querying it. Nothing changes on the ArgoCD server itself.",
      icon: Icon.Trash,
      primaryAction: { title: "Remove", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) {
      return;
    }
    await persist(removeInstance(instances, instance.id));
    // The keychain entry has no other owner, so it goes with the instance.
    await deleteKeychainToken(instance.id, execFileAsync).catch(() => undefined);
    await showToast({ style: Toast.Style.Success, title: `Removed ${instance.name}` });
  }

  async function login(instance: ArgoInstance) {
    const host = instanceHost(instance);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Logging in to ${host}`,
      message: "Finish the login in your browser.",
    });
    try {
      await ssoLogin(host);
      toast.style = Toast.Style.Success;
      toast.title = `Logged in to ${host}`;
      toast.message = undefined;
      await checkAll([instance]);
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "SSO login did not complete";
      toast.message = (error as Error).message;
    }
  }

  return (
    <List isLoading={loading} searchBarPlaceholder="Filter instances">
      <List.EmptyView
        icon={Icon.Plus}
        title="No ArgoCD instance configured"
        description="Add the server URL of each ArgoCD you want to search. Nothing is stored outside this Mac."
        actions={
          <ActionPanel>
            <Action
              title="Add Instance"
              icon={Icon.Plus}
              onAction={() => push(<InstanceForm instances={instances} onSaved={persist} />)}
            />
          </ActionPanel>
        }
      />
      {instances.map((instance) => {
        const state = reachability[instance.id] ?? UNKNOWN_REACHABILITY;
        return (
          <List.Item
            key={instance.id}
            icon={reachabilityIcon(state)}
            title={instance.name}
            subtitle={instance.baseUrl}
            accessories={[
              { text: reachabilityText(state) },
              {
                tag: {
                  value: instance.allowWrite ? "write enabled" : "read-only",
                  color: instance.allowWrite ? Color.Orange : Color.SecondaryText,
                },
              },
              { tag: { value: instance.env, color: environmentColor(instance.env) } },
              ...(instance.enabled ? [] : [{ tag: { value: "excluded", color: Color.SecondaryText } }]),
            ]}
            actions={
              <ActionPanel>
                <ActionPanel.Section>
                  <Action
                    title="Edit Instance"
                    icon={Icon.Pencil}
                    onAction={() =>
                      push(<InstanceForm instances={instances} editing={instance} onSaved={persist} />)
                    }
                  />
                  <Action
                    title="Check Reachability"
                    icon={Icon.Network}
                    shortcut={{ modifiers: ["cmd"], key: "t" }}
                    onAction={() => void checkAll(instances)}
                  />
                  <Action
                    title={instance.enabled ? "Exclude from Searches" : "Include in Searches"}
                    icon={instance.enabled ? Icon.EyeDisabled : Icon.Eye}
                    onAction={() =>
                      void persist(upsertInstance(instances, { ...instance, enabled: !instance.enabled }))
                    }
                  />
                </ActionPanel.Section>
                <ActionPanel.Section title="Authentication">
                  {instance.authMode === "cli" ? (
                    <Action
                      title="Log in with SSO"
                      icon={Icon.Person}
                      onAction={() => void login(instance)}
                    />
                  ) : (
                    <Action
                      title="Set API Token"
                      icon={Icon.Key}
                      onAction={() => push(<TokenForm instance={instance} />)}
                    />
                  )}
                  {instance.authMode === "token" ? (
                    <Action
                      title="Clear API Token"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      onAction={async () => {
                        await deleteKeychainToken(instance.id, execFileAsync);
                        await showToast({
                          style: Toast.Style.Success,
                          title: "Token removed from the keychain",
                        });
                      }}
                    />
                  ) : null}
                </ActionPanel.Section>
                <ActionPanel.Section>
                  <Action.OpenInBrowser title="Open ArgoCD" url={instance.baseUrl} />
                  <Action
                    title="Add Instance"
                    icon={Icon.Plus}
                    shortcut={Keyboard.Shortcut.Common.New}
                    onAction={() => push(<InstanceForm instances={instances} onSaved={persist} />)}
                  />
                  <Action
                    title="Remove Instance"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    shortcut={{ modifiers: ["ctrl"], key: "x" }}
                    onAction={() => void remove(instance)}
                  />
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}

function TokenForm({ instance }: { instance: ArgoInstance }) {
  const { pop } = useNavigation();
  const [token, setToken] = useState("");
  const [hasExisting, setHasExisting] = useState(false);

  useEffect(() => {
    void readKeychainToken(instance.id, execFileAsync)
      .then((existing) => setHasExisting(existing !== undefined))
      .catch(() => setHasExisting(false));
  }, [instance.id]);

  return (
    <Form
      navigationTitle={`API token for ${instance.name}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Store in Keychain"
            icon={Icon.Key}
            onSubmit={async () => {
              const trimmed = token.trim();
              if (trimmed.length === 0) {
                await showToast({ style: Toast.Style.Failure, title: "The token is empty" });
                return;
              }
              try {
                // writeKeychainToken reads the value back before it returns, so reaching this
                // toast means the keychain really holds the token. `security` exits 0 even when
                // it stored nothing, so an earlier version announced success on an empty write.
                await writeKeychainToken(instance.id, trimmed, execFileAsync);
              } catch (error) {
                await showToast({
                  style: Toast.Style.Failure,
                  title: "The token was not stored",
                  message: (error as Error).message,
                });
                return;
              }
              await showToast({ style: Toast.Style.Success, title: "Token stored in the keychain" });
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Where it is stored"
        text={`The token goes into the macOS keychain under the service raycast-argocd, never into Raycast's storage.${
          hasExisting ? " A token is already stored for this instance and will be replaced." : ""
        }`}
      />
      <Form.PasswordField
        id="token"
        title="API token"
        placeholder="argocd account generate-token --account <name>"
        value={token}
        onChange={setToken}
      />
    </Form>
  );
}
