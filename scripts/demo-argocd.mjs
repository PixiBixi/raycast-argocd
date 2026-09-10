#!/usr/bin/env node
/**
 * A fake ArgoCD API on loopback, for taking store screenshots without showing a real cluster.
 *
 * The store listing is public and an application list is a list of service names, so the
 * screenshots cannot come from a real instance. This serves an invented corpus instead:
 * fictional products, fictional teams, no relation to any deployment. It answers every
 * endpoint the extension calls, with the field shapes the projection reads, so the rows paint
 * fully rather than showing "unknown" everywhere.
 *
 * It is a development tool. scripts/ does not travel in the store payload.
 *
 *   node scripts/demo-argocd.mjs          # then add http://127.0.0.1:8080, auth mode "token"
 *
 * Cleartext is fine here and nowhere else: loopback traffic never leaves the machine, which is
 * why normalizeBaseUrl exempts exactly localhost, 127.0.0.1 and ::1.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = "127.0.0.1";

// A deterministic generator, so the same screenshot can be retaken after a code change.
let seed = 0x2f6e2b1;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const PROJECTS = ["storefront", "platform", "data-pipeline", "identity", "observability"];
const SERVICES = [
  "checkout-api",
  "catalog-web",
  "cart-service",
  "payments-worker",
  "search-indexer",
  "recommendation-engine",
  "inventory-sync",
  "shipping-quotes",
  "tax-calculator",
  "session-store",
  "notification-relay",
  "media-transcoder",
  "invoice-renderer",
  "fraud-scoring",
  "loyalty-points",
  "gift-cards",
  "price-feed",
  "review-moderator",
  "ingest-gateway",
  "stream-aggregator",
  "warehouse-loader",
  "report-builder",
  "metrics-collector",
  "trace-sampler",
  "log-shipper",
  "alert-router",
];
const REGIONS = ["eu-west", "eu-north", "us-east"];
const STAGES = ["prod", "staging", "canary"];

const HEALTHS = [
  ...Array(74).fill("Healthy"),
  ...Array(9).fill("Progressing"),
  ...Array(8).fill("Degraded"),
  ...Array(6).fill("Missing"),
  ...Array(3).fill("Suspended"),
];
const SYNCS = [...Array(78).fill("Synced"), ...Array(22).fill("OutOfSync")];

const APP_SETS = PROJECTS.map((project) => ({ name: `${project}-regions`, project }));

function sha() {
  return Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
}

function iso(minutesAgo) {
  return new Date(Date.UTC(2026, 8, 9, 6, 0, 0) - minutesAgo * 60_000).toISOString();
}

function resources(app, health, sync) {
  const kinds = [
    ["apps", "Deployment", app],
    ["", "Service", app],
    ["", "ConfigMap", `${app}-config`],
    ["networking.k8s.io", "Ingress", app],
    ["autoscaling", "HorizontalPodAutoscaler", app],
    ["", "ServiceAccount", app],
  ];
  return kinds.map(([group, kind, name], i) => ({
    group,
    version: "v1",
    kind,
    name,
    namespace: `${app}-ns`,
    status: sync === "OutOfSync" && i < 2 ? "OutOfSync" : "Synced",
    health: { status: health === "Degraded" && i === 0 ? "Degraded" : "Healthy" },
  }));
}

const APPLICATIONS = [];
for (const service of SERVICES) {
  for (const region of REGIONS) {
    for (const stage of STAGES) {
      if (rand() > 0.62) continue;
      const project = PROJECTS[SERVICES.indexOf(service) % PROJECTS.length];
      const name = `${service}-${region}-${stage}`;
      const health = pick(HEALTHS);
      const sync = pick(SYNCS);
      const revision = sha();
      const appSet = APP_SETS.find((s) => s.project === project);
      APPLICATIONS.push({
        metadata: {
          name,
          namespace: "argocd",
          ownerReferences: [{ apiVersion: "argoproj.io/v1alpha1", kind: "ApplicationSet", name: appSet.name }],
        },
        spec: {
          project,
          destination: { name: `${region}-${stage}`, namespace: `${service}-ns` },
          source: {
            repoURL: "https://github.com/example-org/platform-manifests.git",
            path: `apps/${service}/overlays/${region}-${stage}`,
            targetRevision: stage === "prod" ? "main" : stage,
          },
          syncPolicy:
            stage === "prod"
              ? { syncOptions: ["CreateNamespace=true"] }
              : { automated: { prune: true, selfHeal: true }, syncOptions: ["CreateNamespace=true"] },
        },
        status: {
          health: { status: health },
          sync: { status: sync, revision },
          reconciledAt: iso(Math.floor(rand() * 120)),
          summary: { images: [`ghcr.io/example-org/${service}:1.${Math.floor(rand() * 40)}.0`] },
          resources: resources(service, health, sync),
          conditions:
            health === "Degraded"
              ? [
                  {
                    type: "ComparisonError",
                    message: "rpc error: manifest generation failed",
                    lastTransitionTime: iso(12),
                  },
                ]
              : [],
          operationState: {
            phase: health === "Progressing" ? "Running" : "Succeeded",
            message: health === "Progressing" ? "waiting for rollout" : "successfully synced",
            startedAt: iso(9),
            finishedAt: health === "Progressing" ? undefined : iso(8),
            syncResult: {
              revision,
              resources: resources(service, health, sync)
                .slice(0, 3)
                .map((r) => ({
                  group: r.group,
                  kind: r.kind,
                  name: r.name,
                  namespace: r.namespace,
                  status: "Synced",
                  message: "configured",
                  hookPhase: "Running",
                })),
            },
          },
          history: [0, 1, 2].map((i) => ({
            id: 3 - i,
            revision: sha(),
            deployedAt: iso(60 * (i + 1)),
            source: { repoURL: "https://github.com/example-org/platform-manifests.git" },
          })),
        },
      });
    }
  }
}

const APPLICATIONSETS = APP_SETS.map(({ name, project }) => ({
  metadata: { name, namespace: "argocd" },
  spec: { generators: [{ list: { elements: [] } }], template: { spec: { project } } },
  status: {
    conditions: [
      {
        type: "ResourcesUpToDate",
        status: "True",
        message: "All applications have been generated successfully",
        lastTransitionTime: iso(30),
      },
    ],
  },
}));

const MANIFEST_LIVE = (app) => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: app, namespace: `${app}-ns`, labels: { "app.kubernetes.io/name": app } },
  spec: {
    replicas: 3,
    template: {
      spec: {
        containers: [
          {
            name: app,
            image: `ghcr.io/example-org/${app}:1.12.0`,
            resources: { requests: { cpu: "250m", memory: "512Mi" } },
          },
        ],
      },
    },
  },
});

const MANIFEST_TARGET = (app) => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: app, namespace: `${app}-ns`, labels: { "app.kubernetes.io/name": app } },
  spec: {
    replicas: 5,
    template: {
      spec: {
        containers: [
          {
            name: app,
            image: `ghcr.io/example-org/${app}:1.13.0`,
            resources: { requests: { cpu: "500m", memory: "512Mi" } },
          },
        ],
      },
    },
  },
});

const send = (res, code, body) => {
  const json = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
};

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}`);
  const app = (n) => APPLICATIONS.find((a) => a.metadata.name === n);

  if (pathname === "/api/version") {
    return send(res, 200, {
      Version: "v3.5.1+demo",
      BuildDate: iso(0),
      Compiler: "gc",
      Platform: "linux/amd64",
    });
  }
  if (pathname === "/api/v1/settings") {
    return send(res, 200, { oidcConfig: null, dexConfig: {}, url: `http://${HOST}:${PORT}` });
  }
  if (pathname === "/api/v1/applications") {
    return send(res, 200, { metadata: { resourceVersion: "1" }, items: APPLICATIONS });
  }
  if (pathname === "/api/v1/applicationsets") {
    return send(res, 200, { metadata: { resourceVersion: "1" }, items: APPLICATIONSETS });
  }

  let m = pathname.match(/^\/api\/v1\/applications\/([^/]+)\/managed-resources$/);
  if (m) {
    const name = decodeURIComponent(m[1]);
    const service = name.replace(/-(eu-west|eu-north|us-east)-(prod|staging|canary)$/, "");
    const target = MANIFEST_TARGET(service);
    const live = MANIFEST_LIVE(service);
    return send(res, 200, {
      items: [
        {
          group: "apps",
          version: "v1",
          kind: "Deployment",
          namespace: `${service}-ns`,
          name: service,
          targetState: JSON.stringify(target),
          liveState: JSON.stringify(live),
          diff: "",
        },
      ],
    });
  }

  m = pathname.match(/^\/api\/v1\/applications\/([^/]+)\/revisions\/([^/]+)\/metadata$/);
  if (m) {
    return send(res, 200, {
      author: "Example Author",
      date: iso(70),
      message: "chore(catalog): raise the replica floor",
      tags: [],
    });
  }

  m = pathname.match(/^\/api\/v1\/applications\/([^/]+)\/sync$/);
  if (m) {
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    const found = app(decodeURIComponent(m[1]));
    if (!found) return send(res, 404, { error: "application not found" });
    return send(res, 200, found);
  }

  m = pathname.match(/^\/api\/v1\/applications\/([^/]+)$/);
  if (m) {
    const found = app(decodeURIComponent(m[1]));
    return found ? send(res, 200, found) : send(res, 404, { error: "application not found" });
  }

  return send(res, 404, { error: `no demo route for ${pathname}` });
});

server.listen(PORT, HOST, () => {
  const degraded = APPLICATIONS.filter((a) => a.status.health.status === "Degraded").length;
  const drifting = APPLICATIONS.filter((a) => a.status.sync.status === "OutOfSync").length;
  console.log(`demo ArgoCD on http://${HOST}:${PORT}`);
  console.log(
    `${APPLICATIONS.length} applications, ${APPLICATIONSETS.length} ApplicationSets, ${degraded} degraded, ${drifting} drifting`,
  );
  console.log(`add it as: http://${HOST}:${PORT}, auth mode "token", any token value`);
});
