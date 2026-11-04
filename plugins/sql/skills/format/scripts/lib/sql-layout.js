// SQL をトークンに分け、キーワードと括弧の構造に沿って行に分ける。
// 整形の前後でトークン列が変わるときは例外にする。見た目のためにクエリの意味を変えないため。

// 複数語のキーワードを先に照合するため、語数の多い順に並べる
const INDEPENDENT_KEYWORDS = [
  'ON DUPLICATE KEY UPDATE',
  'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN',
  'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN',
  'GROUP BY', 'ORDER BY', 'INSERT INTO', 'DELETE FROM', 'UNION ALL',
  'UNION', 'SELECT', 'FROM', 'WHERE', 'UPDATE', 'SET', 'HAVING', 'VALUES', 'JOIN',
];
const SAME_LINE_KEYWORDS = ['ON', 'AND', 'OR'];
const SOLO_KEYWORDS = ['FOR UPDATE', 'LIMIT', 'OFFSET'];
const COMMA_LIST_KEYWORDS = new Set(['SELECT', 'GROUP BY', 'ORDER BY', 'VALUES', 'SET', 'ON DUPLICATE KEY UPDATE']);
const PAREN_LIST_KEYWORDS = new Set(['VALUES', 'INSERT INTO']);

const KEYWORDS = [...INDEPENDENT_KEYWORDS, ...SAME_LINE_KEYWORDS, ...SOLO_KEYWORDS]
  .map((text) => ({ text, words: text.split(' ') }))
  .sort((a, b) => b.words.length - a.words.length);
const KEYWORD_WORDS = new Set(KEYWORDS.flatMap((k) => k.words));
const WORD = /[\p{L}\p{N}_$@:?.]+/uy;

/**
 * SQL をトークン列に変換する
 *
 * t.from のような修飾された名前は、キーワードと誤認しないよう 1 つの語にする。
 *
 * @param {string} sql
 * @returns {{text: string, type: 'word'|'string'|'comment'|'punct', space: boolean}[]} space は直前に空白があれば true
 * @throws {Error} 文字列やコメントが閉じていないとき
 */
function tokenize(sql) {
  const tokens = [];
  let i = 0;
  let space = false;
  const push = (end, type) => {
    tokens.push({ text: sql.slice(i, end), type, space });
    i = end;
    space = false;
  };

  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      space = true;
      i++;
    } else if (c === "'" || c === '"' || c === '`') {
      push(closingQuote(sql, i), 'string');
    } else if (sql.startsWith('--', i) || c === '#') {
      const end = sql.indexOf('\n', i);
      push(end === -1 ? sql.length : end, 'comment');
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new Error('SQL のコメントが閉じていない');
      push(end + 2, 'comment');
    } else {
      WORD.lastIndex = i;
      const m = WORD.exec(sql);
      if (m) push(i + m[0].length, 'word');
      else push(i + 1, 'punct');
    }
  }
  return tokens;
}

/**
 * 引用符の閉じる位置の次を返す
 *
 * @param {string} sql
 * @param {number} start 開く引用符の位置
 * @returns {number}
 * @throws {Error} 閉じていないとき
 */
function closingQuote(sql, start) {
  const quote = sql[start];
  for (let i = start + 1; i < sql.length; i++) {
    if (sql[i] === '\\' && quote !== '`') {
      i++;
    } else if (sql[i] === quote) {
      if (sql[i + 1] !== quote) return i + 1;
      i++;
    }
  }
  throw new Error('SQL の文字列が閉じていない');
}

/**
 * トークン列の位置にあるキーワードを返す
 *
 * @param {{text: string, type: string}[]} tokens
 * @param {number} index
 * @returns {{text: string, words: string[]}|null}
 */
function keywordAt(tokens, index) {
  return (
    KEYWORDS.find((k) =>
      k.words.every((word, offset) => {
        const t = tokens[index + offset];
        return t && t.type === 'word' && t.text.toUpperCase() === word;
      }),
    ) || null
  );
}

/**
 * トークン列をキーワードごとのセグメントに変換する
 *
 * 括弧と CASE の中、BETWEEN の AND は、文の区切りではないため分けない。
 *
 * @param {{text: string, type: string}[]} tokens
 * @returns {{keyword: string|null, tokens: object[]}[]}
 */
