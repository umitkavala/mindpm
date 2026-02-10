import { describe, it, expect } from 'vitest';
import { buildWhereClause, buildTagFilter } from './filters.js';

describe('buildWhereClause', () => {
  it('returns empty string for empty filters', () => {
    const result = buildWhereClause({});
    expect(result.where).toBe('');
    expect(result.params).toEqual({});
  });

  it('returns empty string when all values are undefined', () => {
    const result = buildWhereClause({ a: undefined, b: undefined });
    expect(result.where).toBe('');
    expect(result.params).toEqual({});
  });

  it('returns empty string when all values are null', () => {
    const result = buildWhereClause({ a: null, b: null });
    expect(result.where).toBe('');
    expect(result.params).toEqual({});
  });

  it('builds single condition', () => {
    const result = buildWhereClause({ status: 'active' });
    expect(result.where).toBe('WHERE status = @status');
    expect(result.params).toEqual({ status: 'active' });
  });

  it('builds multiple conditions with AND', () => {
    const result = buildWhereClause({ status: 'active', priority: 'high' });
    expect(result.where).toBe('WHERE status = @status AND priority = @priority');
    expect(result.params).toEqual({ status: 'active', priority: 'high' });
  });

  it('uses columnMap to remap keys', () => {
    const result = buildWhereClause({ projectId: 'abc' }, { projectId: 'project_id' });
    expect(result.where).toBe('WHERE project_id = @projectId');
    expect(result.params).toEqual({ projectId: 'abc' });
  });

  it('skips undefined but keeps other filters', () => {
    const result = buildWhereClause({ status: 'active', priority: undefined, name: 'test' });
    expect(result.where).toBe('WHERE status = @status AND name = @name');
    expect(result.params).toEqual({ status: 'active', name: 'test' });
  });
});

describe('buildTagFilter', () => {
  it('produces correct LIKE pattern with default column', () => {
    const result = buildTagFilter('backend');
    expect(result).toBe(`(tags LIKE '%"' || @tag || '"%')`);
  });

  it('accepts custom column name', () => {
    const result = buildTagFilter('backend', 'my_tags');
    expect(result).toBe(`(my_tags LIKE '%"' || @tag || '"%')`);
  });
});
