import { expect, it } from 'vite-plus/test';
import { createAttemptLimiter, loginWindowMs } from './loginThrottle.ts';

it('expires windows without letting rejected requests extend them', () => {
  const take = createAttemptLimiter(2);
  expect(take('a', 100)).toBe(0);
  expect(take('a', 101)).toBe(0);
  expect(take('a', 200)).toBe(loginWindowMs - 100);
  expect(take('a', 100 + loginWindowMs)).toBe(0);
});

it('fails closed at capacity and reclaims expired entries without evicting active limits', () => {
  const take = createAttemptLimiter(1, 2);
  expect(take('a', 0)).toBe(0);
  expect(take('b', 0)).toBe(0);
  expect(take('c', 1)).toBe(loginWindowMs);
  expect(take('a', 1)).toBe(loginWindowMs - 1);
  expect(take('c', loginWindowMs)).toBe(0);
});
