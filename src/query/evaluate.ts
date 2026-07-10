/**
 * Evaluate a parsed query AST against a single ad-object record.
 *
 * A record here is a flat map of attribute-name -> NormalizedValue (see
 * value.ts), already lower-cased on the keys by the store. Field lookups in the
 * query are case-insensitive to match.
 *
 * Semantics (agreed model — string comparisons, array/missing-aware):
 * - Missing attribute: every comparison is false (so NOT can surface absence,
 *   e.g. `NOT description:"admin"` is true when there is no description).
 * - Multi-valued attributes: a comparison holds if it holds for ANY element
 *   (existential). So `member:"dcadmin"` matches when any member contains it.
 * - `=`/`!=`: numeric when both sides are numbers, else case-insensitive string
 *   equality. `!=` is the strict negation of `=` (and stays false on a missing
 *   attribute, matching the "missing => false" rule).
 * - `>` `>=` `<` `<=`: numeric when both numeric, else lexical (case-insensitive).
 * - `:` contains: substring (case-insensitive) for strings; membership for
 *   arrays (any element equal or containing the operand).
 * - `&` `|`: bitwise, numeric only; the attribute is coerced to an integer and
 *   the test is (attr OP operand) !== 0. Non-numeric attributes never match.
 */

import type { NormalizedValue } from './value.js';
import type { ComparisonNode, Operand, QueryNode } from './parser.js';

/** A normalized record: lower-cased attribute name -> decoded value. */
export type QueryRecord = Record<string, NormalizedValue>;

function toComparableString(v: string | number | boolean): string {
  return String(v).toLowerCase();
}

/** Is this scalar a JS number we can do arithmetic/bitwise on? */
function asNumber(v: unknown): number | null {
  return typeof v === 'number' && !Number.isNaN(v) ? v : null;
}

/** Compare one scalar element against the operand for a given operator. */
function matchScalar(
  el: string | number | boolean,
  op: ComparisonNode['op'],
  operand: Operand
): boolean {
  switch (op) {
    case '=':
    case '!=': {
      const elNum = asNumber(el);
      let equal: boolean;
      if (operand.kind === 'number' && elNum !== null) {
        equal = elNum === operand.num;
      } else {
        equal = toComparableString(el) === operand.raw.toLowerCase();
      }
      return op === '=' ? equal : !equal;
    }
    case '>':
    case '>=':
    case '<':
    case '<=': {
      const elNum = asNumber(el);
      if (operand.kind === 'number' && elNum !== null) {
        if (op === '>') return elNum > operand.num!;
        if (op === '>=') return elNum >= operand.num!;
        if (op === '<') return elNum < operand.num!;
        return elNum <= operand.num!;
      }
      // Lexical (case-insensitive) comparison otherwise.
      const a = toComparableString(el);
      const b = operand.raw.toLowerCase();
      if (op === '>') return a > b;
      if (op === '>=') return a >= b;
      if (op === '<') return a < b;
      return a <= b;
    }
    case ':': {
      // Substring containment, case-insensitive.
      return toComparableString(el).includes(operand.raw.toLowerCase());
    }
    case '&':
    case '|': {
      const elNum = asNumber(el);
      if (elNum === null || operand.kind !== 'number') return false;
      const attrBits = Math.trunc(elNum);
      const opBits = Math.trunc(operand.num!);
      const result = op === '&' ? attrBits & opBits : attrBits | opBits;
      return result !== 0;
    }
    default:
      return false;
  }
}

/** Evaluate a single comparison against the record. */
function evalComparison(node: ComparisonNode, record: QueryRecord): boolean {
  const value = record[node.field.toLowerCase()];
  if (value === undefined) return false; // missing attribute => no match

  if (Array.isArray(value)) {
    // Existential: matches if ANY element matches.
    return value.some((el) => matchScalar(el, node.op, node.operand));
  }
  return matchScalar(value, node.op, node.operand);
}

/**
 * Evaluate an AST node against a record, returning whether the record matches.
 */
export function evaluate(node: QueryNode, record: QueryRecord): boolean {
  switch (node.type) {
    case 'comparison':
      return evalComparison(node, record);
    case 'not':
      return !evaluate(node.operand, record);
    case 'logical':
      return node.op === 'AND'
        ? evaluate(node.left, record) && evaluate(node.right, record)
        : evaluate(node.left, record) || evaluate(node.right, record);
    default:
      return false;
  }
}
