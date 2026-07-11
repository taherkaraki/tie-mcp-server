/**
 * Tests for credential-weakness derivation (src/graph/credentials.ts): objectclass
 * detection, synthetic-object filtering, isweak parsing, and the OR-across-
 * profiles derivation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasObjectClass,
  isSyntheticObject,
  parseIsWeak,
  credentialFactsFrom,
  reuseClusterFrom,
} from '../src/graph/credentials.js';

test('hasObjectClass matches array and string forms', () => {
  assert.equal(hasObjectClass({ objectclass: ['top', 'passwordHashScan'] }, 'passwordHashScan'), true);
  assert.equal(hasObjectClass({ objectclass: 'passwordHashScan' }, 'passwordHashScan'), true);
  assert.equal(hasObjectClass({ objectclass: ['top', 'user'] }, 'passwordHashScan'), false);
});

test('isSyntheticObject flags scan and reuse objects only', () => {
  assert.equal(isSyntheticObject({ objectclass: ['passwordHashScan'] }), true);
  assert.equal(isSyntheticObject({ objectclass: ['passwordHashReuse'] }), true);
  assert.equal(isSyntheticObject({ objectclass: ['top', 'person', 'user'] }), false);
  assert.equal(isSyntheticObject({ objectclass: ['top', 'group'] }), false);
});

test('parseIsWeak parses the profile-keyed map (string or object)', () => {
  assert.deepEqual(parseIsWeak('{"1":false,"2":true,"6":false,"8":false}'), {
    '1': false, '2': true, '6': false, '8': false,
  });
  assert.deepEqual(parseIsWeak({ '1': true }), { '1': true });
  assert.deepEqual(parseIsWeak('not json'), {});
  assert.deepEqual(parseIsWeak(undefined), {});
});

test('credentialFactsFrom OR-s isweak across profiles', () => {
  // Weak under profile 2 only -> isweak true.
  const f1 = credentialFactsFrom({
    isbreached: false,
    isweak: '{"1":false,"2":true,"6":false,"8":false}',
  });
  assert.equal(f1.isweak, true);
  assert.deepEqual(f1.isweakByProfile, { '1': false, '2': true, '6': false, '8': false });
  assert.equal(f1.isbreached, false);

  // Weak under no profile -> isweak false.
  const f2 = credentialFactsFrom({ isweak: '{"1":false,"2":false}' });
  assert.equal(f2.isweak, false);

  // Weak under all -> true.
  const f3 = credentialFactsFrom({ isweak: '{"1":true,"2":true,"6":true,"8":true}' });
  assert.equal(f3.isweak, true);
});

test('credentialFactsFrom passes through blank/breached booleans', () => {
  const f = credentialFactsFrom({ isbreached: true, islmblank: true, isntblank: false });
  assert.equal(f.isbreached, true);
  assert.equal(f.islmblank, true);
  assert.equal(f.isntblank, false);
});

test('credentialFactsFrom omits isweak when the map is empty/absent', () => {
  const f = credentialFactsFrom({ isbreached: true });
  assert.equal(f.isweak, undefined);
  assert.equal(f.isweakByProfile, undefined);
});

test('reuseClusterFrom parses members from reusedwithindomain', () => {
  const c = reuseClusterFrom({
    objectclass: ['passwordHashReuse'],
    prefix: '31D6C',
    reusedwithindomain: '{"1":["AAA-1","bbb-2","CCC-3"]}',
  });
  assert.ok(c);
  assert.equal(c!.prefix, '31D6C');
  assert.deepEqual(c!.memberGuids, ['aaa-1', 'bbb-2', 'ccc-3']); // lower-cased
});

test('reuseClusterFrom flattens multiple buckets and rejects non-clusters', () => {
  const multi = reuseClusterFrom({
    objectclass: ['passwordHashReuse'],
    reusedwithindomain: { '1': ['a'], '2': ['b', 'c'] },
  });
  assert.deepEqual(multi!.memberGuids.sort(), ['a', 'b', 'c']);

  assert.equal(reuseClusterFrom({ objectclass: ['user'] }), null); // not a cluster
  assert.equal(
    reuseClusterFrom({ objectclass: ['passwordHashReuse'], reusedwithindomain: '{}' }),
    null // no members
  );
});
