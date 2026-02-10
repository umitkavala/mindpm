import { describe, it, expect } from 'vitest';
import { generateId } from './ids.js';

describe('generateId', () => {
  it('returns an 8-character string', () => {
    expect(generateId()).toHaveLength(8);
  });

  it('returns a valid hex string', () => {
    expect(generateId()).toMatch(/^[0-9a-f]{8}$/);
  });

  it('returns unique values on successive calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});
