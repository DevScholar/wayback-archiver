import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cdxjTsToRfc3339, rfc3339ToTs14 } from '../src/lib/time.js';

test('cdxjTsToRfc3339 with milliseconds', () => {
    assert.equal(cdxjTsToRfc3339('20260831074847556'), '2026-08-31T07:48:47.556Z');
});

test('cdxjTsToRfc3339 without milliseconds', () => {
    assert.equal(cdxjTsToRfc3339('20260831074847'), '2026-08-31T07:48:47Z');
});

test('rfc3339ToTs14 extracts leading 14 digits', () => {
    assert.equal(rfc3339ToTs14('2026-08-31T07:48:47.556Z'), '20260831074847');
});
