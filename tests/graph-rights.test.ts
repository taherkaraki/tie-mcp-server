/**
 * Tests for SDDL reference helpers (src/graph/rights.ts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBroadSid,
  wellKnownSidLabel,
  splitRightTokens,
  isFullControl,
} from '../src/graph/rights.js';

test('isBroadSid flags Everyone / Authenticated Users / Anonymous', () => {
  assert.equal(isBroadSid('S-1-1-0'), true);
  assert.equal(isBroadSid('S-1-5-11'), true);
  assert.equal(isBroadSid('S-1-5-7'), true);
  assert.equal(isBroadSid('S-1-5-21-1-2-3-512'), false);
});

test('wellKnownSidLabel resolves broad SIDs and domain RIDs', () => {
  assert.equal(wellKnownSidLabel('S-1-1-0'), 'Everyone');
  assert.equal(wellKnownSidLabel('S-1-5-21-4171925040-3086021684-4078780126-512'), 'Domain Admins');
  assert.equal(wellKnownSidLabel('S-1-5-21-4171925040-3086021684-4078780126-519'), 'Enterprise Admins');
  assert.equal(wellKnownSidLabel('S-1-5-21-1-2-3-1234'), null); // ordinary RID
});

test('splitRightTokens chunks into 2-char mnemonics, ignores hex', () => {
  assert.deepEqual(splitRightTokens('RPWP'), ['RP', 'WP']);
  assert.deepEqual(splitRightTokens('0x100'), []);
  assert.deepEqual(splitRightTokens(''), []);
});

test('isFullControl detects GA or the full combined sequence', () => {
  assert.equal(isFullControl(['GA']), true);
  assert.equal(
    isFullControl(splitRightTokens('CCDCLCSWRPWPDTLOCRSDRCWDWO')),
    true
  );
  assert.equal(isFullControl(['RP', 'WP']), false);
});
