/**
 * Tokenizer for the ad-object query language.
 *
 * Grammar shape (parsed in parser.ts):
 *   expr    := or
 *   or      := and (OR and)*
 *   and     := not (AND not)*
 *   not     := NOT not | group
 *   group   := '(' expr ')' | comparison
 *   comparison := FIELD OP operand
 *
 * Tokens produced here:
 *   - Logical keywords: AND, OR, NOT (case-insensitive)
 *   - Parens: ( )
 *   - Comparison operators: = != > >= < <= :  (': ' is the "contains" operator)
 *   - Bitwise operators: & |   (numeric bit tests)
 *   - Strings: "double quoted", with \" and \\ escapes
 *   - Numbers: integer or decimal, optional leading -
 *   - Bare words: field names and unquoted values (e.g. true, NORMAL, a SID)
 *
 * Bare words are deliberately permissive so `enabled=true` or
 * `useraccountcontrol:NORMAL` work without quoting; the parser decides whether a
 * bare word is a field (left of an operator) or a value (right of one).
 */

export type TokenType =
  | 'AND'
  | 'OR'
  | 'NOT'
  | 'LPAREN'
  | 'RPAREN'
  | 'OP' // comparison or bitwise operator; exact operator in `value`
  | 'STRING' // quoted string literal (quotes already removed)
  | 'NUMBER' // numeric literal
  | 'WORD' // bare identifier / unquoted value
  | 'EOF';

export interface Token {
  type: TokenType;
  /** For OP: the operator text. For STRING/NUMBER/WORD: the literal. */
  value: string;
  /** 0-based index into the source where this token starts (for error msgs). */
  pos: number;
}

/** Comparison + bitwise operators, longest-first so `>=` beats `>`. */
const OPERATORS = ['>=', '<=', '!=', '=', '>', '<', ':', '&', '|'];

/** A character that can appear in a bare word (field name or unquoted value). */
function isWordChar(ch: string): boolean {
  // Letters, digits, and the punctuation that shows up in AD names, SIDs,
  // dotted paths, GUIDs, backslash-laden GPO keys, etc. Note `:` is deliberately
  // excluded: it is the contains-operator, and any value containing a colon
  // (timestamps, objectId like "1:guid") is expected to be quoted.
  return /[A-Za-z0-9_\-.\\/*@{}]/.test(ch);
}

/**
 * Thrown on malformed input (e.g. an unterminated string). Carries the position
 * so callers can point at the offending character.
 */
export class QuerySyntaxError extends Error {
  constructor(
    message: string,
    readonly pos: number
  ) {
    super(message);
    this.name = 'QuerySyntaxError';
  }
}

/**
 * Turn a query string into a flat token list terminated by an EOF token.
 * Whitespace separates tokens but is otherwise insignificant.
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // Skip whitespace.
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Parentheses.
    if (ch === '(') {
      tokens.push({ type: 'LPAREN', value: '(', pos: i });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'RPAREN', value: ')', pos: i });
      i++;
      continue;
    }

    // Quoted string with escape support.
    if (ch === '"') {
      const start = i;
      i++; // consume opening quote
      let str = '';
      let closed = false;
      while (i < input.length) {
        const c = input[i];
        if (c === '\\' && i + 1 < input.length) {
          str += input[i + 1];
          i += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        str += c;
        i++;
      }
      if (!closed) {
        throw new QuerySyntaxError('Unterminated string literal', start);
      }
      tokens.push({ type: 'STRING', value: str, pos: start });
      continue;
    }

    // Operators (longest-first so `>=` beats `>`).
    let matchedOp: string | undefined;
    for (const op of OPERATORS) {
      if (input.startsWith(op, i)) {
        matchedOp = op;
        break;
      }
    }
    if (matchedOp) {
      tokens.push({ type: 'OP', value: matchedOp, pos: i });
      i += matchedOp.length;
      continue;
    }

    // Number: optional minus, digits, optional single decimal point. Only when
    // it clearly starts a number (so `-` inside a word is handled by the word
    // scanner). We require a digit after an optional leading '-'.
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(input[i + 1] ?? ''))) {
      const start = i;
      if (ch === '-') i++;
      let sawDot = false;
      while (i < input.length) {
        const c = input[i];
        if (/[0-9]/.test(c)) {
          i++;
        } else if (c === '.' && !sawDot && /[0-9]/.test(input[i + 1] ?? '')) {
          sawDot = true;
          i++;
        } else {
          break;
        }
      }
      // If the numeric run is immediately followed by more word chars (e.g. a
      // GUID like 12345abc), treat the whole thing as a word instead.
      if (i < input.length && isWordChar(input[i]) && !/\s|[()]/.test(input[i])) {
        // Rewind and fall through to word scanning.
        i = start;
      } else {
        tokens.push({ type: 'NUMBER', value: input.slice(start, i), pos: start });
        continue;
      }
    }

    // Bare word / keyword.
    if (isWordChar(ch)) {
      const start = i;
      while (i < input.length && isWordChar(input[i])) i++;
      const word = input.slice(start, i);
      const upper = word.toUpperCase();
      if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
        tokens.push({ type: upper as TokenType, value: upper, pos: start });
      } else {
        tokens.push({ type: 'WORD', value: word, pos: start });
      }
      continue;
    }

    throw new QuerySyntaxError(`Unexpected character '${ch}'`, i);
  }

  tokens.push({ type: 'EOF', value: '', pos: input.length });
  return tokens;
}
