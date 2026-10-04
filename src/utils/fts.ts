import type Database from 'better-sqlite3';

// True when the FTS5 virtual tables exist (created by setupFts). When false,
// callers fall back to LIKE scans or skip ranking.
export function ftsReady(db: Database.Database): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks_fts'").get();
  } catch {
    return false;
  }
}

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// Turn a free-text query into an FTS5 MATCH expression: each alphanumeric token
// becomes a prefix term, combined with implicit AND. Returns null when the query
// has no usable tokens (caller then falls back to LIKE).
export function buildFtsMatch(query: string): string | null {
  const t = tokens(query);
  if (t.length === 0) return null;
  return t.map((x) => `"${x}"*`).join(' ');
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were', 'not', 'but', 'its',
  'has', 'have', 'had', 'will', 'can', 'all', 'any', 'per', 'via', 'use', 'when', 'than', 'then', 'there',
  'their', 'they', 'them', 'our', 'out', 'who', 'what', 'which', 'why', 'how', 'should', 'would', 'could',
]);

// Relevance query over long free text (a spec, a task description): every
// distinct token is quoted, so quotes, hyphens, colons and FTS keywords such
// as AND/OR/NEAR are inert, then OR-ed so any overlap ranks. bm25 does the
// weighting. Returns null when nothing usable remains.
export function buildFtsAnyMatch(text: string, maxTerms = 40): string | null {
  const seen = new Set<string>();
  for (const t of tokens(text)) {
    if (t.length < 3 || STOPWORDS.has(t)) continue;
    seen.add(t);
    if (seen.size >= maxTerms) break;
  }
  if (seen.size === 0) return null;
  return [...seen].map((t) => `"${t}"`).join(' OR ');
}
