/**
 * Recursive-descent parser for the ad-object query language.
 *
 * Precedence (lowest to highest): OR < AND < NOT < comparison/group.
 * So `a=1 OR b=2 AND c=3` parses as `a=1 OR (b=2 AND c=3)`, and NOT binds to the
 * tightest following term. Parentheses override precedence.
 *
 * The AST is intentionally tiny:
 *   - ComparisonNode: one `field OP operand` test (the leaves)
 *   - LogicalNode:    AND/OR of two subtrees
 *   - NotNode:        negation of a subtree
 *
 * Operands are tagged as string vs number so the evaluator can pick numeric vs
 * lexical comparison without re-guessing types. A bare word like `true` stays a
 * string here; the evaluator coerces against the actual attribute value.
 */

import { tokenize, QuerySyntaxError, type Token } from './lexer.js';

export type ComparisonOperator =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | ':' // contains (substring for strings, membership for arrays)
  | '&' // bitwise AND (numeric): (attr & operand) !== 0
  | '|'; // bitwise OR  (numeric): (attr | operand) !== 0

export interface Operand {
  /** 'number' when the literal was numeric; 'string' otherwise. */
  kind: 'number' | 'string';
  raw: string;
  num?: number;
}

export interface ComparisonNode {
  type: 'comparison';
  field: string;
  op: ComparisonOperator;
  operand: Operand;
}

export interface LogicalNode {
  type: 'logical';
  op: 'AND' | 'OR';
  left: QueryNode;
  right: QueryNode;
}

export interface NotNode {
  type: 'not';
  operand: QueryNode;
}

export type QueryNode = ComparisonNode | LogicalNode | NotNode;

const COMPARISON_OPS: ReadonlySet<string> = new Set([
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  ':',
  '&',
  '|',
]);

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: Token['type']): Token {
    const tok = this.peek();
    if (tok.type !== type) {
      throw new QuerySyntaxError(
        `Expected ${type} but found '${tok.value || tok.type}'`,
        tok.pos
      );
    }
    return this.next();
  }

  /** expr := or */
  parse(): QueryNode {
    const node = this.parseOr();
    if (this.peek().type !== 'EOF') {
      const tok = this.peek();
      throw new QuerySyntaxError(
        `Unexpected trailing input '${tok.value || tok.type}'`,
        tok.pos
      );
    }
    return node;
  }

  /** or := and (OR and)* */
  private parseOr(): QueryNode {
    let left = this.parseAnd();
    while (this.peek().type === 'OR') {
      this.next();
      const right = this.parseAnd();
      left = { type: 'logical', op: 'OR', left, right };
    }
    return left;
  }

  /** and := not (AND not)* */
  private parseAnd(): QueryNode {
    let left = this.parseNot();
    while (this.peek().type === 'AND') {
      this.next();
      const right = this.parseNot();
      left = { type: 'logical', op: 'AND', left, right };
    }
    return left;
  }

  /** not := NOT not | group */
  private parseNot(): QueryNode {
    if (this.peek().type === 'NOT') {
      this.next();
      return { type: 'not', operand: this.parseNot() };
    }
    return this.parseGroup();
  }

  /** group := '(' expr ')' | comparison */
  private parseGroup(): QueryNode {
    if (this.peek().type === 'LPAREN') {
      this.next();
      const node = this.parseOr();
      this.expect('RPAREN');
      return node;
    }
    return this.parseComparison();
  }

  /** comparison := FIELD OP operand */
  private parseComparison(): ComparisonNode {
    const fieldTok = this.peek();
    if (fieldTok.type !== 'WORD') {
      throw new QuerySyntaxError(
        `Expected a field name but found '${fieldTok.value || fieldTok.type}'`,
        fieldTok.pos
      );
    }
    this.next();

    const opTok = this.peek();
    if (opTok.type !== 'OP' || !COMPARISON_OPS.has(opTok.value)) {
      throw new QuerySyntaxError(
        `Expected a comparison operator after '${fieldTok.value}' but found '${
          opTok.value || opTok.type
        }'`,
        opTok.pos
      );
    }
    this.next();

    const valTok = this.peek();
    if (
      valTok.type !== 'WORD' &&
      valTok.type !== 'STRING' &&
      valTok.type !== 'NUMBER'
    ) {
      throw new QuerySyntaxError(
        `Expected a value after '${opTok.value}' but found '${
          valTok.value || valTok.type
        }'`,
        valTok.pos
      );
    }
    this.next();

    const operand: Operand =
      valTok.type === 'NUMBER'
        ? { kind: 'number', raw: valTok.value, num: Number(valTok.value) }
        : { kind: 'string', raw: valTok.value };

    return {
      type: 'comparison',
      field: fieldTok.value,
      op: opTok.value as ComparisonOperator,
      operand,
    };
  }
}

/**
 * Parse a query string into an AST. Throws QuerySyntaxError (with a position)
 * on malformed input.
 */
export function parseQuery(input: string): QueryNode {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new QuerySyntaxError('Empty query', 0);
  }
  return new Parser(tokenize(trimmed)).parse();
}
