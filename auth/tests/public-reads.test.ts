import { describe, it, expect } from 'vitest';
import { PublicReadLimiter } from '../src/publicReads.js';

describe('public read abuse boundary', () => {
  it('limits one caller, preserves other callers, and expires the window', () => {
    const limiter = new PublicReadLimiter(2, 2);
    expect(limiter.take('192.0.2.1', 0)).toBe(true);
    expect(limiter.take('192.0.2.1', 0)).toBe(true);
    expect(limiter.take('192.0.2.1', 1)).toBe(false);
    expect(limiter.take('192.0.2.2', 1)).toBe(true);
    expect(limiter.take('192.0.2.3', 1)).toBe(false);
    expect(limiter.take('192.0.2.1', 60_000)).toBe(true);
    expect(limiter.retryAfter(60_001)).toBe(60);
  });
});
