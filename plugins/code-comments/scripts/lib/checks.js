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
// 関数の中のヘルパーまで拾うと誤検出が多いため、トップレベルの宣言だけを対象にする
const JS_ARROW = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>)/;
const JS_METHOD_WITH_MODIFIER = /^\s+(?:(?:public|private|protected|static|async|override|abstract|readonly|get|set)\s+)+\*?([A-Za-z_$][\w$]*)\s*[<(]/;
// 修飾子のないメソッドは関数呼び出しと区別しにくいため、シグネチャが 1 行で { で終わるものだけを対象にする
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
// クラス名だけの括弧は、外すと指す先がわからなくなることがあるため対象にしない。半角の括弧は関数呼び出しと区別するため、直前が識別子のものを除く
const PAREN_REFERENCE = /(?:（|(?<![\w$])\()[\w$./\\-]*(?:\.(?:php|jsx?|mjs|cjs|tsx?|mts|cts|json|tpl|sql)|(?:::|->)\w+(?:\(\))?|\(\))[）)]/;
const ALIGNED_TAG = /^@\w+.*\s{2,}\S/;

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
 * 関数宣言のすぐ上の行の行番号を返す
 *
 * デコレーターと PHP のアトリビュートは docblock と宣言の間に入るため読み飛ばす。
 *
 * @param {string[]} lines
 * @param {number} line 関数宣言の行番号
 * @returns {number} 該当する行がないときは 0
 */
function lineAbove(lines, line) {
  let i = line - 2;
  while (i >= 0 && /^\s*(?:@\w|#\[)/.test(lines[i])) i--;
  return i + 1;
}

/**
 * 関数の引数の名前を返す
 *
 * @param {string[]} lines
 * @param {number} line 関数宣言の行番号
 * @param {'php'|'js'} lang
 * @returns {string[]|null} 引数の括弧が見つからないときと、分割代入のように名前のない引数があるときは null
 */
function functionParams(lines, line, lang) {
  // 引数が複数行にわたるときのため、宣言行から 20 行までを対象にする
  const text = lines.slice(line - 1, line + 19).join('\n');
  const open = text.indexOf('(');
  const arrow = text.indexOf('=>');
  if (open === -1 || (arrow !== -1 && arrow < open)) return null;

  const parts = [];
  let current = '';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if ('([{<'.includes(c)) {
      depth++;
      if (depth === 1) continue;
    } else if (')]}'.includes(c) || (c === '>' && text[i - 1] !== '=')) {
      depth--;
      if (depth === 0) {
        parts.push(current);
        break;
      }
    } else if (c === ',' && depth === 1) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }

  const names = [];
  for (const part of parts) {
    const t = part.trim();
    if (t === '') continue;
    const m =
      lang === 'php'
        ? t.match(/\$(\w+)/)
        : t.replace(/^(?:(?:public|private|protected|readonly|override)\s+)+/, '').match(/^(?:\.\.\.)?([A-Za-z_$][\w$]*)/);
    if (!m) return null;
    names.push(m[1]);
  }
  return names;
}

/**
 * docblock の @param の名前を返す
 *
 * @param {{lines: {text: string}[]}} block
 * @param {'php'|'js'} lang
 * @returns {string[]} options.name のような入れ子の @param は、先頭の名前にまとめる
 */
function docParams(block, lang) {
  const names = [];
  for (const { text } of block.lines) {
    if (!/^@param\b/.test(text)) continue;
    let rest = text.slice('@param'.length).trim();
    if (lang === 'js' && rest.startsWith('{')) rest = rest.slice(closingBrace(rest) + 1).trim();
    const m = lang === 'php' ? rest.match(/\$(\w+)/) : rest.match(/^\[?(?:\.\.\.)?([A-Za-z_$][\w$]*)/);
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/**
 * 先頭の { に対応する } の位置を返す
 *
 * @param {string} text { で始まる文字列
 * @returns {number} 見つからないときは文字列の末尾の位置
 */
function closingBrace(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return i;
  }
  return text.length - 1;
}

/**
 * docblock がファイル全体の説明かを判定する
 *
 * @param {string[]} lines
 * @param {number} start docblock の開始行の行番号
 * @returns {boolean} docblock より前に空行・<?php・'use strict'・行コメントしかなければ true
 */
function isFileHeader(lines, start) {
  return lines.slice(0, start - 1).every((l) => /^\s*(?:<\?php|\/\/|#(?!\[)|['"]use strict['"];?\s*$|$)/.test(l));
}

/**
 * 関数の docblock の有無と、docblock と引数の対応の問題を返す
 *
 * @param {string[]} lines
 * @param {'php'|'js'} lang
 * @param {Map<number, object>} docByEnd docblock の最終行の行番号から docblock への対応
 * @param {(line: number) => boolean} isAdded
 * @returns {{line: number, rule: string, message: string}[]}
 */
function checkFunctions(lines, lang, docByEnd, isAdded) {
  const findings = [];
  for (const fn of findFunctions(lines, lang)) {
    const above = lineAbove(lines, fn.line);
    const doc = docByEnd.get(above);
    // 関数の間に別の関数を入れると、もとの関数の宣言行は変わらず、すぐ上の行だけが追加された行になる
    const touched = isAdded(fn.line) || isAdded(above) || (doc && doc.lines.some((l) => isAdded(l.line)));
    if (!touched) continue;

    if (!doc) {
      let l = above;
      while (l > 0 && lines[l - 1].trim() === '') l--;
      // 空行をはさんだ docblock は checkDetached が報告する
      if (!docByEnd.has(l)) findings.push({ line: fn.line, rule: 'missing-docblock', message: `${fn.name} に docblock がない` });
      continue;
    }

    const documented = docParams(doc, lang);
    const actual = functionParams(lines, fn.line, lang);
    if (actual !== null && documented.some((name) => !actual.includes(name))) {
      findings.push({
        line: fn.line,
        rule: 'docblock-mismatch',
        message: `docblock の @param（${documented.join(', ')}）が ${fn.name} の引数（${actual.join(', ') || 'なし'}）と合わない。別の関数の docblock になっていないか確認する`,
      });
      continue;
    }

    const summary = innerLines(doc.lines).find((l) => l.text !== '');
    if (!summary || summary.text.startsWith('@')) continue;
    const used = summary.text.replace(/。$/, '').match(predicateRe);
    const expected = vocabulary.prefixes[namePrefix(fn.name)];
    if (used && expected && !expected.includes(used[1])) {
      findings.push({
        line: fn.line,
        rule: 'predicate-mismatch',
        message: `${fn.name} の接頭辞からは「${expected.join('」か「')}」が合うが、summary の述語は「${used[1]}」。別の関数の docblock になっていないか確認する`,
      });
      continue;
    }
    // @param と接頭辞で判定できないずれと、宣言を変えたときの docblock の書き直し漏れを、AI に確認させる
    if (isAdded(fn.line) && !doc.lines.some((l) => isAdded(l.line))) {
      findings.push({
        line: fn.line,
        rule: 'docblock-review',
        message: `docblock は変更されていないが、宣言が変わった。関数名 ${fn.name} と summary「${summary.text}」が合っているか確認する`,
      });
    }
  }
  return findings;
}

/**
 * 関数名の接頭辞を返す
 *
 * @param {string} name camelCase か snake_case の関数名
 * @returns {string} 小文字で始まらない名前は空文字列
 */
function namePrefix(name) {
  const m = name.match(/^_*([a-z]+)(?=[A-Z0-9_]|$)/);
  return m ? m[1] : '';
}

/**
 * 直後に空行がある docblock の問題を返す
 *
 * @param {string[]} lines
 * @param {{start: number, end: number}[]} docs
 * @param {(line: number) => boolean} isAdded
 * @returns {{line: number, rule: string, message: string}[]}
 */
function checkDetached(lines, docs, isAdded) {
  const findings = [];
  for (const b of docs) {
    // /** ... */ foo() のように同じ行にコードが続くものは、空行の判定から除く
    if (!lines[b.end - 1].trim().endsWith('*/')) continue;
    let next = b.end + 1;
    while (next <= lines.length && lines[next - 1].trim() === '') next++;
    if (next === b.end + 1 || next > lines.length || isFileHeader(lines, b.start)) continue;
    let touched = false;
    for (let l = b.start; l <= next; l++) touched = touched || isAdded(l);
    if (touched) {
      findings.push({ line: b.end, rule: 'docblock-detached', message: 'docblock の直後に空行がある。説明する宣言の直上に置く' });
    }
  }
  return findings;
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
 * @param {boolean} isFunction 関数の docblock なら true。語彙表は関数の述語のため、ほかの docblock では述語を検査しない
 * @returns {{line: number, rule: string, message: string}[]}
 */
function checkSummary(summary, isFunction) {
  const findings = [];
  const text = summary.text;
  const add = (rule, message) => findings.push({ line: summary.line, rule, message });

  if (text.endsWith('。')) add('summary-period', 'summary の文末に「。」をつけない');
  if (text.slice(0, -1).includes('。')) add('summary-sentences', 'summary は 1 文で書く');
  const body = text.replace(/。$/, '');
  if (/(です|ます|でした|ません)$/.test(body)) {
    add('summary-style', '常体で書く');
  } else if (isFunction && ![...banned, ...replacements].some((b) => b.re.test(body)) && !predicateRe.test(body)) {
    add('summary-predicate', `述語が語彙表にない（文末: 「${body.slice(-8)}」）。語彙表: ${vocabulary.predicates.join(' / ')}`);
  }
  return findings;
}

/**
 * コメント本文の語彙・経緯語・括弧の参照・TODO・コメントアウトされたコード・区切り線・タグのそろえの問題を返す
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
    if (r.re.test(text)) add('replace-word', `「${r.label || r.pattern}」は「${r.suggest}」にする（${r.reason}）`);
  }
  const hit = history.find((re) => re.test(text));
  if (hit) {
    add('history', `変更経緯を書いていないか確認する（「${text.match(hit)[0]}」）。経緯はコミットメッセージや PR 説明に書く`);
  }
  if (PAREN_REFERENCE.test(text)) {
    add('paren-reference', `括弧でパスやメソッド名を添えない（「${text.match(PAREN_REFERENCE)[0]}」）。移動するとコメントだけが古くなる。括弧を外すと指す先がわからなくなるものは残す`);
  }
  if (isDoc && ALIGNED_TAG.test(text)) {
    add('aligned-tag', 'タグの型や名前を空白で縦にそろえない。区切りは半角スペース 1 つにする');
  }
  // 本文中で TODO などの単語を使っているコメントを除くため、先頭にあるものだけを対象にする
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

  const docs = blocks.filter((b) => b.isDoc);
  const functionDocEnds = new Set(findFunctions(lines, lang).map((fn) => lineAbove(lines, fn.line)));
  findings.push(...checkFunctions(lines, lang, new Map(docs.map((b) => [b.end, b])), isAdded));
  findings.push(...checkDetached(lines, docs, isAdded));

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
    findings.push(...checkSummary(summary, functionDocEnds.has(b.end)),...checkDocblockLayout(inner));
  }

  return findings.sort((a, b) => a.line - b.line);
}

module.exports = { checkSource };
