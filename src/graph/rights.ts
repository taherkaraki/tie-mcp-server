/**
 * Static reference tables for decoding Windows security descriptors (SDDL).
 *
 * These are the small, well-known constants that never change with the forest:
 * SDDL right mnemonics, well-known SIDs/RIDs, and the handful of extended-right
 * and attribute GUIDs that the control-graph edge model keys on. The long tail
 * of forest-specific attribute/class GUIDs is resolved separately from the
 * schema objects already in the store (see schema-map.ts).
 *
 * Nothing here makes a risk judgment — it only names things. Severity is left to
 * the orchestrator / Tenable IOEs.
 */

/**
 * SDDL access-right mnemonics (2-char tokens) mapped to a human label. The
 * `rights` field of an ACE is a concatenation of these (e.g.
 * "CCDCLCSWRPWPDTLOCRSDRCWDWO"); the parser splits it into tokens and this table
 * gives each token meaning.
 */
export const RIGHT_MNEMONICS: Record<string, string> = {
  // Generic
  GA: 'GenericAll',
  GX: 'GenericExecute',
  GW: 'GenericWrite',
  GR: 'GenericRead',
  // Standard
  WO: 'WriteOwner',
  WD: 'WriteDacl',
  RC: 'ReadControl',
  SD: 'Delete',
  // Directory-service specific
  CC: 'CreateChild',
  DC: 'DeleteChild',
  LC: 'ListChildren',
  SW: 'Self', // validated write
  RP: 'ReadProperty',
  WP: 'WriteProperty',
  DT: 'DeleteTree',
  LO: 'ListObject',
  CR: 'ControlAccess', // extended right (see EXTENDED_RIGHTS)
};

/**
 * The concatenated token sequence Windows emits for "full control" on a DS
 * object. Presence of every one of these tokens on an ACE is treated as
 * GenericAll-equivalent even when the literal `GA` token isn't used.
 */
export const FULL_CONTROL_TOKENS = [
  'CC',
  'DC',
  'LC',
  'SW',
  'RP',
  'WP',
  'DT',
  'LO',
  'CR',
  'SD',
  'RC',
  'WD',
  'WO',
] as const;

/** Well-known SIDs that should essentially never hold write/control rights. */
export const BROAD_SIDS: Record<string, string> = {
  'S-1-1-0': 'Everyone',
  'S-1-5-11': 'Authenticated Users',
  'S-1-5-7': 'Anonymous Logon',
  'S-1-5-32-545': 'Users (BUILTIN)',
};

/** The trustee that means "the object itself"; skipped as an edge source. */
export const SELF_SID = 'S-1-5-10';

/** Well-known absolute SIDs (BUILTIN + special) → label. */
export const WELL_KNOWN_SIDS: Record<string, string> = {
  'S-1-5-18': 'Local System',
  'S-1-5-19': 'Local Service',
  'S-1-5-20': 'Network Service',
  'S-1-3-0': 'Creator Owner',
  'S-1-5-9': 'Enterprise Domain Controllers',
  'S-1-5-32-544': 'Administrators (BUILTIN)',
  'S-1-5-32-548': 'Account Operators',
  'S-1-5-32-549': 'Server Operators',
  'S-1-5-32-550': 'Print Operators',
  'S-1-5-32-551': 'Backup Operators',
  'S-1-5-32-554': 'Pre-Windows 2000 Compatible Access',
  'S-1-5-32-560': 'Windows Authorization Access Group',
};

/** Well-known domain RIDs (suffix of a domain SID) → label. */
export const WELL_KNOWN_RIDS: Record<string, string> = {
  '500': 'Administrator',
  '502': 'krbtgt',
  '512': 'Domain Admins',
  '513': 'Domain Users',
  '515': 'Domain Computers',
  '516': 'Domain Controllers',
  '518': 'Schema Admins',
  '519': 'Enterprise Admins',
  '520': 'Group Policy Creator Owners',
  '498': 'Enterprise Read-only Domain Controllers',
  '521': 'Read-only Domain Controllers',
};

/**
 * Extended-right / attribute / property-set GUIDs the edge model keys on. Object
 * ACEs (OA/OD) carry one of these in their objectType field; combined with the
 * right token it determines the edge kind. Lower-cased for case-insensitive
 * matching against SDDL (which may use either case).
 */
export const EXTENDED_RIGHTS = {
  /** User-Force-Change-Password (CR) → ForceChangePassword edge. */
  forceChangePassword: '00299570-246d-11d0-a768-00aa006e0529',
  /** DS-Replication-Get-Changes (CR). */
  dsReplGetChanges: '1131f6aa-9c07-11d1-f79f-00c04fc2dcd2',
  /** DS-Replication-Get-Changes-All (CR) — both required for DCSync. */
  dsReplGetChangesAll: '1131f6ad-9c07-11d1-f79f-00c04fc2dcd2',
  /** `member` attribute — WP here → AddMember (not generic write). */
  memberAttribute: 'bf9679c0-0de6-11d0-a285-00aa003049e2',
  /** msDS-KeyCredentialLink — WP here → AddKeyCredentialLink (shadow creds). */
  keyCredentialLink: '5b47d60f-6090-40b2-9f37-2a4de88f3063',
} as const;

/** Reverse lookup: GUID (lower-case) → friendly name, for human-readable decode. */
export const KNOWN_GUID_NAMES: Record<string, string> = {
  '00299570-246d-11d0-a768-00aa006e0529': 'User-Force-Change-Password',
  '1131f6aa-9c07-11d1-f79f-00c04fc2dcd2': 'DS-Replication-Get-Changes',
  '1131f6ad-9c07-11d1-f79f-00c04fc2dcd2': 'DS-Replication-Get-Changes-All',
  'bf9679c0-0de6-11d0-a285-00aa003049e2': 'member',
  '5b47d60f-6090-40b2-9f37-2a4de88f3063': 'msDS-KeyCredentialLink',
};

/** True if `sid` is a broad/low-privileged well-known principal. */
export function isBroadSid(sid: string): boolean {
  return sid in BROAD_SIDS;
}

/** Resolve a bare SID to a well-known label (broad SIDs and RIDs), else null. */
export function wellKnownSidLabel(sid: string): string | null {
  if (sid in BROAD_SIDS) return BROAD_SIDS[sid];
  if (sid in WELL_KNOWN_SIDS) return WELL_KNOWN_SIDS[sid];
  const rid = sid.slice(sid.lastIndexOf('-') + 1);
  if (sid.startsWith('S-1-5-21-') && rid in WELL_KNOWN_RIDS) {
    return WELL_KNOWN_RIDS[rid];
  }
  return null;
}

/** Split a concatenated SDDL rights string into 2-char mnemonic tokens. */
export function splitRightTokens(rights: string): string[] {
  if (!rights || rights.startsWith('0x')) return [];
  const tokens: string[] = [];
  for (let i = 0; i + 1 < rights.length; i += 2) {
    tokens.push(rights.slice(i, i + 2));
  }
  return tokens;
}

/** True if the token set includes GenericAll or the full-control sequence. */
export function isFullControl(tokens: string[]): boolean {
  if (tokens.includes('GA')) return true;
  const set = new Set(tokens);
  return FULL_CONTROL_TOKENS.every((t) => set.has(t));
}
