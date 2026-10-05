// Test report parsing for `mindpm verify`: JUnit XML and the simple JSON
// format from the Phase 2 doc. A criterion passes only on positive evidence,
// so anything unparseable yields no cases rather than a guess.

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface TestCase {
  id: string; // classname.name, or name alone when there is no classname
  name: string;
  status: TestStatus;
  duration_ms?: number;
  message?: string;
  report: string; // the report file it came from
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[3] ?? m[4] ?? '');
  return out;
}

// Tolerant JUnit reader: <testcase classname name time> with an optional
// <failure>, <error> or <skipped> child. Covers surefire, pytest, vitest,
// jest-junit and the dotnet JUnit logger.
export function parseJunit(xml: string, file: string): TestCase[] {
  const cases: TestCase[] = [];
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of body.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = attrs(m[1]);
    if (!a.name) continue;
    const inner = m[3] ?? '';
    let status: TestStatus = 'passed';
    let message: string | undefined;
    const fail = inner.match(/<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/);
    if (fail) {
      status = 'failed';
      const fa = attrs(fail[2]);
      message = (fa.message || decode((fail[4] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '')).trim()).slice(0, 500) || undefined;
    } else if (/<skipped\b/.test(inner)) {
      status = 'skipped';
    }
    const seconds = a.time ? parseFloat(a.time) : NaN;
    cases.push({
      id: a.classname ? `${a.classname}.${a.name}` : a.name,
      name: a.name,
      status,
      ...(Number.isFinite(seconds) ? { duration_ms: Math.round(seconds * 1000) } : {}),
      ...(message ? { message } : {}),
      report: file,
    });
  }
  return cases;
}

// { "tests": [{ "id", "status": passed|failed|skipped, "duration_ms"?, "message"? }] }
export function parseJsonReport(text: string, file: string): TestCase[] {
  const data = JSON.parse(text) as { tests?: unknown };
  if (!data || !Array.isArray(data.tests)) throw new Error('JSON report has no "tests" array');
  return data.tests.flatMap((t: any): TestCase[] => {
    if (!t || typeof t.id !== 'string' || !['passed', 'failed', 'skipped'].includes(t.status)) return [];
    const dot = t.id.lastIndexOf('.');
    return [{
      id: t.id,
      name: dot === -1 ? t.id : t.id.slice(dot + 1),
      status: t.status,
      ...(typeof t.duration_ms === 'number' ? { duration_ms: t.duration_ms } : {}),
      ...(typeof t.message === 'string' ? { message: t.message.slice(0, 500) } : {}),
      report: file,
    }];
  });
}

export type Match =
  | { kind: 'match'; test: TestCase }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: string[] };

// verify_ref is compared to classname.name, then to name alone. More than one
// match is a spec error and is never treated as a pass.
export function matchTest(cases: TestCase[], ref: string): Match {
  const want = ref.trim();
  let found = cases.filter(c => c.id === want);
  if (found.length === 0) found = cases.filter(c => c.name === want);
  if (found.length === 0) return { kind: 'none' };
  const ids = [...new Set(found.map(c => `${c.id} (${c.report})`))];
  if (found.length > 1) return { kind: 'ambiguous', candidates: ids };
  return { kind: 'match', test: found[0] };
}

export function summarize(cases: TestCase[], file: string, format: string) {
  const count = (s: TestStatus) => cases.filter(c => c.status === s).length;
  return {
    path: file,
    format,
    total: cases.length,
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped'),
    failing: cases.filter(c => c.status === 'failed').slice(0, 20).map(c => c.id),
  };
}
