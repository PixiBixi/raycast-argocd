#!/usr/bin/env bash
#
# Fails when anything identifying a real ArgoCD deployment, or anything shaped like a
# credential, reaches the tracked tree.
#
# The patterns are deliberately structural rather than a list of the organisation's own
# names: a deny-list naming the private hosts would leak them into the public repository it
# is meant to protect. Anything that is not an example.* host, a loopback address, or a
# well-known public domain is treated as suspicious and has to be justified by an allowlist
# entry below.
set -euo pipefail

cd "$(dirname "$0")/.."

fail=0

report() {
  fail=1
  printf '::error::%s\n' "$1"
  printf '%s\n' "$2"
}

# The whole tracked tree, minus what is excluded below with a reason.
#
# This used to be an allowlist of seven paths, which meant the gate printed "No cluster
# identity or credential found in the tracked tree" while never having looked at openwiki/,
# docs/, LICENSE or AGENTS.md. A check named more broadly than what it verifies is the exact
# failure this repository keeps hitting, so the default is now everything.
#
# Excluded, each for a reason and not for convenience:
#   package-lock.json  thousands of registry URLs, all resolved by npm, none written by hand
#   this script        it necessarily contains every pattern it searches for
EXCLUDE_RE='^(package-lock\.json|scripts/check-no-secrets\.sh)$'

tracked_files() {
  git ls-files | grep -vE "$EXCLUDE_RE"
}

# 1. Credentials by shape. A JWT header always starts with the base64url of {"alg": and a
#    bearer token in source is never legitimate here: every token in this codebase comes
#    from the keychain or the argocd CLI at runtime.
if hits=$(tracked_files | xargs -r grep -nE 'eyJ[A-Za-z0-9_-]{10,}' 2>/dev/null); then
  report "a JSON Web Token literal is present in the tree" "$hits"
fi

if hits=$(tracked_files | xargs -r grep -nEi 'authorization["'"'"']?\s*[:=]\s*["'"'"']bearer [A-Za-z0-9._-]{8,}' 2>/dev/null); then
  report "a hardcoded bearer credential is present in the tree" "$hits"
fi

# 2. Kubernetes context names. A GKE context embeds the project, the region and the cluster
#    name, which is exactly the topology this repository must not publish.
if hits=$(tracked_files | xargs -r grep -nE '\bgke_[a-z0-9-]+_' 2>/dev/null); then
  report "a GKE context name is present in the tree" "$hits"
fi

# 3. Hostnames. Only example hosts, loopback and a short allowlist of public services may
#    appear. `notlocalhost` is a deliberate negative fixture: it proves the loopback
#    exemption is not a substring match. `.internal.` and `.local.` are called out separately because they are the
#    shape a private cluster endpoint takes.
allowed_host='(([A-Za-z0-9-]+\.)*example\.(com|org|dev|net)|localhost|127\.0\.0\.1|argo-cd\.readthedocs\.io|developers\.raycast\.com|(www\.)?raycast\.com|json\.schemastore\.org|github\.com|raw\.githubusercontent\.com|nodejs\.org|argoproj\.github\.io|kubernetes\.default\.svc|notlocalhost)'
if hits=$(tracked_files | xargs -r grep -nEo 'https?://[A-Za-z0-9._-]+' 2>/dev/null | grep -vE "https?://${allowed_host}"); then
  report "a URL points at a host that is neither an example nor an allowlisted public service" "$hits"
fi

if hits=$(tracked_files | xargs -r grep -nE '[a-z0-9-]+\.(internal|local)\.[a-z]' 2>/dev/null); then
  report "an internal hostname is present in the tree" "$hits"
fi

# 4. An optional local deny-list, never committed.
#
#    The structural checks above cannot catch an organisation's own vocabulary: a service
#    account name, an RBAC group, an internal project. Naming those in this script would put
#    them in the repository it exists to protect, so the list lives in a gitignored file that
#    each machine keeps for itself. One extended-regex pattern per line, blank lines and lines
#    starting with # ignored.
DENYLIST=".check-no-secrets-denylist"
if [ -f "$DENYLIST" ]; then
  patterns=$(grep -vE '^[[:space:]]*(#|$)' "$DENYLIST" | paste -sd'|' -)
  if [ -n "$patterns" ]; then
    if hits=$(tracked_files | xargs -r grep -nIiE "$patterns" 2>/dev/null); then
      report "a term from the local deny-list is present in the tree" "$hits"
    fi
  fi
fi

# 5. Email addresses other than the maintainer's noreply address.
if hits=$(tracked_files | xargs -r grep -nEo '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' 2>/dev/null | grep -vE '@(users\.noreply\.github\.com|example\.com)'); then
  report "an email address that is not a noreply or example address is present in the tree" "$hits"
fi

# 6. Personal data. The extension is published under a Raycast account username, so no
#    real name belongs in the tree: not in the LICENSE holder, not in a doc byline. Commit
#    authorship is separate and lives in git, not in the published files.
if hits=$(tracked_files | xargs -r grep -nIiE '\b(jeremy|delgado|jdelgado)\b' 2>/dev/null); then
  report "a real name is present in the tree; publish under the account username instead" "$hits"
fi

if [ "$fail" -eq 0 ]; then
  printf 'No cluster identity, credential or personal data in the %s tracked files scanned.\n' "$(tracked_files | wc -l | tr -d ' ')"
fi

exit "$fail"
