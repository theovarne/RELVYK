// RPC u64/i64 values can exceed JavaScript's integer range. Preserve their
// numeric lexemes before JSON.parse; all money arithmetic uses BigInt below.
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function integerLexeme(token) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) return null;
  const fraction = match[3] || '';
  const exponent = Number(match[4] || 0);
  if (Math.abs(exponent) > 128) throw new SyntaxError('Numeric exponent exceeds the supported range.');
  let digits = match[2] + fraction;
  const shift = exponent - fraction.length;
  if (shift >= 0) digits += '0'.repeat(shift);
  else {
    const cut = digits.length + shift;
    if (cut <= 0) return /^0+$/.test(digits) ? '0' : null;
    if (!/^0*$/.test(digits.slice(cut))) return null;
    digits = digits.slice(0, cut);
  }
  if (digits.length > 128) throw new SyntaxError('Integer magnitude exceeds the supported RPC range.');
  return (match[1] || '') + (digits.replace(/^0+(?=\d)/, '') || '0');
}

export function parseJSONExact(text) {
  if (typeof text !== 'string') throw new TypeError('JSON input must be text.');
  let output = '', i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const start = i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i++] === '"') break;
      }
      output += text.slice(start, i);
    } else if (text[i] === '-' || /\d/.test(text[i])) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      if (!match) throw new SyntaxError('Invalid JSON number.');
      const token = match[0], integer = integerLexeme(token);
      if (token.length > 1024) throw new SyntaxError('Numeric token exceeds the supported range.');
      if (integer !== null && (BigInt(integer) > MAX_SAFE || BigInt(integer) < -MAX_SAFE)) output += JSON.stringify(integer);
      else output += token;
      i += token.length;
    } else output += text[i++];
  }
  return JSON.parse(output);
}

export function exactInteger(value, { signed = false } = {}) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError('Unsafe or non-integer value; exact source data is required.');
  const text = typeof value === 'bigint' ? value.toString() : String(value);
  if (!(signed ? /^-?\d+$/ : /^\d+$/).test(text)) throw new TypeError('Expected an exact decimal integer.');
  return BigInt(text);
}

export function formatAmount(value, decimals = 0) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new TypeError('Invalid decimals.');
  const amount = exactInteger(value, { signed: true });
  const negative = amount < 0n;
  let digits = (negative ? -amount : amount).toString();
  if (!decimals) return `${negative ? '-' : ''}${digits}`;
  digits = digits.padStart(decimals + 1, '0');
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${digits.slice(0, -decimals)}${fraction ? '.' + fraction : ''}`;
}

export function integerOrNull(value) {
  try { return exactInteger(value).toString(); } catch { return null; }
}