function toSegments(tokens) {
  const segments = [];
  let current = { keyword: null, tokens: [] };
  let depth = 0;
  let caseDepth = 0;
  let inBetween = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const upper = t.type === 'word' ? t.text.toUpperCase() : '';
    if (t.text === '(' && t.type === 'punct') depth++;
    if (t.text === ')' && t.type === 'punct') depth--;
    if (upper === 'CASE') caseDepth++;
    if (upper === 'END' && caseDepth > 0) caseDepth--;

    let keyword = depth === 0 && caseDepth === 0 ? keywordAt(tokens, i) : null;
    if (keyword && keyword.text === 'AND' && inBetween) keyword = null;
    if (keyword && keyword.text === 'SET' && i > 0 && tokens[i - 1].text.toUpperCase() === 'CHARACTER') keyword = null;
    if (keyword && keyword.text === 'VALUES' && current.keyword === 'ON DUPLICATE KEY UPDATE') keyword = null;
    if (depth === 0 && upper === 'BETWEEN') inBetween = true;
    if (depth === 0 && upper === 'AND') inBetween = false;

    if (keyword) {
      if (current.keyword !== null || current.tokens.length > 0) segments.push(current);
      current = { keyword: keyword.text, tokens: [] };
      i += keyword.words.length - 1;
    } else {
      current.tokens.push(t);
    }
  }
  if (current.keyword !== null || current.tokens.length > 0) segments.push(current);
  return segments;
}

/**
 * トークン列を、元の空白の有無を保った 1 行の文字列に変換する
 *
 * @param {{text: string, space: boolean}[]} tokens
 * @returns {string}
 */
function joinTokens(tokens) {
  return tokens.map((t, i) => (i > 0 && t.space ? ' ' : '') + t.text).join('');
}

/**
 * 括弧の外のカンマで分けたトークン列を返す
 *
 * @param {{text: string, type: string}[]} tokens
 * @returns {object[][]}
 */
function splitCommas(tokens) {
  const items = [];
  let current = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.type === 'punct' && t.text === '(') depth++;
    if (t.type === 'punct' && t.text === ')') depth--;
    if (t.type === 'punct' && t.text === ',' && depth === 0) {
      items.push(current);
      current = [];
    } else {
      current.push(t);
    }
  }
  if (current.length > 0) items.push(current);
  return items;
}

/**
 * 開き括弧に対応する閉じ括弧の位置を返す
 *
 * @param {{text: string, type: string}[]} tokens
 * @param {number} open
 * @returns {number} 見つからないときは -1
 */
