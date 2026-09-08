/**
 * Token storage for instances configured with an API token.
 *
 * Raycast's LocalStorage is not encrypted, so it is the wrong home for a credential. The macOS
 * keychain is reached through /usr/bin/security, a system binary, which keeps the extension
 * free of native dependencies that Raycast could not bundle anyway.
 *
 * The token is passed in argv, which was not the first choice. `security add-generic-password`
 * has no way to read a password from a file descriptor: the only alternative is `-w` with no
 * value, which prompts twice on the terminal. Feeding those prompts over stdin works from a
 * shell and does not work inside Raycast, where the child's stdin is not delivered: `security`
 * then stores an empty password and exits 0.
 *
 * So argv it is, and the exposure is worth stating plainly rather than pretending it away: for
 * the lifetime of one short-lived process, the token is visible to processes running as the
 * same user. That is the same boundary that already governs the stored item, since
 * `security find-generic-password -w` returns it to any same-uid process without a prompt.
 * macOS does not expose another user's argv without root. What this buys over the alternative
 * is a write that actually happens.
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
 * `-U` upserts, so re-storing a token over an existing item, including the empty item an
 * interrupted write leaves behind, replaces it.
 */
export function writeTokenArgs(instanceId: string, token: string): string[] {
  return ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", instanceId, "-w", token];
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
  if (/[\r\n]/.test(token)) {
    throw new Error("The token contains a line break, so it cannot be stored. Paste it as one line.");
  }
  if (token.length === 0) {
    throw new Error("Refusing to store an empty token.");
  }

  const result = await exec(SECURITY_BINARY, writeTokenArgs(instanceId, token));
  if (result.code !== 0) {
    throw failure("write", result.code, result.stderr);
  }

  // `security` exits 0 even when it stored nothing, so the exit code is not evidence. The only
  // proof is reading the value back, and the diagnosis has to distinguish the two ways that
  // can fail, because one message for both is what made the previous bug hard to place.
  let stored: string | undefined;
  try {
    stored = await readKeychainToken(instanceId, exec);
  } catch (error) {
    throw new Error(
      `The token was written but could not be read back to confirm it: ${(error as Error).message}`,
    );
  }

  if (stored === undefined) {
    throw new Error("The keychain reported no item after the write. Nothing was saved.");
  }
  if (stored !== token) {
    // Lengths only, never the values: this string reaches a toast.
    throw new Error(
      `The keychain stored a different value than the one given (${stored.length} characters instead of ${token.length}). Nothing usable was saved.`,
    );
  }
}

export async function deleteKeychainToken(instanceId: string, exec: Exec): Promise<void> {
  const result = await exec(SECURITY_BINARY, deleteTokenArgs(instanceId));
  if (result.code === ITEM_NOT_FOUND || result.code === 0) {
    return;
  }
  throw failure("delete", result.code, result.stderr);
}
