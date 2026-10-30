const path = require('path');
const { scanComments } = require('./scan');

const vocabulary = require(path.join(__dirname, '..', '..', 'vocabulary.json'));
const banned = vocabulary.banned.map((b) => ({ ...b, re: new RegExp(b.pattern) }));
const replacements = vocabulary.replacements.map((r) => ({ ...r, re: new RegExp(r.pattern) }));
const history = vocabulary.history.map((p) => new RegExp(p, 'i'));
const predicateRe = new RegExp(`(${vocabulary.predicates.join('|')})$`);

const JS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'super']);
const PHP_FUNCTION = /^\s*(?:(?:abstract|final|public|protected|private|static)\s+)*function\s+&?([A-Za-z_]\w*)\s*\(/;
const JS_FUNCTION = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/;
// 関数の中のヘルパーまで拾うと誤検出が多いため、トップレベルの宣言だけを対象にしている
const JS_ARROW = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>)/;
const JS_METHOD_WITH_MODIFIER = /^\s+(?:(?:public|private|protected|static|async|override|abstract|readonly|get|set)\s+)+\*?([A-Za-z_$][\w$]*)\s*[<(]/;
// 修飾子のないメソッドは関数呼び出しと区別しにくいため、シグネチャが 1 行で { で終わるものだけを対象にしている
const JS_METHOD = /^\s+\*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{;=]+)?\{\s*$/;

const CODE_LIKE = [
  /;\s*$/,
  /^[{}()[\]]+;?$/,
  /^(?:const|let|var|return|echo|if|for|foreach|while|function|import|export|use|new)\b.*[;({=]/,
  /^\$\w+\s*(?:=|->|\[)/,
  /^[A-Za-z_$][\w$.]*(?:->\w+)*\(.*\)\s*;?$/,
];
const JAPANESE = /[ぁ-んァ-ヶ一-龠]/;
const DIVIDER = [/^[-=*#/~_+]{3,}$/, /^[-=*#~]{2,}.*[-=*#~]{2,}$/];

/**
 * 関数宣言の行番号と名前を返す
 *
 * @param {string[]} lines
 * @param {'php'|'js'} lang
 * @returns {{line: number, name: string}[]}
 */
function findFunctions(lines, lang) {
  const patterns = lang === 'php' ? [PHP_FUNCTION] : [JS_FUNCTION, JS_ARROW, JS_METHOD_WITH_MODIFIER, JS_METHOD];
  const found = [];
  lines.forEach((text, i) => {
    for (const re of patterns) {
      const m = text.match(re);
      if (m && !JS_KEYWORDS.has(m[1])) {
        found.push({ line: i + 1, name: m[1] });
        break;
      }
    }
  });
  return found;
}

/**
 * 関数宣言の直前に docblock があるかを判定する
 *
 * デコレーターと PHP のアトリビュートは docblock と宣言の間に入るため読み飛ばす。
 *
 * @param {string[]} lines
 * @param {number} line 関数宣言の行番号
 * @param {Set<number>} docEnds docblock の最終行の行番号
 * @returns {boolean}
 */
function hasDocblockAbove(lines, line, docEnds) {
  let i = line - 2;
  while (i >= 0 && /^\s*(?:@\w|#\[)/.test(lines[i])) i--;
  return i >= 0 && docEnds.has(i + 1);
}

/**
 * docblock の行から、開始行と終了行の空の部分を除いた行を返す
 *
 * @param {{line: number, text: string}[]} blockLines
 * @returns {{line: number, text: string}[]}
 */
function innerLines(blockLines) {
  const lines = [...blockLines];
  if (lines.length > 1 && lines[0].text === '') lines.shift();
  if (lines.length > 1 && lines[lines.length - 1].text === '') lines.pop();
  return lines;
}

/**
 * docblock のかたまりの間の空行の問題を返す
 *
 * @param {{line: number, text: string}[]} lines innerLines の戻り値
 * @returns {{line: number, rule: string, message: string}[]}
 */
function checkDocblockLayout(lines) {
  const findings = [];
  let blankRun = 0;
  let inTags = false;
  let summaryLength = 0;
  let summaryDone = false;

  lines.forEach((l, i) => {
    if (l.text === '') {
      blankRun++;
      if (blankRun === 2) findings.push({ line: l.line, rule: 'docblock-blank-line', message: '空行が 2 行以上続いている。かたまりの間は 1 行にする' });
      if (summaryLength > 0) summaryDone = true;
      return;
    }
    const isTag = l.text.startsWith('@');
    if (isTag && !inTags) {
      inTags = true;
      if (i > 0 && blankRun === 0) {
        findings.push({ line: l.line, rule: 'docblock-blank-line', message: 'タグの前に空行を 1 行入れる' });
      }
    }
    if (!isTag && !inTags && !summaryDone) summaryLength++;
    blankRun = 0;
  });

  if (summaryLength > 1) {
    findings.push({
      line: lines[0].line,
      rule: 'summary-lines',
      message: 'summary は 1 行で書き、詳細との間に空行を 1 行入れる',
    });
  }
  return findings;
}

/**
 * summary の書式と述語の問題を返す
 *
 * @param {{line: number, text: string}} summary
 * @returns {{line: number, rule: string, message: string}[]}
 */
function checkSummary(summary) {
  const findings = [];
  const text = summary.text;
  const add = (rule, message) => findings.push({ line: summary.line, rule, message });

  if (text.endsWith('。')) add('summary-period', 'summary の文末に「。」をつけない');
  if (text.slice(0, -1).includes('。')) add('summary-sentences', 'summary は 1 文で書く');
  const body = text.replace(/。$/, '');
  if (/(です|ます|でした|ません)$/.test(body)) {
    add('summary-style', '常体で書く');
  } else if (![...banned, ...replacements].some((b) => b.re.test(body)) && !predicateRe.test(body)) {
    add('summary-predicate', `述語が語彙表にない（文末: 「${body.slice(-8)}」）。語彙表: ${vocabulary.predicates.join(' / ')}`);
  }
  return findings;
}

/**
 * コメント本文の語彙・経緯語・TODO・コメントアウトされたコード・区切り線の問題を返す
 *
 * @param {{line: number, text: string}} comment
 * @param {boolean} isDoc docblock の行なら true。docblock はコード例を含むため、コードと区切り線の検査をしない
 * @returns {{line: number, rule: string, message: string}[]}
 */
function checkCommentText(comment, isDoc) {
  const findings = [];
  const { line, text } = comment;
  const add = (rule, message) => findings.push({ line, rule, message });

  for (const b of banned) {
    if (b.re.test(text)) add('banned-word', `「${b.pattern}」は使わない（${b.reason}）`);
  }
  for (const r of replacements) {
    if (r.re.test(text)) add('replace-word', `「${r.pattern}」は「${r.suggest}」にする（${r.reason}）`);
  }
  const hit = history.find((re) => re.test(text));
  if (hit) {
    add('history', `変更経緯を書いていないか確認する（「${text.match(hit)[0]}」）。経緯はコミットメッセージや PR 説明に書く`);
  }
  // 本文中で TODO という語に触れているだけのコメントを除くため、先頭にあるものだけを対象にしている
  if (/^(TODO|FIXME|XXX)\b/.test(text) &&!/(#\d+|[A-Z][A-Z0-9]+-\d+)/.test(text)) {
    add('todo-ticket', 'TODO にチケット番号がない');
  }
  if (!isDoc && !JAPANESE.test(text) && CODE_LIKE.some((re) => re.test(text))) {
    add('commented-code', 'コメントアウトされたコードに見える。不要なら削除する');
  }
  if (!isDoc && DIVIDER.some((re) => re.test(text))) {
    add('divider', '区切り線や見出しだけのコメントは書かない');
  }
  return findings;
}

/**
 * 追加された行のコメントの問題を返す
 *
 * @param {string} source
 * @param {'php'|'js'} lang
 * @param {Set<number>|null} added 追加された行番号。null ならすべての行を対象にする
 * @returns {{line: number, rule: string, message: string}[]} 行番号の順
 */
function checkSource(source, lang, added) {
  const isAdded = (line) => added === null || added.has(line);
  const lines = source.split(/\r?\n/);
  const { lineComments, blocks } = scanComments(source, lang);
  const findings = [];

  const docEnds = new Set(blocks.filter((b) => b.isDoc).map((b) => b.end));
  for (const fn of findFunctions(lines, lang)) {
    if (isAdded(fn.line) && !hasDocblockAbove(lines, fn.line, docEnds)) {
      findings.push({ line: fn.line, rule: 'missing-docblock', message: `${fn.name} に docblock がない` });
    }
  }

  for (const c of lineComments) {
    if (isAdded(c.line)) findings.push(...checkCommentText(c, false));
  }

  for (const b of blocks) {
    if (!b.lines.some((l) => isAdded(l.line))) continue;
    for (const l of b.lines) {
      if (isAdded(l.line) && l.text !== '') findings.push(...checkCommentText(l, b.isDoc));
    }
    if (!b.isDoc) continue;
    const inner = innerLines(b.lines);
    const summary = inner.find((l) => l.text !== '');
    if (!summary || summary.text.startsWith('@')) {
      findings.push({ line: b.start, rule: 'summary-missing', message: 'docblock に summary がない' });
      continue;
    }
    findings.push(...checkSummary(summary), ...checkDocblockLayout(inner));
  }

  return findings.sort((a, b) => a.line - b.line);
}

module.exports = { checkSource };
