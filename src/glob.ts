/**
 * Minimal glob matching for `lory.exclude`.
 *
 * VS Code's own matcher is only reachable through `workspace.findFiles`, which
 * searches the workspace. Exclusion is checked on every keystroke against a
 * single known path, so this stays local, synchronous, and allocation-light.
 *
 * Supports the subset the exclude patterns actually use: `**`, `*`, `?`, and
 * brace-free literals. Deliberately not a full glob implementation.
 */

const cache = new Map<string, RegExp>();

export function matchGlob(pattern: string, path: string): boolean {
  return toRegExp(pattern).test(path.replace(/\\/g, '/'));
}

/** True when any pattern matches either path form. */
export function matchesAny(patterns: string[], ...paths: string[]): boolean {
  return patterns.some((pattern) => paths.some((path) => matchGlob(pattern, path)));
}

function toRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) {
    return cached;
  }

  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;

    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` spans zero or more segments, so `**/x.js` matches a bare `x.js`
        // as well as `a/b/x.js`. Without the optional group, excluding
        // `**/node_modules/**` would miss a top-level `node_modules`.
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]*\\/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }

    if (ch === '?') {
      out += '[^/]';
      continue;
    }

    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  const regex = new RegExp(`^${out}$`);
  cache.set(pattern, regex);
  return regex;
}
