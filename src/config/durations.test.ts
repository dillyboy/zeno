import { expect, it } from 'vite-plus/test';
import { positiveDuration } from './durations.ts';

it('accepts positive integer durations and falls back for invalid values', () => {
  expect(positiveDuration('840000', 900000)).toBe(840000);
  for (const value of [undefined, '', '0', '-1', '1.5', 'NaN', 'Infinity', '2147483648']) {
    expect(positiveDuration(value, 900000)).toBe(900000);
  }
});
