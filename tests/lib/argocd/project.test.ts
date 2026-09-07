import { describe, expect, it } from "vitest";
import {
  MEASURED_LIST_APPLICATIONS,
  MEASURED_LIST_GZIP_BYTES,
  SUPPORTED_LIST_FILTERS,
} from "../../../src/lib/argocd/fields";
import { buildHaystack, projectDetail, projectSummary } from "../../../src/lib/argocd/project";

const RAW_APP = {
  metadata: {
    name: "app-one",
    namespace: "team-a-apps",
    resourceVersion: "1234",
    ownerReferences: [
      { apiVersion: "argoproj.io/v1alpha1", kind: "ApplicationSet", name: "team-a-set", uid: "abc" },
    ],
  },
  spec: {
    project: "team-a",
    destination: { server: "https://kubernetes.default.svc", namespace: "team-a-runtime" },
    source: {
      repoURL: "https://github.example.com/team-a/manifests.git",
      path: "apps/app-one",
      targetRevision: "main",
    },
  },
  status: {
    sync: { status: "OutOfSync", revision: "0f1e2d3c4b5a" },
    health: { status: "Degraded" },
    operationState: { phase: "Failed", finishedAt: "2026-09-08T09:00:00Z" },
  },
};

describe("projectSummary", () => {
  it("fills every field of a single-source application", () => {
    const summary = projectSummary(RAW_APP, "i1");
    expect(summary).toMatchObject({
      instanceId: "i1",
      name: "app-one",
      namespace: "team-a-apps",
      project: "team-a",
      health: "Degraded",
      sync: "OutOfSync",
      phase: "Failed",
      finishedAt: "2026-09-08T09:00:00Z",
      destinationServer: "https://kubernetes.default.svc",
      destinationNamespace: "team-a-runtime",
      repoUrl: "https://github.example.com/team-a/manifests.git",
      path: "apps/app-one",
      targetRevision: "main",
      revision: "0f1e2d3c4b5a",
      appSetName: "team-a-set",
    });
  });

  it("builds a lowercased searchable haystack", () => {
    const summary = projectSummary(RAW_APP, "i1");
    expect(summary?.haystack).toContain("app-one");
    expect(summary?.haystack).toContain("team-a");
    expect(summary?.haystack).toContain("team-a-runtime");
    expect(summary?.haystack).toContain("team-a-set");
    expect(summary?.haystack).toBe(summary?.haystack.toLowerCase());
  });

  it("takes the first entry of a multi-source application", () => {
    const multi = {
      metadata: { name: "app-multi" },
      spec: {
        project: "team-a",
        sources: [
          { repoURL: "https://github.example.com/team-a/first.git", path: "first", targetRevision: "v1" },
          { repoURL: "https://github.example.com/team-a/second.git", path: "second" },
        ],
      },
    };
    expect(projectSummary(multi, "i1")).toMatchObject({
      repoUrl: "https://github.example.com/team-a/first.git",
      path: "first",
      targetRevision: "v1",
    });
  });

  it("treats an application with no status as unknown rather than dropping it", () => {
    const summary = projectSummary({ metadata: { name: "app-new" }, spec: { project: "team-a" } }, "i1");
    expect(summary).toMatchObject({ health: "Unknown", sync: "Unknown", phase: undefined });
  });

  it("defaults the namespace to argocd and the project to default", () => {
    const summary = projectSummary({ metadata: { name: "app-bare" } }, "i1");
    expect(summary).toMatchObject({ namespace: "argocd", project: "default" });
  });

  it("returns undefined for anything it cannot identify", () => {
    expect(projectSummary(null, "i1")).toBeUndefined();
    expect(projectSummary({}, "i1")).toBeUndefined();
    expect(projectSummary({ metadata: {} }, "i1")).toBeUndefined();
    expect(projectSummary({ metadata: { name: "" } }, "i1")).toBeUndefined();
    expect(projectSummary("app-one", "i1")).toBeUndefined();
    expect(projectSummary([], "i1")).toBeUndefined();
  });

  it("ignores owner references that are not an ApplicationSet", () => {
    const owned = {
      metadata: { name: "app-one", ownerReferences: [{ kind: "Application", name: "parent-app" }] },
    };
    expect(projectSummary(owned, "i1")?.appSetName).toBeUndefined();
  });

  it("leaves appSetName undefined when there is no owner reference", () => {
    expect(projectSummary({ metadata: { name: "app-one" } }, "i1")?.appSetName).toBeUndefined();
  });
});

