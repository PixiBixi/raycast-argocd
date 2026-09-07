/**
 * Resolves the bearer token for an instance, from whichever store its auth mode names.
 *
 * Every failure is an AuthError carrying the instance and the host, because the only useful
 * recovery is "log in to that host", and the UI needs both to offer it. No message ever
 * carries the token itself.
 */

import type { ArgoInstance } from "../config/instances";
import { instanceHost } from "../config/instances";
import { isExpired, type CliToken } from "./cliConfig";

export class AuthError extends Error {
  constructor(
    message: string,
    readonly instanceId: string,
    readonly host: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface TokenProviderDeps {
  readCliToken: (host: string) => Promise<CliToken | undefined>;
  readKeychainToken: (instanceId: string) => Promise<string | undefined>;
  now: () => Date;
}

export type TokenProvider = (instance: ArgoInstance) => Promise<string>;

export function createTokenProvider(deps: TokenProviderDeps): TokenProvider {
  return async (instance) => {
    const host = instanceHost(instance);

    if (instance.authMode === "token") {
      const token = await deps.readKeychainToken(instance.id);
      if (!token) {
        throw new AuthError(
          `No API token stored for ${instance.name}. Add one from Manage Instances.`,
          instance.id,
          host,
        );
      }
      return token;
    }

    const session = await deps.readCliToken(host);
    if (!session) {
      throw new AuthError(
        `No argocd CLI session for ${host}. Run the SSO login to create one.`,
        instance.id,
        host,
      );
    }
    if (isExpired(session, deps.now())) {
      throw new AuthError(`The argocd CLI session for ${host} has expired. Log in again.`, instance.id, host);
    }
    return session.token;
  };
}
