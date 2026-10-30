/**
 * 拡張子から言語を判定する
 *
 * @param {string} filePath
 * @returns {'php'|'js'|null} 対象外の拡張子なら null
 */
function langOf(filePath) {
  const ext = filePath.toLowerCase().split('.').pop();
  if (ext === 'php') return 'php';
  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'].includes(ext)) return 'js';
  return null;
}

/**
 * ソースコード中のコメントを返す
 *
 * 文字列リテラルの中の // や # をコメントと誤認しないよう、引用符の状態を追う。
 * 正規表現リテラルとヒアドキュメントは考慮しないため、まれに誤検出する。
 *
 * @param {string} source
 * @param {'php'|'js'} lang
 * @returns {{
 *   lineComments: {line: number, text: string}[],
 *   blocks: {start: number, end: number, isDoc: boolean, lines: {line: number, text: string}[]}[]
 * }} 行番号は 1 始まり。blocks の text は先頭の * を除いたもの
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
        block = { start: line, end: line, isDoc, lines: [] };
        j += isDoc ? 3 : 2;
        textStart = j;
        continue;
      }
      if ((c === '/' && next === '/') || (lang === 'php' && c === '#' && next !== '[')) {
        lineComments.push({ line, text: raw.slice(j + (c === '#' ? 1 : 2)).trim() });
        break;
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
 * docblock の行から先頭の * と前後の空白を除いた文字列を返す
 *
 * @param {string} text
 * @returns {string}
 */
function stripStar(text) {
  return text.replace(/^\s*\*?/, '').trim();
}

module.exports = { langOf, scanComments };
