/** The wire contract with `/ptaas/ajax/lory-code-review.php`. */

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/** One security defect, anchored to a line in the reviewed file. */
export interface Finding {
  /** 1-based, absolute in the file (the server echoes back the window offset). */
  line: number;
  /** Last line of a multi-line defect. Absent when the defect is one line. */
  end_line?: number;
  severity: Severity;
  title: string;
  detail: string;
  confidence: Confidence;
  /** `CWE-89` form. Absent unless the mapping is certain. */
  cwe?: string;
  /** Replacement source for `line`..`end_line`. Code only. */
  fix?: string;
  /** Short rationale for the fix. */
  fix_note?: string;
}

export interface ReviewMeta {
  start_line: number;
  end_line: number;
  model: string;
  /** Which rate-limit tier served the request: `anonymous` or `token`. */
  tier?: string;
}

export interface ReviewResult {
  findings: Finding[];
  summary: string;
  meta?: ReviewMeta;
}

export interface ReviewRequest {
  code: string;
  language?: string;
  filename?: string;
  /** Line number of the first line of `code` within the whole file. */
  start_line?: number;
  stream?: boolean;
}

/** Rank for comparisons. Lower is worse. */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export const CONFIDENCE_RANK: Record<Confidence, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

export function isConfidence(value: unknown): value is Confidence {
  return typeof value === 'string' && (CONFIDENCES as readonly string[]).includes(value);
}

/**
 * Coerce an untrusted object into a Finding, or reject it.
 *
 * The server already validates, but the extension must not trust the network:
 * a proxy, a stale server, or a misconfigured `lory.baseUrl` can all put an
 * unexpected shape on the wire, and a bad `line` would land a security marker
 * on innocent code.
 */
export function parseFinding(raw: unknown): Finding | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const o = raw as Record<string, unknown>;

  const line = Number(o['line']);
  if (!Number.isInteger(line) || line < 1) {
    return null;
  }

  const title = typeof o['title'] === 'string' ? o['title'].trim() : '';
  if (title === '') {
    return null;
  }

  const finding: Finding = {
    line,
    severity: isSeverity(o['severity']) ? o['severity'] : 'medium',
    title,
    detail: typeof o['detail'] === 'string' ? o['detail'].trim() : '',
    confidence: isConfidence(o['confidence']) ? o['confidence'] : 'medium',
  };

  const endLine = Number(o['end_line']);
  if (Number.isInteger(endLine) && endLine > line) {
    finding.end_line = endLine;
  }

  if (typeof o['cwe'] === 'string' && /^CWE-\d{1,4}$/i.test(o['cwe'])) {
    finding.cwe = o['cwe'].toUpperCase();
  }
  if (typeof o['fix'] === 'string' && o['fix'] !== '') {
    finding.fix = o['fix'];
  }
  if (typeof o['fix_note'] === 'string' && o['fix_note'].trim() !== '') {
    finding.fix_note = o['fix_note'].trim();
  }

  return finding;
}
