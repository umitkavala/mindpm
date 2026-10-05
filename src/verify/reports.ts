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
  file?: string; // the test file, when the report names it
  groups?: TestGroup[]; // enclosing <testsuite> elements, outermost first
}

// One <testsuite> element. Two elements with the same path (the same describe
// name in two files, say) are different groups.
export interface TestGroup { id: string; path: string[] }

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
// <failure>, <error> or <skipped> child, inside any nesting of <testsuite>.
// Covers surefire, pytest, vitest, jest-junit, the dotnet JUnit logger and
// Node's built-in runner (node --test --test-reporter=junit), which puts
// describe() names only on the enclosing <testsuite>.
export function parseJunit(xml: string, file: string): TestCase[] {
  const cases: TestCase[] = [];
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  const open: TestGroup[] = [];
  let suites = 0;
  const tokens = /<testsuite\b([^>]*?)(\/?)>|<\/testsuite>|<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of body.matchAll(tokens)) {
    if (m[0].startsWith('</')) {
      open.pop();
      continue;
    }
    if (m[0].startsWith('<testsuite')) {
      const name = attrs(m[1]).name ?? '';
      if (!m[2]) open.push({ id: `${file}#${suites}`, path: [...open.map(g => g.path.at(-1)!), name] });
      suites++;
      continue;
    }
    const a = attrs(m[3]);
    if (!a.name) continue;
    const inner = m[5] ?? '';
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
      ...(a.file ? { file: a.file } : {}),
      ...(open.length ? { groups: [...open] } : {}),
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
  | { kind: 'group'; path: string[]; tests: TestCase[] }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: string[] };

const SEPARATOR = /\s+>\s+/;
const endsWith = (path: string[], want: string[]) =>
  path.length >= want.length && want.every((w, i) => path[path.length - want.length + i] === w);

// verify_ref is compared to classname.name first. Otherwise it is a path,
// "group > nested group > test" with outer groups optional, naming either a
// test or a group (a <testsuite> element). More than one candidate is a spec
// error and is never treated as a pass.
export function matchTest(cases: TestCase[], ref: string): Match {
  const want = ref.trim();
  const byId = cases.filter(c => c.id === want);
  if (byId.length === 1) return { kind: 'match', test: byId[0] };
  if (byId.length > 1) return { kind: 'ambiguous', candidates: [...new Set(byId.map(describeTest))] };

  const segments = want.split(SEPARATOR);
  const tests = cases.filter(c => endsWith([...(c.groups?.at(-1)?.path ?? []), c.name], segments));
  const groups = new Map<string, { path: string[]; tests: TestCase[] }>();
  for (const c of cases) {
    for (const g of c.groups ?? []) {
      if (!endsWith(g.path, segments)) continue;
      if (!groups.has(g.id)) groups.set(g.id, { path: g.path, tests: [] });
      groups.get(g.id)!.tests.push(c);
    }
  }
  const count = tests.length + groups.size;
  if (count === 0) return { kind: 'none' };
  if (count > 1) {
    return {
      kind: 'ambiguous',
      candidates: [
        ...describeTests(tests),
        ...[...groups.values()].map(g => `group ${g.path.join(' > ')}${filesOf(g.tests)} (${g.tests[0].report})`),
      ],
    };
  }
  if (tests.length === 1) return { kind: 'match', test: tests[0] };
  const [group] = groups.values();
  return { kind: 'group', path: group.path, tests: group.tests };
}

// By path, which reads well for node:test; by classname.name where two paths
// would read the same.
function describeTests(tests: TestCase[]): string[] {
  const plain = tests.map(describeTest);
  return tests.map((c, i) => (plain.indexOf(plain[i]) !== plain.lastIndexOf(plain[i]) ? `${c.id}${c.file ? ` in ${c.file}` : ''} (${c.report})` : plain[i]));
}

function describeTest(c: TestCase): string {
  const path = [...(c.groups?.at(-1)?.path ?? []), c.name].join(' > ');
  return `${path}${c.file ? ` in ${c.file}` : ''} (${c.report})`;
}

function filesOf(tests: TestCase[]): string {
  const files = [...new Set(tests.map(t => t.file).filter(Boolean))];
  return files.length ? ` in ${files.join(', ')}` : '';
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
