// JS と TS のソースを、コメントと空白を除いたトークン列に変換する。
// 解析できない構文は例外にする。誤って一致と判定するより、失敗として報告するほうが安全なため。
const { lineLocator } = require('./tokens');

// 改行の有無でセミコロンの自動挿入や構文の解釈が変わるキーワード
const RESTRICTED = new Set([
  'return', 'throw', 'break', 'continue', 'yield', 'async', 'get', 'set', 'static', 'accessor',
  'type', 'declare', 'abstract', 'namespace', 'module', 'interface',
]);
const RESTRICTED_BEFORE = new Set(['++', '--']);
// 比較で改行を表す疑似トークン。実際のトークンとは重ならない
const NEWLINE_TOKEN = '<改行>';

const EXPRESSION_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'void', 'delete', 'throw', 'case', 'do', 'else', 'new', 'yield', 'await',
]);
const PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'with']);
const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**',
];
const IDENTIFIER = /[#\p{ID_Start}$_][\p{ID_Continue}$‌‍]*/uy;
const NUMBER = /0[xXbBoO][\da-fA-F_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?/y;
const JSX_ATTRIBUTE_TEXT = /[^\s{}<>/="']+/y;
const WHITESPACE = /[\s﻿]/;

/**
 * ソースをトークン列に変換する
 *
 * @param {string} source LF にそろえたソース
 * @param {boolean} allowJsx JSX として解析してよいファイルなら true
 * @returns {{tokens: string[], lines: number[]}} lines は各トークンの行番号
 * @throws {Error} 解析できないとき
 */
function tokenizeJs(source, allowJsx) {
  const lineAt = lineLocator(source);
  const tokens = [];
  const lines = [];
  // 開いている { と ( の種類。閉じたときに、どの状態へ戻るかを決める
  const stack = [];
  let i = 0;
  let newlineBefore = false;
  let previous = null;
  let beforePrevious = null;
  let previousKind = null;
  let parenAllowsExpression = false;
  let closedBlock = false;
  let postfixBang = false;

  const fail = (message, at = i) => {
    throw new Error(`${lineAt(at)}行目: ${message}`);
  };

  const emit = (text, kind, at) => {
    const restricted = newlineBefore && ((previousKind === 'identifier' && RESTRICTED.has(previous)) || RESTRICTED_BEFORE.has(text));
    if (restricted) {
      tokens.push(NEWLINE_TOKEN);
      lines.push(lineAt(at));
    }
    tokens.push(text);
    lines.push(lineAt(at));
    beforePrevious = previous;
    previous = text;
    previousKind = kind;
    newlineBefore = false;
  };

  // 直前のトークンから、次が式の始まりかを判定する。正規表現と割り算、JSX と比較の区別に使う
  const expressionAllowed = () => {
    if (previous === null) return true;
    if (previousKind === 'identifier') return beforePrevious !== '.' && beforePrevious !== '?.' && EXPRESSION_KEYWORDS.has(previous);
    if (previousKind !== 'punctuator') return false;
    if (previous === ')') return parenAllowsExpression;
    if (previous === '}') return closedBlock;
    if (previous === '!') return !postfixBang;
    return previous !== ']' && previous !== '++' && previous !== '--';
  };

  const scanString = (quote) => {
    const start = i;
    i++;
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\n') fail('文字列が閉じていない', start);
      i += source[i] === '\\' ? 2 : 1;
    }
    if (i >= source.length) fail('文字列が閉じていない', start);
    i++;
    emit(source.slice(start, i), 'string', start);
  };

  const scanTemplate = (start) => {
    while (i < source.length) {
      if (source[i] === '\\') {
        i += 2;
      } else if (source[i] === '`') {
        i++;
        emit(source.slice(start, i), 'template', start);
        return;
      } else if (source[i] === '$' && source[i + 1] === '{') {
        i += 2;
        emit(source.slice(start, i), 'templateHead', start);
        stack.push({ kind: 'template' });
        return;
      } else {
        i++;
      }
    }
    fail('テンプレートリテラルが閉じていない', start);
  };

  const scanRegex = () => {
    let inClass = false;
    for (let k = i + 1; k < source.length && source[k] !== '\n'; k++) {
      const c = source[k];
      if (c === '\\') {
        k++;
      } else if (inClass) {
        if (c === ']') inClass = false;
      } else if (c === '[') {
        inClass = true;
      } else if (c === '/') {
        k++;
        while (k < source.length && /[\p{ID_Continue}$]/u.test(source[k])) k++;
        emit(source.slice(i, k), 'regex', i);
        i = k;
        return true;
      }
    }
    return false;
  };

  const startsJsx = () => {
    if (!allowJsx || !expressionAllowed()) return false;
    if (source[i + 1] === '>') return true;
    const m = /^<\s*([\p{ID_Start}$_][\p{ID_Continue}$.:-]*)\s*(,|extends\b|=\s*[^\s"'{])?/u.exec(source.slice(i, i + 200));
    // TSX のジェネリクスの <T,> と <T extends U> は JSX ではない
    if (m === null || m[2] !== undefined) return false;
    // 型の中の <T>(x: T) => T は、対応する閉じタグがないことで JSX と区別する
    return source[i + m[0].length] !== '>' || source.includes(`</${m[1]}`, i);
  };

  // コンポーネントの型引数の <T> を、空白も含めて 1 つのトークンにする
  const scanJsxTypeArguments = () => {
    const start = i;
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === '"' || c === "'" || c === '`') {
        const end = source.indexOf(c, i + 1);
        if (end === -1) fail('文字列が閉じていない');
        i = end + 1;
      } else if (source.startsWith('=>', i)) {
        i += 2;
      } else {
        if (c === '<') depth++;
        if (c === '>') depth--;
        i++;
        if (depth === 0) {
          emit(source.slice(start, i), 'typeArguments', start);
          return;
        }
      }
    }
    fail('型引数が閉じていない', start);
  };

  const finishElement = (jsx) => {
    if (jsx.depth === 0) {
      previousKind = 'jsx';
    } else {
      scanJsxChildren(jsx);
    }
  };

  const scanJsxTag = (jsx) => {
    while (i < source.length) {
      if (WHITESPACE.test(source[i])) {
        i++;
      } else if (source.startsWith('/*', i)) {
        const end = source.indexOf('*/', i + 2);
        if (end === -1) fail('コメントが閉じていない');
        i = end + 2;
      } else if (source.startsWith('//', i)) {
        const end = source.indexOf('\n', i);
        i = end === -1 ? source.length : end;
      } else if (source.startsWith('/>', i)) {
        emit('/>', 'punctuator', i);
        i += 2;
        finishElement(jsx);
        return;
      } else if (source[i] === '>') {
        emit('>', 'punctuator', i);
        i++;
        if (jsx.closing) {
          jsx.depth--;
          finishElement(jsx);
        } else {
          jsx.depth++;
          scanJsxChildren(jsx);
        }
        return;
      } else if (source[i] === '{') {
        emit('{', 'punctuator', i);
        i++;
        stack.push({ kind: 'jsxTag', jsx });
        return;
      } else if (source[i] === '"' || source[i] === "'") {
        const end = source.indexOf(source[i], i + 1);
        if (end === -1) fail('属性の値が閉じていない');
        emit(source.slice(i, end + 1), 'string', i);
        i = end + 1;
      } else if (source[i] === '=' || source[i] === '/') {
        emit(source[i], 'punctuator', i);
        i++;
      } else if (source[i] === '<') {
        scanJsxTypeArguments();
      } else {
        JSX_ATTRIBUTE_TEXT.lastIndex = i;
        const m = JSX_ATTRIBUTE_TEXT.exec(source);
        if (!m) fail(`JSX のタグを解析できない（${source[i]}）`);
        emit(m[0], 'identifier', i);
        i += m[0].length;
      }
    }
    fail('JSX のタグが閉じていない');
  };

  const scanJsxChildren = (jsx) => {
    const start = i;
    while (i < source.length && source[i] !== '<' && source[i] !== '{') i++;
    if (i >= source.length) fail('JSX の要素が閉じていない', start);
    const text = source.slice(start, i);
    // 改行を含む空白だけのテキストは JSX の仕様で無視される。そのほかは文字列として空白も比べる
    if (!(/^\s*$/.test(text) && text.includes('\n')) && text !== '') emit(text, 'jsxText', start);
    if (source[i] === '{') {
      emit('{', 'punctuator', i);
      i++;
      stack.push({ kind: 'jsxChild', jsx });
      return;
    }
    jsx.closing = source[i + 1] === '/';
    const open = jsx.closing ? '</' : '<';
    emit(open, 'punctuator', i);
    i += open.length;
    scanJsxTag(jsx);
  };

  if (source.startsWith('#!')) {
    const end = source.indexOf('\n');
    i = end === -1 ? source.length : end;
    emit(source.slice(0, i), 'hashbang', 0);
  }

  while (i < source.length) {
    const c = source[i];
    if (c === '\n') {
      newlineBefore = true;
      i++;
      continue;
    }
    if (WHITESPACE.test(c)) {
      i++;
      continue;
    }
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) fail('コメントが閉じていない');
      // 改行を含むブロックコメントは、改行と同じくセミコロンの自動挿入に影響する
      if (source.slice(i, end).includes('\n')) newlineBefore = true;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      scanString(c);
      continue;
    }
    if (c === '`') {
      const start = i;
      i++;
      scanTemplate(start);
      continue;
    }
    if (c === '/' && expressionAllowed() && scanRegex()) continue;
    if (c === '<' && startsJsx()) {
      emit('<', 'punctuator', i);
      i++;
      scanJsxTag({ depth: 0, closing: false });
      continue;
    }

    NUMBER.lastIndex = i;
    const number = /[\d.]/.test(c) ? NUMBER.exec(source) : null;
    if (number && number[0] !== '.' && !number[0].startsWith('..')) {
      emit(number[0], 'number', i);
      i += number[0].length;
      continue;
    }
    IDENTIFIER.lastIndex = i;
    const identifier = IDENTIFIER.exec(source);
    if (identifier) {
      emit(identifier[0], 'identifier', i);
      i += identifier[0].length;
      continue;
    }

    if (c === '(') {
      stack.push({ kind: 'paren', keyword: previousKind === 'identifier' && PAREN_KEYWORDS.has(previous) });
      emit(c, 'punctuator', i);
      i++;
      continue;
    }
    if (c === '[') {
      stack.push({ kind: 'bracket' });
      emit(c, 'punctuator', i);
      i++;
      continue;
    }
    if (c === '{') {
      const isObject = previous !== '=>' && previous !== ')' && expressionAllowed();
      stack.push({ kind: isObject ? 'object' : 'block' });
      emit(c, 'punctuator', i);
      i++;
      continue;
    }
    if (c === ')' || c === ']') {
      const top = stack.pop();
      if (!top || top.kind !== (c === ')' ? 'paren' : 'bracket')) fail(`対応する括弧がない（${c}）`);
      if (c === ')') parenAllowsExpression = top.keyword;
      emit(c, 'punctuator', i);
      i++;
      continue;
    }
    if (c === '}') {
      const top = stack.pop();
      if (!top || top.kind === 'paren' || top.kind === 'bracket') fail('対応する括弧がない（}）');
      if (top.kind === 'template') {
        const start = i;
        i++;
        scanTemplate(start);
        continue;
      }
      closedBlock = top.kind === 'block';
      emit(c, 'punctuator', i);
      i++;
      if (top.kind === 'jsxTag') scanJsxTag(top.jsx);
      if (top.kind === 'jsxChild') scanJsxChildren(top.jsx);
      continue;
    }

    const punctuator = PUNCTUATORS.find((p) => source.startsWith(p, i)) || c;
    // 式の始まりでない位置の ! は TS の non-null 演算子で、その後ろは値の直後として扱う
    if (punctuator === '!') postfixBang = !expressionAllowed();
    emit(punctuator, 'punctuator', i);
    i += punctuator.length;
  }

  if (stack.length > 0) fail(`閉じていない括弧がある（${stack[stack.length - 1].kind}）`);
  return { tokens, lines };
}

module.exports = { tokenizeJs };