describe("projectDetail", () => {
  const RAW_DETAIL = {
    ...RAW_APP,
    status: {
      ...RAW_APP.status,
      conditions: [
        { type: "SyncError", message: "one or more objects failed to apply" },
        { type: "", message: "dropped, no type" },
      ],
      summary: { images: ["registry.example.com/team-a/app-one:1.4.0"] },
      operationState: {
        phase: "Failed",
        message: "one or more objects failed to apply",
        startedAt: "2026-09-08T08:59:00Z",
        finishedAt: "2026-09-08T09:00:00Z",
        syncResult: {
          revision: "0f1e2d3c4b5a",
          resources: [
            {
              group: "apps",
              kind: "Deployment",
              namespace: "team-a-runtime",
              name: "app-one",
              status: "SyncFailed",
              message: "the server rejected the request",
              hookPhase: "Running",
            },
            { kind: "Service", name: "app-one" },
            { kind: "Service" },
          ],
        },
      },
      history: [
        { revision: "aaaaaaa", deployedAt: "2026-09-01T09:00:00Z" },
        { revision: "bbbbbbb", deployedAt: "2026-09-07T09:00:00Z" },
      ],
    },
  };

  it("keeps everything the summary carries", () => {
    expect(projectDetail(RAW_DETAIL, "i1")).toMatchObject({ name: "app-one", appSetName: "team-a-set" });
  });

  it("extracts the conditions, dropping entries with no type", () => {
    expect(projectDetail(RAW_DETAIL, "i1")?.conditions).toEqual([
      { type: "SyncError", message: "one or more objects failed to apply" },
    ]);
  });

  it("extracts the operation message and timestamps", () => {
    expect(projectDetail(RAW_DETAIL, "i1")).toMatchObject({
      operationMessage: "one or more objects failed to apply",
      operationStartedAt: "2026-09-08T08:59:00Z",
      summaryImages: ["registry.example.com/team-a/app-one:1.4.0"],
    });
  });

  it("reads the most recent history entry, which ArgoCD stores last", () => {
    expect(projectDetail(RAW_DETAIL, "i1")).toMatchObject({
      lastSyncRevision: "bbbbbbb",
      lastSyncDeployedAt: "2026-09-07T09:00:00Z",
    });
  });

  it("keeps sync result resources that have a name and drops the rest", () => {
    const resources = projectDetail(RAW_DETAIL, "i1")?.syncResources ?? [];
    expect(resources).toHaveLength(2);
    expect(resources[0]).toEqual({
      group: "apps",
      kind: "Deployment",
      namespace: "team-a-runtime",
      name: "app-one",
      status: "SyncFailed",
      message: "the server rejected the request",
      hookPhase: "Running",
    });
    expect(resources[1]).toMatchObject({ kind: "Service", name: "app-one", group: "", status: "" });
  });

  it("returns empty collections for an application that never synced", () => {
    expect(projectDetail({ metadata: { name: "app-new" } }, "i1")).toMatchObject({
      conditions: [],
      summaryImages: [],
      syncResources: [],
      lastSyncRevision: undefined,
      lastSyncDeployedAt: undefined,
      operationMessage: undefined,
    });
  });

  it("returns undefined for an unidentifiable application", () => {
    expect(projectDetail({}, "i1")).toBeUndefined();
  });
});

describe("buildHaystack", () => {
  it("drops undefined, lowercases and collapses whitespace", () => {
    expect(buildHaystack(["App-One", undefined, "  Team   A ", ""])).toBe("app-one team a");
  });

  it("is empty when there is nothing to index", () => {
    expect(buildHaystack([undefined, ""])).toBe("");
  });
});

describe("list filters", () => {
  it("documents only the query parameters ApplicationQuery actually declares", () => {
    expect([...SUPPORTED_LIST_FILTERS]).toEqual(["projects", "selector", "repo", "appNamespace"]);
    expect([...SUPPORTED_LIST_FILTERS]).not.toContain("fields");
  });

  it("keeps the measured list size on record, since it is what the read path is built around", () => {
    expect(MEASURED_LIST_APPLICATIONS).toBeGreaterThan(2000);
    expect(MEASURED_LIST_GZIP_BYTES).toBeLessThan(5 * 1024 * 1024);
  });
});
