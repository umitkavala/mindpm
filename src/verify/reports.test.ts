import { describe, it, expect } from 'vitest';
import { matchTest, parseJsonReport, parseJunit } from './reports.js';

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
    expect(matchTest(cases, 'ClosesAfterThirtyMinutes')).toMatchObject({ kind: 'ambiguous', candidates: expect.any(Array) });
    expect(matchTest(cases, 'Nope')).toEqual({ kind: 'none' });
  });
});