function closingParen(tokens, open) {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].type !== 'punct') continue;
    if (tokens[i].text === '(') depth++;
    if (tokens[i].text === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * 項目を行に変換して追加する
 *
 * 括弧の中が SELECT で始まるサブクエリは展開する。そのほかの括弧は 1 行のまま保つ。
 *
 * @param {{text: string, type: string, space: boolean}[]} tokens
 * @param {number} indent
 * @param {{indent: number, text: string, separated: boolean}[]} lines
 * @param {boolean} separated 前の項目との間にカンマが必要なら true
 * @param {string} [prefix] 行頭のキーワード
 * @returns {void}
 */
function pushItem(tokens, indent, lines, separated, prefix = '') {
  let needsSeparator = separated;
  let start = 0;
  let head = prefix;
  const push = (text, lineIndent) => {
    lines.push({ indent: lineIndent, text, separated: needsSeparator });
    needsSeparator = false;
  };
  const withHead = (text) => [head, text].filter(Boolean).join(' ');

  for (let i = 0; i < tokens.length; i++) {
    const next = tokens[i + 1];
    const opensSubquery = tokens[i].type === 'punct' && tokens[i].text === '(' && next && next.type === 'word' && next.text.toUpperCase() === 'SELECT';
    if (!opensSubquery) continue;
    const close = closingParen(tokens, i);
    if (close === -1) throw new Error('SQL の括弧が閉じていない');

    const before = joinTokens(tokens.slice(start, i));
    if (withHead(before)) push(withHead(before), indent);
    push('(', indent);
    pushSegments(toSegments(tokens.slice(i + 1, close)), indent + 1, indent + 1, lines);
    head = ')';
    start = close + 1;
    if (tokens[start] && !tokens[start].space) {
      head = `)${tokens[start].text}`;
      start++;
    }
    i = start - 1;
  }
  const rest = joinTokens(tokens.slice(start));
  if (withHead(rest)) push(withHead(rest), indent);
}

/**
 * 丸括弧のリストを、括弧も独立した行にして追加する
 *
 * @param {object[]} tokens 全体が 1 つの括弧のトークン列
 * @param {number} indent
 * @param {{indent: number, text: string, separated: boolean}[]} lines
 * @param {boolean} separated
 * @returns {void}
 */
function pushParenList(tokens, indent, lines, separated) {
  lines.push({ indent, text: '(', separated });
  splitCommas(tokens.slice(1, -1)).forEach((item, i) => pushItem(item, indent + 1, lines, i > 0));
  lines.push({ indent, text: ')', separated: false });
}

/**
 * VALUES と INSERT INTO の内容を行に変換して追加する
 *
 * @param {string} keyword
 * @param {{text: string, type: string}[]} tokens
 * @param {number} indent
 * @param {{indent: number, text: string, separated: boolean}[]} lines
 * @returns {void}
 */
function pushParenContent(keyword, tokens, indent, lines) {
  const isParenGroup = (group) => group.length > 1 && group[0].text === '(' && closingParen(group, 0) === group.length - 1;
  if (keyword === 'VALUES') {
    splitCommas(tokens).forEach((group, i) => {
      if (isParenGroup(group)) pushParenList(group, indent, lines, i > 0);
      else pushItem(group, indent, lines, i > 0);
    });
    return;
  }
  const open = tokens.findIndex((t) => t.type === 'punct' && t.text === '(');
  if (open <= 0 || !isParenGroup(tokens.slice(open))) {
    pushItem(tokens, indent, lines, false);
    return;
  }
  lines.push({ indent, text: joinTokens(tokens.slice(0, open)), separated: false });
  pushParenList(tokens.slice(open), indent, lines, false);
}

/**
 * セグメント列を行に変換して追加する
 *
 * @param {{keyword: string|null, tokens: object[]}[]} segments
 * @param {number} baseIndent キーワードの字下げの段数
 * @param {number} initialContentIndent 最初のキーワードより前の内容の字下げの段数
 * @param {{indent: number, text: string, separated: boolean}[]} lines
 * @returns {void}
 */
function pushSegments(segments, baseIndent, initialContentIndent, lines) {
  let contentIndent = initialContentIndent;
  for (const { keyword, tokens } of segments) {
    if (keyword === null) {
      pushItem(tokens, contentIndent, lines, false);
    } else if (SOLO_KEYWORDS.includes(keyword)) {
      pushItem(tokens, baseIndent, lines, false, keyword);
    } else if (SAME_LINE_KEYWORDS.includes(keyword)) {
      pushItem(tokens, contentIndent, lines, false, keyword);
    } else {
      lines.push({ indent: baseIndent, text: keyword, separated: false });
      contentIndent = baseIndent + 1;
      if (tokens.length === 0) continue;
      if (PAREN_LIST_KEYWORDS.has(keyword)) {
        pushParenContent(keyword, tokens, contentIndent, lines);
      } else if (COMMA_LIST_KEYWORDS.has(keyword)) {
        splitCommas(tokens).forEach((item, i) => pushItem(item, contentIndent, lines, i > 0));
      } else {
        pushItem(tokens, contentIndent, lines, false);
      }
    }
  }
}

/**
 * 行の情報を、字下げとカンマを付けた文字列に変換する
 *
 * @param {{indent: number, text: string, separated: boolean}[]} lines
 * @param {{comma: 'leading'|'trailing', indent: number}} style
 * @returns {string[]}
 */
function renderLines(lines, style) {
  const out = [];
  for (const line of lines) {
    const column = line.indent * style.indent;
    if (line.separated && style.comma === 'leading') {
      out.push(`${' '.repeat(Math.max(column - 1, 0))},${line.text}`);
    } else {
      if (line.separated) out[out.length - 1] += ',';
      out.push(' '.repeat(column) + line.text);
    }
  }
  return out;
}

/**
 * 比較に使うトークン列の文字列を返す
 *
 * 整形でキーワードを大文字にするため、キーワードの語だけ大文字にそろえる。
 *
 * @param {{text: string, type: string}[]} tokens
 * @returns {string}
 */
function canonical(tokens) {
  return tokens.map((t) => (t.type === 'word' && KEYWORD_WORDS.has(t.text.toUpperCase()) ? t.text.toUpperCase() : t.text)).join('\0');
}

/**
 * SQL を整形した行を返す
 *
 * @param {string} sql
 * @param {{comma: 'leading'|'trailing', indent: number}} style
 * @param {{continuation?: boolean}} [options] continuation は SQL の途中から始まる断片なら true で、先頭の条件を字下げする
 * @returns {string[]}
 * @throws {Error} コメントや複数行の文字列を含むとき、整形でトークン列が変わるとき
 */
function formatSql(sql, style, options = {}) {
  const tokens = tokenize(sql);
  if (tokens.some((t) => t.type === 'comment')) throw new Error('コメントを含む SQL は整形しない');
  if (tokens.some((t) => t.type === 'string' && t.text.includes('\n'))) throw new Error('複数行の文字列を含む SQL は整形しない');

  const lines = [];
  pushSegments(toSegments(tokens), 0, options.continuation ? 1 : 0, lines);
  const formatted = renderLines(lines, style);
  if (canonical(tokenize(formatted.join('\n'))) !== canonical(tokens)) throw new Error('整形で SQL のトークン列が変わる');
  return formatted;
}

/**
 * 文字列がキーワードで始まるかを判定する
 *
 * @param {string} text
 * @returns {boolean}
 */
function startsWithKeyword(text) {
  const tokens = tokenize(text.replace(/['"`#]|--|\/\*/g, ' ')).slice(0, 4);
  return tokens.length > 0 && keywordAt(tokens, 0) !== null;
}

module.exports = { tokenize, formatSql, startsWithKeyword };
