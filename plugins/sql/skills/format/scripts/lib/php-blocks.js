// PHP の $sql .= "..." . PHP_EOL; の連続した行を見つけ、整形した行に置き換える案を作る。
const { tokenize, formatSql, startsWithKeyword } = require('./sql-layout');

const PHP_LINE = /^(\s*)(\$\w+)\s*(\.=|=)\s*(["'])(.*)\4\s*\.\s*(PHP_EOL|"\\n"|'\\n')\s*;\s*$/;
// 引用符は連結、バックスラッシュはエスケープ、$ は変数展開を表す。これらを含む行は SQL として解析できない
const EMBEDDED = { '"': /\\|"|\$\w|\$\{|\{\$/, "'": /\\|'/ };

/**
 * PHP の 1 行から代入の内容を返す
 *
 * @param {string} line
 * @returns {{indent: string, varName: string, op: string, quote: string, content: string, eol: string}|null} 対象の形でないときは null
 */
function parseLine(line) {
  const m = line.match(PHP_LINE);
  if (!m) return null;
  return { indent: m[1], varName: m[2], op: m[3], quote: m[4], content: m[5].trimEnd(), eol: m[6] };
}

/**
 * 同じ変数への連続した代入をブロックにして返す
 *
 * = は変数を代入し直すため、別のブロックの始まりにする。キーワードで始まる行がないものは SQL でないとみなす。
 *
 * @param {string[]} lines
 * @param {number} first 対象の最初の行の位置
 * @param {number} last 対象の最後の行の位置
 * @returns {{start: number, end: number, rows: object[]}[]} start と end は行の位置。2 行以上のものだけを返す
 */
function findBlocks(lines, first, last) {
  const blocks = [];
  let current = null;
  const flush = () => {
    if (current && current.rows.length >= 2 && current.rows.some((r) => startsWithKeyword(r.content))) blocks.push(current);
    current = null;
  };
  for (let i = first; i <= last; i++) {
    const row = parseLine(lines[i]);
    if (!row) {
      flush();
      continue;
    }
    if (!current || current.rows[0].varName !== row.varName || row.op === '=') {
      flush();
      current = { start: i, end: i, rows: [] };
    }
    current.rows.push(row);
    current.end = i;
  }
  flush();
  return blocks;
}

/**
 * ブロックの SQL の行を、PHP の連結の行に変換する
 *
 * 先頭の演算子は元のまま保つ。.= を = に変えると、それまでの SQL が消えるため。
 *
 * @param {string[]} contents
 * @param {{indent: string, varName: string, op: string, quote: string, eol: string}} head ブロックの先頭の行
 * @param {number|null} padding 最長の行に足して右パディングする文字数
 * @returns {string[]}
 */
function wrapLines(contents, head, padding) {
  const width = padding === null ? 0 : Math.max(...contents.map((c) => c.length)) + padding;
  return contents.map((content, i) => {
    const op = i === 0 && head.op === '=' ? '  =' : ' .=';
    return `${head.indent}${head.varName}${op} ${head.quote}${content.padEnd(width)}${head.quote} . ${head.eol};`;
  });
}

/**
 * ブロックを整形した行と、整形の種類を返す
 *
 * 式の連結・変数展開・コメントを含むブロックは、構造を変えずパディングだけを直す。
 *
 * @param {{rows: object[]}} block
 * @param {{comma: 'leading'|'trailing', indent: number, padding: number|null}} style
 * @returns {{lines: string[], kept: string|null}} kept は構造を保った理由。保っていなければ null
 * @throws {Error} 行末が SQL の文字列の途中になっているなど、パディングでも値が変わるおそれがあるとき
 */
function reformatBlock(block, style) {
  const head = block.rows[0];
  const contents = block.rows.map((r) => r.content);
  const sql = contents.join('\n');
  // 行末が文字列の途中だと、パディングや行末の空白の削除が値を変えるため、構造を保つ場合も対象から除く
  if (tokenize(sql).some((t) => t.type === 'string' && t.text.includes('\n'))) throw new Error('行末が SQL の文字列の途中になっている');

  if (block.rows.some((r) => EMBEDDED[r.quote].test(r.content))) {
    return { lines: wrapLines(contents, head, style.padding), kept: '式の連結か変数展開を含む' };
  }
  try {
    const formatted = formatSql(sql, style, { continuation: head.op === '.=' });
    return { lines: wrapLines(formatted, head, style.padding), kept: null };
  } catch (e) {
    return { lines: wrapLines(contents, head, style.padding), kept: e.message };
  }
}

module.exports = { findBlocks, reformatBlock, wrapLines };
