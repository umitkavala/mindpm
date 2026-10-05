import { describe, it, expect } from 'vitest';
import { matchTest, parseJsonReport, parseJunit } from './reports.js';
import { testEvidence } from './run.js';

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="InactivityTimeoutTests" tests="4">
    <testcase classname="InactivityTimeoutTests" name="ClosesAfterThirtyMinutes" time="0.412"/>
    <testcase classname="InactivityTimeoutTests" name="SkipsActiveHandling" time="0.051">
      <failure message="Expected Open, got Closed">stack &amp; trace</failure>
    </testcase>
    <testcase classname="InactivityTimeoutTests" name="Flaky"><skipped/></testcase>
    <!-- <testcase classname="Commented" name="Out"/> -->
    <testcase classname="Other" name="ClosesAfterThirtyMinutes" time="0.1"></testcase>
  </testsuite>
</testsuites>`;

describe('parseJunit', () => {
  it('reads passed, failed and skipped cases with durations and messages', () => {
    const cases = parseJunit(JUNIT, 'reports/junit.xml');
    expect(cases.map(c => [c.id, c.status])).toEqual([
      ['InactivityTimeoutTests.ClosesAfterThirtyMinutes', 'passed'],
      ['InactivityTimeoutTests.SkipsActiveHandling', 'failed'],
      ['InactivityTimeoutTests.Flaky', 'skipped'],
      ['Other.ClosesAfterThirtyMinutes', 'passed'],
    ]);
    expect(cases[0].duration_ms).toBe(412);
    expect(cases[1].message).toBe('Expected Open, got Closed');
  });
});

describe('parseJsonReport', () => {
  it('reads the simple JSON format and rejects anything without a tests array', () => {
    const cases = parseJsonReport(JSON.stringify({ tests: [
      { id: 'InactivityTimeoutTests.ClosesAfterThirtyMinutes', status: 'passed', duration_ms: 412 },
      { id: 'InactivityTimeoutTests.SkipsActiveHandling', status: 'failed', message: 'Expected Open, got Closed' },
      { id: 'bad', status: 'unknown' },
    ] }), 'r.json');
    expect(cases).toHaveLength(2);
    expect(cases[1]).toMatchObject({ name: 'SkipsActiveHandling', status: 'failed' });
    expect(() => parseJsonReport('{}', 'r.json')).toThrow(/tests/);
  });
});

describe('matchTest', () => {
  const cases = parseJunit(JUNIT, 'junit.xml');
  it('matches classname.name first, then name alone', () => {
    expect(matchTest(cases, 'InactivityTimeoutTests.ClosesAfterThirtyMinutes')).toMatchObject({ kind: 'match' });
    expect(matchTest(cases, 'SkipsActiveHandling')).toMatchObject({ kind: 'match', test: { status: 'failed' } });
  });
  it('reports ambiguous and missing matches instead of guessing', () => {
    expect(matchTest(cases, 'ClosesAfterThirtyMinutes')).toEqual({
      kind: 'ambiguous',
      candidates: ['InactivityTimeoutTests.ClosesAfterThirtyMinutes (junit.xml)', 'Other.ClosesAfterThirtyMinutes (junit.xml)'],
    });
    expect(matchTest(cases, 'InactivityTimeoutTests')).toMatchObject({ kind: 'group', tests: expect.any(Array) });
    expect(matchTest(cases, 'Nope')).toEqual({ kind: 'none' });
  });
});

// node --test --test-reporter=junit: every classname is "test" and describe()
// names appear only on the enclosing <testsuite>. Trimmed from a real run.
const NODE_JUNIT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testsuite name="slugify" tests="2" failures="0" skipped="0">
		<testcase name="keeps digits" time="0.0004" classname="test" file="test/a.test.js"/>
		<testsuite name="edges" tests="1" failures="0" skipped="0">
			<testcase name="trims dashes" classname="test" file="test/a.test.js"/>
		</testsuite>
	</testsuite>
	<testsuite name="legacy" tests="1" failures="0" skipped="1">
		<testcase name="old api" classname="test" file="test/a.test.js"><skipped type="skipped" message="true"/></testcase>
	</testsuite>
	<testsuite name="broken" tests="2" failures="1" skipped="0">
		<testcase name="passes" classname="test" file="test/a.test.js"/>
		<testcase name="fails" classname="test" file="test/a.test.js" failure="boom"><failure type="testCodeFailure" message="boom">Error: boom</failure></testcase>
	</testsuite>
	<testcase name="top level" classname="test" file="test/a.test.js"/>
	<testsuite name="shared" tests="1"><testcase name="one" classname="test" file="test/b.test.js"/></testsuite>
	<testsuite name="shared" tests="1"><testcase name="two" classname="test" file="test/c.test.js"/></testsuite>
	<testsuite name="empty" tests="0"/>
	<testcase name="slugify" classname="test" file="test/c.test.js"/>
	<!-- tests 9 -->
</testsuites>`;

