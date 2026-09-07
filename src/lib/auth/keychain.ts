/**
 * Token storage for instances configured with an API token.
 *
 * Raycast's LocalStorage is not encrypted, so it is the wrong home for a credential. The macOS
 * keychain is reached through /usr/bin/security, a system binary, which keeps the extension
 * free of native dependencies that Raycast could not bundle anyway.
 */

export type Exec = (
  file: string,
  args: string[],
  opts?: { input?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export const KEYCHAIN_SERVICE = "raycast-argocd";
export const SECURITY_BINARY = "/usr/bin/security";

/** `security` exit code for "the specified item could not be found in the keychain". */
const ITEM_NOT_FOUND = 44;

export function readTokenArgs(instanceId: string): string[] {
  return ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", instanceId, "-w"];
}

/**
 * The token is deliberately absent from argv: everything in argv is visible to any process
 * that can run `ps`. It is written through stdin instead, using the `-w` form with no value.
 */
export function writeTokenArgs(instanceId: string): string[] {
  return ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", instanceId, "-w"];
}

export function deleteTokenArgs(instanceId: string): string[] {
  return ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", instanceId];
}

function failure(action: string, code: number, stderr: string): Error {
  // stderr from `security` never carries the secret, but it is trimmed to one line anyway so a
  // surprising build cannot spill anything into a toast.
  const detail = stderr.split("\n")[0]?.trim() ?? "";
  return new Error(`Could not ${action} the keychain entry (exit ${code}). ${detail}`.trim());
}

export async function readKeychainToken(instanceId: string, exec: Exec): Promise<string | undefined> {
  const result = await exec(SECURITY_BINARY, readTokenArgs(instanceId));
  if (result.code === ITEM_NOT_FOUND) {
    return undefined;
  }
  if (result.code !== 0) {
    throw failure("read", result.code, result.stderr);
  }
  const token = result.stdout.trim();
  return token.length > 0 ? token : undefined;
}

export async function writeKeychainToken(instanceId: string, token: string, exec: Exec): Promise<void> {
  const result = await exec(SECURITY_BINARY, writeTokenArgs(instanceId), { input: token });
  if (result.code !== 0) {
    throw failure("write", result.code, result.stderr);
  }
}

export async function deleteKeychainToken(instanceId: string, exec: Exec): Promise<void> {
  const result = await exec(SECURITY_BINARY, deleteTokenArgs(instanceId));
  if (result.code === ITEM_NOT_FOUND || result.code === 0) {
    return;
  }
  throw failure("delete", result.code, result.stderr);
}
