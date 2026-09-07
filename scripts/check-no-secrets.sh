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

tracked() {
  git ls-files -- "$@"
}

# Files that legitimately carry URLs: the documentation of the design, the lock file, and
# this script.
readonly SCAN_PATHS=('src' 'tests' 'scripts' 'package.json' 'README.md' 'CHANGELOG.md' '.github')

# 1. Credentials by shape. A JWT header always starts with the base64url of {"alg": and a
#    bearer token in source is never legitimate here: every token in this codebase comes
#    from the keychain or the argocd CLI at runtime.
if hits=$(tracked "${SCAN_PATHS[@]}" | xargs -r grep -nE 'eyJ[A-Za-z0-9_-]{10,}' 2>/dev/null | grep -v 'check-no-secrets.sh'); then
  report "a JSON Web Token literal is present in the tree" "$hits"
fi

if hits=$(tracked "${SCAN_PATHS[@]}" | xargs -r grep -nEi 'authorization["'"'"']?\s*[:=]\s*["'"'"']bearer [A-Za-z0-9._-]{8,}' 2>/dev/null | grep -v 'check-no-secrets.sh'); then
  report "a hardcoded bearer credential is present in the tree" "$hits"
fi

# 2. Kubernetes context names. A GKE context embeds the project, the region and the cluster
#    name, which is exactly the topology this repository must not publish.
if hits=$(tracked "${SCAN_PATHS[@]}" | xargs -r grep -nE '\bgke_[a-z0-9-]+_' 2>/dev/null | grep -v 'check-no-secrets.sh'); then
  report "a GKE context name is present in the tree" "$hits"
fi

# 3. Hostnames. Only example hosts, loopback and a short allowlist of public services may
#    appear. `.internal.` and `.local.` are called out separately because they are the
#    shape a private cluster endpoint takes.
allowed_host='(([A-Za-z0-9-]+\.)*example\.(com|org|dev|net)|localhost|127\.0\.0\.1|argo-cd\.readthedocs\.io|developers\.raycast\.com|www\.raycast\.com|json\.schemastore\.org|github\.com|raw\.githubusercontent\.com|nodejs\.org|argoproj\.github\.io|kubernetes\.default\.svc)'
if hits=$(tracked "${SCAN_PATHS[@]}" | xargs -r grep -nEo 'https?://[A-Za-z0-9._-]+' 2>/dev/null | grep -vE "https?://${allowed_host}" | grep -v 'check-no-secrets.sh'); then
  report "a URL points at a host that is neither an example nor an allowlisted public service" "$hits"
fi

if hits=$(tracked "${SCAN_PATHS[@]}" | xargs -r grep -nE '[a-z0-9-]+\.(internal|local)\.[a-z]' 2>/dev/null | grep -v 'check-no-secrets.sh'); then
  report "an internal hostname is present in the tree" "$hits"
fi

# 4. Email addresses other than the maintainer's noreply address.
if hits=$(tracked "${SCAN_PATHS[@]}" | xargs -r grep -nEo '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' 2>/dev/null | grep -vE '@(users\.noreply\.github\.com|example\.com)' | grep -v 'check-no-secrets.sh'); then
  report "an email address that is not a noreply or example address is present in the tree" "$hits"
fi

if [ "$fail" -eq 0 ]; then
  echo "No cluster identity or credential found in the tracked tree."
fi

exit "$fail"
