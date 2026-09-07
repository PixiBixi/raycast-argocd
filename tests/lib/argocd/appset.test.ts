import { describe, expect, it } from "vitest";
import { filterByAppSet, projectAppSet, rollupAppSet } from "../../../src/lib/argocd/appset";
import { projectSummary } from "../../../src/lib/argocd/project";
import type { AppSummary } from "../../../src/lib/argocd/types";

function app(overrides: Partial<AppSummary> = {}): AppSummary {
  const base = projectSummary({ metadata: { name: "app-one" }, spec: { project: "team-a" } }, "i1");
  if (!base) {
    throw new Error("fixture failed to project");
  }
  return { ...base, ...overrides };
}

const APPSET = {
  metadata: { name: "team-a-set", namespace: "team-a-apps" },
  spec: { template: { spec: { project: "team-a" } } },
  status: { conditions: [{ type: "ErrorOccurred", status: "False", message: "Successfully generated" }] },
};

describe("projectAppSet", () => {
  it("reads the identity and the templated project", () => {
    expect(projectAppSet(APPSET, "i1")).toMatchObject({
      instanceId: "i1",
      name: "team-a-set",
      namespace: "team-a-apps",
      project: "team-a",
      conditionError: undefined,
    });
  });

  it("builds a searchable haystack", () => {
    expect(projectAppSet(APPSET, "i1")?.haystack).toBe("team-a-set team-a-apps team-a");
  });

  it("surfaces the message of an ErrorOccurred condition that is currently true", () => {
    const broken = {
      ...APPSET,
      status: {
        conditions: [
          { type: "ParametersGenerated", status: "True", message: "ignored" },
          { type: "ErrorOccurred", status: "True", message: "the git generator returned 404" },
        ],
      },
    };
    expect(projectAppSet(broken, "i1")?.conditionError).toBe("the git generator returned 404");
  });

  it("falls back to a generic message when the failing condition carries none", () => {
    const broken = { ...APPSET, status: { conditions: [{ type: "ErrorOccurred", status: "True" }] } };
    expect(projectAppSet(broken, "i1")?.conditionError).toBe("The generator reported an error.");
  });

  it("leaves conditionError undefined when there are no conditions at all", () => {
    expect(projectAppSet({ metadata: { name: "team-a-set" } }, "i1")?.conditionError).toBeUndefined();
  });

  it("defaults the namespace to argocd", () => {
    expect(projectAppSet({ metadata: { name: "team-a-set" } }, "i1")?.namespace).toBe("argocd");
  });

  it("leaves the project undefined when the template does not set one", () => {
    expect(projectAppSet({ metadata: { name: "team-a-set" } }, "i1")?.project).toBeUndefined();
  });

  it("returns undefined for anything it cannot identify", () => {
    expect(projectAppSet(null, "i1")).toBeUndefined();
    expect(projectAppSet({}, "i1")).toBeUndefined();
    expect(projectAppSet({ metadata: { name: "" } }, "i1")).toBeUndefined();
  });
});

describe("filterByAppSet", () => {
  const owned = app({ name: "generated-one", namespace: "team-a-apps", appSetName: "team-a-set" });
  const otherNamespace = app({ name: "same-name-elsewhere", namespace: "team-b-apps", appSetName: "team-a-set" });
  const otherInstance = app({
    name: "generated-two",
    namespace: "team-a-apps",
    appSetName: "team-a-set",
    instanceId: "i2",
  });
  const unowned = app({ name: "hand-written", namespace: "team-a-apps", appSetName: undefined });

  it("matches on instance, namespace and owner name together", () => {
    const result = filterByAppSet([owned, otherNamespace, otherInstance, unowned], "i1", "team-a-apps", "team-a-set");
    expect(result.map((a) => a.name)).toEqual(["generated-one"]);
  });

  it("returns nothing for an ApplicationSet that owns nothing", () => {
    expect(filterByAppSet([unowned], "i1", "team-a-apps", "team-a-set")).toEqual([]);
  });
});

describe("rollupAppSet", () => {
  const appSet = projectAppSet(APPSET, "i1");
  if (!appSet) {
    throw new Error("fixture failed to project");
  }

  it("counts only the applications it owns", () => {
    const apps = [
      app({ name: "a", namespace: "team-a-apps", appSetName: "team-a-set", sync: "Synced", health: "Healthy" }),
      app({ name: "b", namespace: "team-a-apps", appSetName: "team-a-set", sync: "OutOfSync", health: "Healthy" }),
      app({ name: "c", namespace: "team-a-apps", appSetName: "team-a-set", sync: "Synced", health: "Degraded" }),
      app({ name: "d", namespace: "team-a-apps", appSetName: "other-set", sync: "OutOfSync", health: "Degraded" }),
      app({ name: "e", namespace: "team-b-apps", appSetName: "team-a-set", sync: "OutOfSync" }),
    ];
    expect(rollupAppSet(apps, appSet)).toEqual({ total: 3, outOfSync: 1, degraded: 1, attention: 2 });
  });

  it("returns zeroes for an ApplicationSet that generated nothing", () => {
    expect(rollupAppSet([], appSet)).toEqual({ total: 0, outOfSync: 0, degraded: 0, attention: 0 });
  });

  it("counts an application that is both out of sync and degraded once in attention", () => {
    const apps = [
      app({ namespace: "team-a-apps", appSetName: "team-a-set", sync: "OutOfSync", health: "Degraded" }),
    ];
    expect(rollupAppSet(apps, appSet)).toEqual({ total: 1, outOfSync: 1, degraded: 1, attention: 1 });
  });
});
