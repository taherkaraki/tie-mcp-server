/**
 * Tests for AST evaluation against records (src/query/evaluate.ts).
 *
 * Covers numeric vs string comparison, contains, array membership, bitwise,
 * missing-attribute handling, and the boolean combinators — plus an end-to-end
 * evaluation of the motivating compound expression.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from '../src/query/parser.js';
import { evaluate, type QueryRecord } from '../src/query/evaluate.js';

function matches(expr: string, record: QueryRecord): boolean {
  return evaluate(parseQuery(expr), record);
}

const domainAdmins: QueryRecord = {
  cn: 'Domain Admins',
  samaccountname: 'Domain Admins',
  admincount: 1,
  member: ['CN=dcadmin,CN=Users,DC=alsid,DC=corp', 'CN=Ahmad Acuna,OU=Alsid,DC=alsid,DC=corp'],
  grouptype: 'ACCOUNT_GROUP SECURITY_ENABLED',
  type: 'LDAP',
  directoryid: 1,
};

const normalUser: QueryRecord = {
  cn: 'King Cardona',
  useraccountcontrol: 'NORMAL DONT_EXPIRE NOT_DELEGATED',
  badpwdcount: 10,
  admincount: 0,
  enabled: true,
  type: 'LDAP',
};

test('numeric comparison compares as numbers', () => {
  assert.equal(matches('admincount>0', domainAdmins), true);
  assert.equal(matches('admincount>0', normalUser), false);
  assert.equal(matches('badpwdcount>=10', normalUser), true);
  assert.equal(matches('badpwdcount>10', normalUser), false);
});

test('equality is case-insensitive for strings', () => {
  assert.equal(matches('cn="domain admins"', domainAdmins), true);
  assert.equal(matches('cn="DOMAIN ADMINS"', domainAdmins), true);
});

test('inequality negates equality', () => {
  assert.equal(matches('admincount!=0', domainAdmins), true);
  assert.equal(matches('admincount!=1', domainAdmins), false);
});

test('contains matches substrings, case-insensitively', () => {
  assert.equal(matches('useraccountcontrol:"dont_expire"', normalUser), true);
  assert.equal(matches('useraccountcontrol:"NORMAL"', normalUser), true);
  assert.equal(matches('useraccountcontrol:"DISABLED"', normalUser), false);
});

test('contains matches array membership (any element)', () => {
  assert.equal(matches('member:"dcadmin"', domainAdmins), true);
  assert.equal(matches('member:"nonexistent"', domainAdmins), false);
});

test('boolean attribute equality', () => {
  assert.equal(matches('enabled=true', normalUser), true);
  assert.equal(matches('enabled=false', normalUser), false);
});

test('missing attribute never matches (but NOT surfaces absence)', () => {
  assert.equal(matches('description:"anything"', domainAdmins), false);
  assert.equal(matches('NOT description:"anything"', domainAdmins), true);
});

test('bitwise AND tests bits numerically', () => {
  const rec: QueryRecord = { flags: 6 }; // 0b110
  assert.equal(matches('flags & 2', rec), true); // bit set
  assert.equal(matches('flags & 1', rec), false); // bit clear
});

test('bitwise on a non-numeric attribute never matches', () => {
  // useraccountcontrol is a flag STRING, not a number.
  assert.equal(matches('useraccountcontrol & 2', normalUser), false);
});

test('AND / OR / NOT combine correctly', () => {
  assert.equal(matches('admincount>0 AND type=LDAP', domainAdmins), true);
  assert.equal(matches('admincount>0 AND type=SYSVOL', domainAdmins), false);
  assert.equal(matches('admincount>5 OR type=LDAP', domainAdmins), true);
  assert.equal(matches('NOT admincount>0', normalUser), true);
});

test('compound grouped expression evaluates end-to-end', () => {
  const expr =
    '(admincount>0 AND type=LDAP) OR (useraccountcontrol:"NORMAL" AND badpwdcount=10)';
  assert.equal(matches(expr, domainAdmins), true); // first branch
  assert.equal(matches(expr, normalUser), true); // second branch
  assert.equal(matches(expr, { cn: 'nobody' }), false); // neither
});
