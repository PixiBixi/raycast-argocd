/**
 * The single place where the pure lib layer is wired to the real world: the Raycast runtime,
 * the filesystem, the network and the argocd CLI. Everything below src/lib takes these as
 * arguments, which is what keeps it testable.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { environment } from "@raycast/api";
import { join } from "node:path";
import { ArgoClient, type ClientDeps } from "../lib/argocd/client";
import { probeInstance, type Reachability } from "../lib/argocd/probe";
import { ProjectionCache } from "../lib/cache/store";
import { readCliToken } from "../lib/auth/cliConfig";
import { readKeychainToken, type Exec } from "../lib/auth/keychain";
import { createTokenProvider } from "../lib/auth/provider";
import { runSsoLogin } from "../lib/auth/login";
import type { ArgoInstance } from "../lib/config/instances";
import { readPreferences } from "./preferences";

/**
 * execFile, never exec: arguments are passed as an array so a value carrying a shell
 * metacharacter stays an argument instead of becoming a command.
 */
export const execFileAsync: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
      if (error && code === 0) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
    if (opts?.input !== undefined) {
      // Not `child.stdin?.end(...)`: when stdin is unavailable the optional chain writes
      // nothing and reports nothing, and the child then runs against no input at all. That is
      // how a keychain write silently stored an empty password.
      if (!child.stdin) {
        reject(new Error(`Cannot write to the stdin of ${file}: the child has no stdin stream.`));
        return;
      }
      child.stdin.end(opts.input);
    }
  });

export const getToken = createTokenProvider({
  readCliToken: (host) => readCliToken(host),
  readKeychainToken: (instanceId) => readKeychainToken(instanceId, execFileAsync),
  now: () => new Date(),
});

export function makeClient(instance: ArgoInstance): ArgoClient {
  const { requestTimeoutSeconds } = readPreferences();
  const deps: ClientDeps = {
    fetch: globalThis.fetch,
    getToken,
    timeoutMs: requestTimeoutSeconds * 1000,
  };
  return new ArgoClient(instance, deps);
}

export function makeCache(): ProjectionCache {
  return new ProjectionCache(join(environment.supportPath, "cache"), {
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, data) => writeFile(path, data, { encoding: "utf8", mode: 0o600 }),
    rename,
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    now: () => Date.now(),
  });
}

export function probe(instance: ArgoInstance): Promise<Reachability> {
  const { probeTimeoutSeconds } = readPreferences();
  return probeInstance(instance, {
    fetch: globalThis.fetch,
    now: () => Date.now(),
    timeoutMs: probeTimeoutSeconds * 1000,
  });
}

/**
 * Spawns `argocd login --sso` detached: the CLI opens the browser and serves the loopback
 * callback itself, then rewrites its config file, which is what the poller watches for.
 */
export function ssoLogin(host: string): Promise<{ token: string }> {
  const { argocdCliPath } = readPreferences();
  return runSsoLogin(host, argocdCliPath, {
    spawn: (file, args) => {
      const child = spawn(file, args, { detached: true, stdio: "ignore" });
      child.unref();
    },
    readToken: (target) => readCliToken(target),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  });
}