describe('test groups (node --test JUnit)', () => {
  const cases = parseJunit(NODE_JUNIT, 'junit.xml');

  it('keeps the enclosing groups of every test', () => {
    expect(cases.find(c => c.name === 'trims dashes')?.groups?.map(g => g.path)).toEqual([['slugify'], ['slugify', 'edges']]);
    expect(cases.find(c => c.name === 'top level')?.groups).toBeUndefined();
    expect(cases).toHaveLength(9);
  });

  it('matches a group by name, with its nested tests', () => {
    const m = matchTest(cases, 'legacy');
    expect(m).toMatchObject({ kind: 'group', path: ['legacy'] });
    const outer = matchTest(cases, 'slugify > edges');
    expect(outer).toMatchObject({ kind: 'group', path: ['slugify', 'edges'] });
  });

  it('matches a nested test by its path, with outer groups optional', () => {
    expect(matchTest(cases, 'slugify > edges > trims dashes')).toMatchObject({ kind: 'match', test: { name: 'trims dashes' } });
    expect(matchTest(cases, 'edges > trims dashes')).toMatchObject({ kind: 'match', test: { name: 'trims dashes' } });
    expect(matchTest(cases, 'trims dashes')).toMatchObject({ kind: 'match', test: { name: 'trims dashes' } });
    expect(matchTest(cases, 'slugify  >  keeps digits')).toMatchObject({ kind: 'match', test: { name: 'keeps digits' } });
    expect(matchTest(cases, 'edges > keeps digits')).toEqual({ kind: 'none' });
  });

  it('passes a group when a test ran and none failed', () => {
    expect(testEvidence('slugify > edges', cases)).toEqual({ result: 'pass', evidence: 'Group slugify > edges: 1 tests passed (report junit.xml).' });
  });

  it('fails a group with a failing test, naming it', () => {
    expect(testEvidence('broken', cases)).toEqual({ result: 'fail', evidence: 'Group broken: 1 of 2 tests failed (fails: boom) (report junit.xml).' });
  });

  it('fails a group whose tests were all skipped', () => {
    expect(testEvidence('legacy', cases)).toMatchObject({ result: 'fail', evidence: expect.stringContaining('all 1 tests were skipped') });
  });

  it('treats a group with no tests as no match', () => {
    expect(testEvidence('empty', cases)).toMatchObject({ result: 'missing' });
  });

  it('refuses a ref that names a group and a test', () => {
    const m = matchTest(cases, 'slugify');
    expect(m).toEqual({ kind: 'ambiguous', candidates: ['slugify in test/c.test.js (junit.xml)', 'group slugify in test/a.test.js (junit.xml)'] });
    expect(testEvidence('slugify', cases)).toMatchObject({ result: 'missing', evidence: expect.stringContaining('matches more than one test') });
  });

  it('refuses a group name used in more than one file', () => {
    expect(matchTest(cases, 'shared')).toEqual({
      kind: 'ambiguous', candidates: ['group shared in test/b.test.js (junit.xml)', 'group shared in test/c.test.js (junit.xml)'],
    });
  });
});
