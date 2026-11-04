const JS_EXTENSIONS = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'];
const SOURCE_PATHSPECS = ['php', ...JS_EXTENSIONS].map((ext) => `*.${ext}`);

/**
 * 拡張子から言語を判定する
 *
 * @param {string} filePath
 * @returns {'php'|'js'|null} 対象外の拡張子なら null
 */
function langOf(filePath) {
  const ext = filePath.toLowerCase().split('.').pop();
  if (ext === 'php') return 'php';
  if (JS_EXTENSIONS.includes(ext)) return 'js';
  return null;
}

/**
 * ソースコード中のコメントを返す
 *
 * 文字列リテラルと正規表現リテラルの中の // や # をコメントと誤認しないよう、それらを読み飛ばす。
 * ヒアドキュメントと、行をまたぐ式の途中から始まる正規表現リテラルは考慮しないため、まれに誤検出する。
 *
 * @param {string} source
 * @param {'php'|'js'} lang
 * @returns {{
 *   lineComments: {line: number, column: number, text: string}[],
 *   blocks: {start: number, end: number, column: number, endColumn: number, isDoc: boolean, lines: {line: number, text: string}[]}[]
 * }} 行番号は 1 始まり。column は記号の開始位置で、endColumn は終了の記号の直後の位置。blocks の text は先頭の * を除いたもの
 */
function scanComments(source, lang) {
  const lineComments = [];
  const blocks = [];
  let block = null;
  let quote = null;

  source.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    let textStart = 0;
    let j = 0;
    while (j < raw.length) {
      const c = raw[j];
      const next = raw[j + 1];
      if (block) {
        if (c === '*' && next === '/') {
          block.lines.push({ line, text: stripStar(raw.slice(textStart, j)) });
          block.end = line;
          block.endColumn = j + 2;
          blocks.push(block);
          block = null;
          j += 2;
          continue;
        }
        j++;
        continue;
      }
      if (quote) {
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === quote) quote = null;
        j++;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        j++;
        continue;
      }
      if (c === '/' && next === '*') {
        const isDoc = raw[j + 2] === '*' && raw[j + 3] !== '/';
        block = { start: line, end: line, column: j, endColumn: raw.length, isDoc, lines: [] };
        j += isDoc ? 3 : 2;
        textStart = j;
        continue;
      }
      if ((c === '/' && next === '/') || (lang === 'php' && c === '#' && next !== '[')) {
        lineComments.push({ line, column: j, text: raw.slice(j + (c === '#' ? 1 : 2)).trim() });
        break;
      }
      if (lang === 'js' && c === '/' && startsRegex(raw.slice(0, j))) {
        const end = regexEnd(raw, j);
        if (end !== -1) {
          j = end + 1;
          continue;
        }
      }
      j++;
    }
    if (block) block.lines.push({ line, text: stripStar(raw.slice(textStart)) });
    // JS の ' と " は行をまたがないため、閉じ忘れで以降の行がすべて文字列扱いになるのを防ぐ
    if (lang === 'js' && (quote === '"' || quote === "'")) quote = null;
  });

  return { lineComments, blocks };
}

/**
 * / が正規表現リテラルの始まりかを判定する
 *
 * 割り算の / と区別するため、直前が演算子・区切り記号・行頭・return などのキーワードのときだけ正規表現とみなす。
 *
 * @param {string} before 同じ行の / より前の部分
 * @returns {boolean}
 */
function startsRegex(before) {
  const trimmed = before.trimEnd();
  if (trimmed === '') return true;
  if ('(,=:[!&|?{};+-*%<>~^'.includes(trimmed[trimmed.length - 1])) return true;
  return /\b(return|typeof|case|in|of|void|delete|throw)$/.test(trimmed);
}

/**
 * 正規表現リテラルの終わりの / の位置を返す
 *
 * @param {string} raw
 * @param {number} start 始まりの / の位置
 * @returns {number} 同じ行で閉じていないときは -1
 */
function regexEnd(raw, start) {
  let inClass = false;
  for (let k = start + 1; k < raw.length; k++) {
    const ch = raw[k];
    if (ch === '\\') {
      k++;
    } else if (inClass) {
      if (ch === ']') inClass = false;
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === '/') {
      return k;
    }
  }
  return -1;
}

/**
 * docblock の行から先頭の * と前後の空白を除いた文字列を返す
 *
 * @param {string} text
 * @returns {string}
 */
function stripStar(text) {
  return text.replace(/^\s*\*?/, '').trim();
}

module.exports = { SOURCE_PATHSPECS, langOf, scanComments };
