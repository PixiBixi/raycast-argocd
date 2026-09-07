# Changelog

## Unreleased

Initial version.

- Search Applications across every configured ArgoCD instance at once, or one of them, with a
  scope dropdown that survives a relaunch.
- A per-instance on-disk cache of the projected application list, read before any network call,
  so the first paint costs nothing and the refresh happens behind it.
- A capped, self-ranked result list: exact, prefix and substring matches on the name outrank a
  match anywhere else, multi-word queries are AND, and an empty query shows recently opened
  applications, then whatever is degraded or out of sync.
- An unauthenticated reachability probe per instance, so a VPN that is down is reported in under
  a second instead of after every request has timed out.
- Search ApplicationSets, with a rollup of the applications each one generated and a jump to
  them. The link is the ownerReference the ApplicationSet controller stamps on each application,
  so the filtered list is a local operation.
- An application detail view with sync and health, source and destination, conditions, images and
  the last sync result, plus normal and hard refresh.
- A sync form covering revision, prune, dry run, apply-only, force, replace, server-side apply,
  prune last, schema validation and retry, and a live status view that follows a running sync.
- Two authentication modes: the session the `argocd` CLI already holds from `argocd login --sso`,
  and an API token stored in the macOS keychain.
- Write operations off by default, impossible to enable on a production instance, and refused by
  the client independently of the UI hiding the action.
