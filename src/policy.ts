import type { Confidence, Severity } from './types.ts';
import { isConfidence, isSeverity } from './types.ts';

export interface LorikeetJsonConfig {
  exclude?: string[];
  languages?: string[];
  minimumSeverity?: Severity;
  minimumConfidence?: Confidence;
}

/**
 * Parses a .loryignore file into glob patterns.
 *
 * Supports:
 * - Empty lines and whitespace
 * - Comments starting with #
 * - Directory patterns ending with /
 * - Root-relative patterns starting with /
 * - Bare names matching anywhere
 */
export function parseLoryIgnore(content: string): string[] {
  const patterns: string[] = [];
  const lines = content.split(/\r?\n/);

  for (let line of lines) {
    line = line.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    // Trailing slash e.g. "dist/" or "build/"
    if (line.endsWith('/')) {
      const base = line.slice(0, -1);
      if (base.startsWith('/')) {
        patterns.push(`${base.slice(1)}/**`);
      } else {
        patterns.push(`**/${base}/**`);
      }
      continue;
    }

    // Leading slash e.g. "/vendor.js"
    if (line.startsWith('/')) {
      patterns.push(line.slice(1));
      continue;
    }

    // If there is no slash in the pattern, match at any depth
    if (!line.includes('/')) {
      patterns.push(`**/${line}`);
    } else {
      patterns.push(line);
    }
  }

  return patterns;
}

/**
 * Parses and validates a .lorikeet.json file.
 */
export function parseLorikeetJson(content: string): LorikeetJsonConfig {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }

    const result: LorikeetJsonConfig = {};

    if (Array.isArray(parsed.exclude)) {
      result.exclude = parsed.exclude.filter((x): x is string => typeof x === 'string');
    }

    if (Array.isArray(parsed.languages)) {
      result.languages = parsed.languages.filter((x): x is string => typeof x === 'string');
    }

    if (isSeverity(parsed.minimumSeverity)) {
      result.minimumSeverity = parsed.minimumSeverity;
    }

    if (isConfidence(parsed.minimumConfidence)) {
      result.minimumConfidence = parsed.minimumConfidence;
    }

    return result;
  } catch {
    return {};
  }
}
