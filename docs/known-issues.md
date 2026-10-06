# Known issues

Deliberate decisions, recorded so they are not rediscovered as new bugs.

## `source-map-js` high-severity advisory — accepted, dev-only

`npm audit` reports a high-severity advisory for `source-map-js@1.2.1`
(GHSA-68fv-2mgg-jv7q, event-loop denial of service through indexed source-map
section offsets).

It is reachable only through the test toolchain:

    atlas → vitest → vite → postcss → source-map-js

It is not in `dependencies`, and `npm pack --dry-run` shows it does not appear
in the published tarball. Nobody who installs Atlas receives it.

**Accepted as-is.** `npm audit fix` offers no concrete upgrade path, which
means the version is pinned transitively by vite rather than directly
resolvable. Force-resolving it would mean an override that could break vitest,
in exchange for fixing an advisory that cannot reach a user.

Revisit when vite moves off this version. If it must be resolved sooner, the
change is a single `overrides` entry followed by a full test run.
