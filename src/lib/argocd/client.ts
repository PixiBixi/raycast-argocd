/**
 * The ArgoCD REST client.
 *
 * The API offers no field projection, so a list response is projected to the row model here and
 * the raw body is dropped immediately (see fields.ts for the measurements behind that). Every
 * request carries its own timeout, and every write is refused unless the instance is explicitly
 * marked writable. That last check duplicates what the UI already does by hiding the action:
 * the duplication is the point, because a UI regression must not be able to produce a write
 * against production.
 */

import type { ArgoInstance } from "../config/instances";
import { AuthError } from "../auth/provider";
import {
  ApiError,
  ForbiddenError,
  NetworkError,
  NotFoundError,
  ReadOnlyInstanceError,
  TimeoutError,
} from "./errors";
import { projectAppSet, type AppSetSummary } from "./appset";
import { projectDetail, projectSummary } from "./project";
import type { SyncRequest } from "./sync";
import type { AppDetail, AppSummary } from "./types";

export interface ClientDeps {
  fetch: typeof globalThis.fetch;
  getToken: (instance: ArgoInstance) => Promise<string>;
  timeoutMs?: number;
}

export interface ListResult {
  apps: AppSummary[];
  resourceVersion: string | undefined;
}

export interface AppSetListResult {
  appSets: AppSetSummary[];
  resourceVersion: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class ArgoClient {
  constructor(
    private readonly instance: ArgoInstance,
    private readonly deps: ClientDeps,
  ) {}

  appUrl(name: string, appNamespace: string): string {
    return `${this.instance.baseUrl}/applications/${encodeURIComponent(appNamespace)}/${encodeURIComponent(name)}`;
  }

  appSetUrl(name: string, namespace: string): string {
    return `${this.instance.baseUrl}/applicationsets/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
  }

  async listApplications(signal?: AbortSignal): Promise<ListResult> {
    const body = await this.get("/api/v1/applications", {}, signal);
    return {
      apps: this.projectItems(body, (item) => projectSummary(item, this.instance.id)),
      resourceVersion: readResourceVersion(body),
    };
  }

  async listApplicationSets(signal?: AbortSignal): Promise<AppSetListResult> {
    const body = await this.get("/api/v1/applicationsets", {}, signal);
    return {
      appSets: this.projectItems(body, (item) => projectAppSet(item, this.instance.id)),
      resourceVersion: readResourceVersion(body),
    };
  }

  async getApplication(
    name: string,
    appNamespace: string,
    refresh?: "normal" | "hard",
    signal?: AbortSignal,
  ): Promise<AppDetail> {
    const query: Record<string, string> = { appNamespace };
    if (refresh) {
      query.refresh = refresh;
    }
    return this.readApplication(name, query, signal);
  }

  async getApplicationStatus(name: string, appNamespace: string, signal?: AbortSignal): Promise<AppDetail> {
    return this.readApplication(name, { appNamespace }, signal);
  }

  async sync(name: string, appNamespace: string, body: SyncRequest, signal?: AbortSignal): Promise<void> {
    if (!this.instance.allowWrite) {
      throw new ReadOnlyInstanceError(this.instance.name);
    }
    await this.request(
      "POST",
      `/api/v1/applications/${encodeURIComponent(name)}/sync`,
      { appNamespace },
      body,
      signal,
    );
  }

  private async readApplication(
    name: string,
    query: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<AppDetail> {
    const body = await this.get(`/api/v1/applications/${encodeURIComponent(name)}`, query, signal);
    const detail = projectDetail(body, this.instance.id);
    if (!detail) {
      throw new ApiError(`${this.instance.name} returned an application without a name.`, 200);
    }
    return detail;
  }

  private projectItems<T>(body: unknown, project: (item: unknown) => T | undefined): T[] {
    const items = (body as { items?: unknown })?.items;
    if (!Array.isArray(items)) {
      return [];
    }
    // A single malformed item must not take the whole list down: it is dropped, not repaired.
    return items.map(project).filter((item): item is T => item !== undefined);
  }

  private get(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", path, query, undefined, signal);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    query: Record<string, string>,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const token = await this.deps.getToken(this.instance);
    const url = new URL(`${this.instance.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    const timeout = AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    // No Accept-Encoding here on purpose: Node's fetch negotiates gzip itself and decompresses
    // the body. Setting the header by hand is how you end up holding a compressed buffer.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
      response = await this.deps.fetch(url.toString(), {
        method,
        headers,
        signal: combined,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      // The URL is deliberately absent from these messages: a query string can carry more than
      // it looks like, and these strings end up in toasts and in Raycast's log.
      if (isAbort(error)) {
        throw new TimeoutError(`${this.instance.name} did not answer in time.`);
      }
      throw new NetworkError(`Could not reach ${this.instance.name}. Check your VPN connection.`);
    }

    if (!response.ok) {
      throw await this.toError(response);
    }

    if (response.status === 204) {
      return undefined;
    }
    try {
      return await response.json();
    } catch {
      throw new ApiError(`${this.instance.name} returned a response that is not JSON.`, response.status);
    }
  }

  private async toError(response: Response): Promise<Error> {
    const detail = await serverMessage(response);
    const host = hostOf(this.instance.baseUrl);

    switch (response.status) {
      case 401:
        return new AuthError(
          `The session for ${host} is not valid any more. Log in again.`,
          this.instance.id,
          host,
        );
      case 403:
        return new ForbiddenError(
          `Your account is not allowed to do this on ${this.instance.name}.${detail ? ` ${detail}` : ""}`,
        );
      case 404:
        return new NotFoundError(`Not found on ${this.instance.name}. It may have been deleted.`);
      default:
        return new ApiError(
          `${this.instance.name} answered ${response.status}.${detail ? ` ${detail}` : ""}`,
          response.status,
        );
    }
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function readResourceVersion(body: unknown): string | undefined {
  const version = (body as { metadata?: { resourceVersion?: unknown } })?.metadata?.resourceVersion;
  return typeof version === "string" ? version : undefined;
}

/**
 * ArgoCD reports errors as {"error": "...", "message": "..."}. Only that field is surfaced, and
 * only when it is short: a whole response body in a toast is noise at best and a leak at worst.
 */
async function serverMessage(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    const message = body.message ?? body.error;
    if (typeof message !== "string" || message.length === 0) {
      return undefined;
    }
    return message.length > 200 ? `${message.slice(0, 200)}...` : message;
  } catch {
    return undefined;
  }
}
