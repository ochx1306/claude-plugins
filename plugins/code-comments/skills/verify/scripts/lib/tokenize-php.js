// PHP のソースを、コメントと空白を除いたトークン列に変換する。
// 解析できない構文は例外にする。誤って一致と判定するより、失敗として報告するほうが安全なため。
const { lineLocator } = require('./tokens');

const OPEN_TAG = /<\?(?:php(?=\s|$)|=)/gi;
const PUNCTUATORS = [
  '<=>', '**=', '...', '<<=', '>>=', '===', '!==', '??=', '?->',
  '++', '--', '->', '=>', '::', '==', '!=', '<>', '<=', '>=', '&&', '||', '??', '+=', '-=', '*=', '/=', '.=', '%=', '&=', '|=', '^=', '<<', '>>', '**', '#[',
];
const WORD = /\$*[A-Za-z_\x80-￿][\w\x80-￿]*/y;
const NUMBER = /0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?/y;
const HEREDOC = /<<<[ \t]*(?:"([A-Za-z_\x80-￿][\w\x80-￿]*)"|'([A-Za-z_\x80-￿][\w\x80-￿]*)'|([A-Za-z_\x80-￿][\w\x80-￿]*))\n/y;

/**
 * ソースをトークン列に変換する
 *
 * 文字列の中の変数展開は、空白も含めて文字列の一部として比べる。
 *
 * @param {string} source LF にそろえたソース
 * @returns {{tokens: string[], lines: number[]}} lines は各トークンの行番号
 * @throws {Error} 解析できないとき
 */
function tokenizePhp(source) {
  const lineAt = lineLocator(source);
  const tokens = [];
  const lines = [];
  let i = 0;

  const fail = (message, at = i) => {
    throw new Error(`${lineAt(at)}行目: ${message}`);
  };

  const emit = (text, at) => {
    tokens.push(text);
    lines.push(lineAt(at));
  };

  // 引用符の閉じる位置の次を返す。"{$a["k"]}" のように、変数展開の中の引用符では閉じない
  const skipQuoted = (start) => {
    const quote = source[start];
    let k = start + 1;
    while (k < source.length) {
      const c = source[k];
      if (c === '\\') {
        k += 2;
      } else if (c === quote) {
        return k + 1;
      } else if (quote !== "'" && ((c === '{' && source[k + 1] === '$') || (c === '$' && source[k + 1] === '{'))) {
        k = skipInterpolation(k + (c === '$' ? 2 : 1));
      } else {
        k++;
      }
    }
    return fail('文字列が閉じていない', start);
  };

  // 変数展開の閉じる位置の次を返す
  const skipInterpolation = (start) => {
    let depth = 1;
    let k = start;
    while (k < source.length) {
      const c = source[k];
      if (c === '"' || c === "'" || c === '`') {
        k = skipQuoted(k);
      } else {
        if (c === '{') depth++;
        if (c === '}' && --depth === 0) return k + 1;
        k++;
      }
    }
    return fail('文字列の変数展開が閉じていない', start);
  };

  const scanHeredoc = () => {
    HEREDOC.lastIndex = i;
    const m = HEREDOC.exec(source);
    if (!m) return false;
    const label = m[1] || m[2] || m[3];
    const end = new RegExp(`^[ \\t]*${label}(?![\\w\\x80-\\uffff])`, 'm');
    const bodyStart = i + m[0].length;
    const found = end.exec(source.slice(bodyStart));
    if (!found) fail('ヒアドキュメントが閉じていない');
    const stop = bodyStart + found.index + found[0].length;
    emit(source.slice(i, stop), i);
    i = stop;
    return true;
  };

  const scanPhp = () => {
    while (i < source.length) {
      const c = source[i];
      if (/\s/.test(c)) {
        i++;
      } else if (source.startsWith('?>', i)) {
        emit('?>', i);
        i += 2;
        // PHP は閉じタグの直後の改行を 1 つだけ出力しない
        if (source[i] === '\n') i++;
        return;
      } else if (source.startsWith('//', i) || (c === '#' && source[i + 1] !== '[')) {
        // 行コメントは閉じタグの直前までで終わる
        while (i < source.length && source[i] !== '\n' && !source.startsWith('?>', i)) i++;
      } else if (source.startsWith('/*', i)) {
        const end = source.indexOf('*/', i + 2);
        if (end === -1) fail('コメントが閉じていない');
        i = end + 2;
      } else if (c === '"' || c === "'" || c === '`') {
        const end = skipQuoted(i);
        emit(source.slice(i, end), i);
        i = end;
      } else if (source.startsWith('<<<', i) && scanHeredoc()) {
        continue;
      } else {
        NUMBER.lastIndex = i;
        const number = /[\d.]/.test(c) ? NUMBER.exec(source) : null;
        if (number) {
          emit(number[0], i);
          i += number[0].length;
          continue;
        }
        WORD.lastIndex = i;
        const word = WORD.exec(source);
        if (word) {
          emit(word[0], i);
          i += word[0].length;
          continue;
        }
        const punctuator = PUNCTUATORS.find((p) => source.startsWith(p, i)) || c;
        emit(punctuator, i);
        i += punctuator.length;
      }
    }
  };

  while (i < source.length) {
    OPEN_TAG.lastIndex = i;
    const open = OPEN_TAG.exec(source);
    const htmlEnd = open ? open.index : source.length;
    if (htmlEnd > i) emit(source.slice(i, htmlEnd), i);
    if (!open) break;
    i = htmlEnd + open[0].length;
    emit(open[0].toLowerCase(), htmlEnd);
    scanPhp();
  }
  return { tokens, lines };
}

module.exports = { tokenizePhp };
