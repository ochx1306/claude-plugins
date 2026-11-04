#!/usr/bin/env node
// 使い方: node list-comments.js [--from REV] [--to REV] [--base BRANCH] [-o 出力先.md]
// git の差分に含まれるコメントの行を、ファイルごと・まとまりごとに Markdown の一覧にする。
// --from の既定は --base との分岐点、--to の既定は作業ツリー（未追跡のファイルも含める）、--base の既定は origin の既定のブランチ。
// 標準エラーに「ファイル数 まとまりの数」を出力する。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { langOf, scanComments } = require('../../../scripts/lib/scan');

const JS_EXTENSIONS = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'];
const OTHER_EXTENSIONS = ['tpl', 'sql', 'css', 'scss', 'html'];
const PATHSPECS = ['php', ...JS_EXTENSIONS, ...OTHER_EXTENSIONS, 'sample'].map((ext) => `*.${ext}`);
const MAX_BUFFER = 1024 * 1024 * 1024;

const C_BLOCK = ['/*', '*/'];
const TEMPLATE = { blocks: [['{*', '*}'], ['<!--', '-->'], C_BLOCK], line: '//' };
const SYNTAX = {
  tpl: TEMPLATE,
  html: TEMPLATE,
  css: { blocks: [C_BLOCK] },
  scss: { blocks: [C_BLOCK], line: '//' },
  sql: { blocks: [C_BLOCK], line: '--', commentOn: true },
};
const DEFAULT_SYNTAX = SYNTAX.scss;
// 記号だけの行は文を含まないため、まとまりを一覧に含めるかの判定に使わない
const SYMBOL_ONLY = new Set(['', '/*', '/**', '*/', '*']);
const EXCLUDED_PATH = /(?:^|\/)Smarty\/compile\/|\.min\./;

/**
 * git を実行して標準出力を返す
 *
 * @param {string[]} args
 * @returns {string}
 */
function git(args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * 差分から、ファイルごとの追加された行と削除された行の行番号を返す
 *
 * コードの行が diff のヘッダーに見えることがあるため、hunk の本文はヘッダーの行数の分だけ読み飛ばす。
 *
 * @param {string} diff git diff -U0 の出力
 * @returns {{oldPath: string|null, newPath: string|null, added: Set<number>, removed: Set<number>}[]}
 */
function parseDiff(diff) {
  const files = [];
  const lines = diff.split('\n');
  let file = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      file = { oldPath: null, newPath: null, added: new Set(), removed: new Set() };
      files.push(file);
    } else if (file && line.startsWith('--- a/')) {
      file.oldPath = line.slice(6).replace(/\t$/, '');
    } else if (file && line.startsWith('+++ b/')) {
      file.newPath = line.slice(6).replace(/\t$/, '');
    } else if (file) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      const oldCount = m[2] === undefined ? 1 : Number(m[2]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      for (let k = 0; k < oldCount; k++) file.removed.add(Number(m[1]) + k);
      for (let k = 0; k < newCount; k++) file.added.add(Number(m[3]) + k);
      i += oldCount + newCount;
    }
  }
  return files;
}

/**
 * 行のコメントの部分を一覧に追加する
 *
 * 行全体がコメントなら、字下げを保つために行頭から含める。同じ行に複数のコメントがあれば 1 つにつなぐ。
 *
 * @param {Map<number, string>} comments
 * @param {number} line
 * @param {string} raw 行の全体
 * @param {number} from コメントの開始位置
 * @param {number} to コメントの終了位置
 * @returns {void}
 */
function putComment(comments, line, raw, from, to) {
  const start = raw.slice(0, from).trim() === '' ? 0 : from;
  const text = raw.slice(start, to);
  comments.set(line, comments.has(line) ? `${comments.get(line)} ${text.trim()}` : text);
}

/**
 * PHP と JS・TS のコメントの行を返す
 *
 * @param {string} source
 * @param {'php'|'js'} lang
 * @returns {Map<number, string>} 行番号からコメントの部分への対応
 */
function scriptComments(source, lang) {
  const lines = source.split(/\r?\n/);
  const { lineComments, blocks } = scanComments(source, lang);
  const comments = new Map();
  const spans = [];
  for (const c of lineComments) spans.push({ line: c.line, from: c.column, to: lines[c.line - 1].length });
  for (const b of blocks) {
    for (let line = b.start; line <= b.end; line++) {
      spans.push({ line, from: line === b.start ? b.column : 0, to: line === b.end ? b.endColumn : lines[line - 1].length });
    }
  }
  spans.sort((a, b) => a.line - b.line || a.from - b.from);
  for (const s of spans) putComment(comments, s.line, lines[s.line - 1], s.from, s.to);
  return comments;
}

/**
 * テンプレート・SQL・CSS のコメントの行を返す
 *
 * 文字列の中の記号をコメントと誤認しないよう読み飛ばす。文字列は行をまたがないものとして扱う。
 *
 * @param {string} source
 * @param {{blocks: string[][], line?: string, commentOn?: boolean}} syntax
 * @returns {Map<number, string>} 行番号からコメントの部分への対応
 */
function markupComments(source, syntax) {
  const comments = new Map();
  let closing = null;
  let inCommentOn = false;

  source.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    if (syntax.commentOn && !closing && (inCommentOn || /^\s*COMMENT\s+ON\b/i.test(raw))) {
      putComment(comments, line, raw, 0, raw.length);
      inCommentOn = !/;\s*$/.test(raw);
      return;
    }
    if (closing && raw === '') putComment(comments, line, raw, 0, 0);

    let from = 0;
    let quote = null;
    let j = 0;
    while (j < raw.length) {
      if (closing) {
        const end = raw.indexOf(closing, j);
        if (end === -1) {
          putComment(comments, line, raw, from, raw.length);
          break;
        }
        j = end + closing.length;
        putComment(comments, line, raw, from, j);
        closing = null;
        continue;
      }
      const c = raw[j];
      if (quote) {
        if (c === '\\') j++;
        else if (c === quote) quote = null;
        j++;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        j++;
        continue;
      }
      const block = syntax.blocks.find(([open]) => raw.startsWith(open, j));
      if (block) {
        from = j;
        j += block[0].length;
        closing = block[1];
        continue;
      }
      // URL の // をコメントと誤認しないよう、直前が空白か区切り記号のものだけを対象にする
      if (syntax.line && raw.startsWith(syntax.line, j) && (j === 0 || /[\s;{,]/.test(raw[j - 1]))) {
        putComment(comments, line, raw, j, raw.length);
        break;
      }
      j++;
    }
  });
  return comments;
}

/**
 * ファイルのコメントの行を返す
 *
 * @param {string} filePath 拡張子で構文を判定する。末尾の .sample は除いて判定する
 * @param {string} source
 * @returns {Map<number, string>} 行番号からコメントの部分への対応
 */
function commentLines(filePath, source) {
  const name = filePath.replace(/\.sample$/, '');
  const lang = langOf(name);
  if (lang) return scriptComments(source, lang);
  return markupComments(source, SYNTAX[extensionOf(name)] || DEFAULT_SYNTAX);
}

/**
 * ファイル名の拡張子を返す
 *
 * @param {string} filePath
 * @returns {string} 小文字の拡張子。ない場合は空文字列
 */
function extensionOf(filePath) {
  return path.extname(filePath).slice(1).toLowerCase();
}

/**
 * 追加された行のコメントを、隣り合う行ごとのまとまりにして返す
 *
 * @param {Map<number, string>} comments 変更後のコメントの行
 * @param {Set<number>} added 追加された行番号
 * @param {Set<string>} removedTexts 削除されたコメントの文
 * @returns {{start: number, end: number, lines: string[]}[]} 変更前と同じ文の行と記号の行だけのまとまりは含まない
 */
function groupComments(comments, added, removedTexts) {
  const groups = [];
  let current = null;
  for (const line of [...added].sort((a, b) => a - b)) {
    if (!comments.has(line)) {
      current = null;
      continue;
    }
    if (!current || current.end !== line - 1) {
      current = { start: line, end: line, lines: [] };
      groups.push(current);
    }
    current.end = line;
    current.lines.push(comments.get(line));
  }
  return groups.filter((g) => g.lines.some((l) => !removedTexts.has(l.trim()) && !SYMBOL_ONLY.has(l.trim())));
}

/**
 * まとまりの行の共通の字下げを削除した文字列を返す
 *
 * @param {string[]} lines
 * @returns {string}
 */
function dedent(lines) {
  const indents = lines.filter((l) => l.trim() !== '').map((l) => l.match(/^\s*/)[0].length);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(indent)).join('\n');
}

/**
 * 一覧を Markdown に変換する
 *
 * @param {{path: string, groups: {start: number, end: number, lines: string[]}[]}[]} files
 * @param {string} fromLabel
 * @param {string} toLabel
 * @returns {string}
 */
function render(files, fromLabel, toLabel) {
  const total = files.reduce((sum, f) => sum + f.groups.length, 0);
  const out = [
    '## 対象',
    '',
    `${fromLabel} から${toLabel}までの差分で、追加・変更した行のうちコメントのもの。隣り合う行は 1 つのまとまりにした。行番号は${toLabel}のファイルのもの。変更前と同じ文のままの行だけのまとまりは除いた。`,
    '',
    `- ファイル数: ${files.length}`,
    `- まとまりの数: ${total}`,
    '',
  ];
  for (const file of files) {
    const name = file.path.replace(/\.sample$/, '');
    const ext = extensionOf(name);
    const fenceLang = langOf(name) || SYNTAX[ext] ? ext : 'text';
    out.push(`## \`${file.path}\``, '');
    for (const g of file.groups) {
      const body = dedent(g.lines);
      // コメントの中のコードブロックで閉じないよう、本文より長いフェンスにする
      const longest = Math.max(2, ...(body.match(/`+/g) || []).map((s) => s.length));
      const fence = '`'.repeat(longest + 1);
      out.push(`### ${g.start === g.end ? g.start : `${g.start}-${g.end}`}`, '', `${fence}${fenceLang}`, body, fence, '');
    }
  }
  return out.join('\n');
}

/**
 * 対象の版のファイルの内容を返す
 *
 * @param {string} filePath リポジトリのルートからのパス
 * @param {string|undefined} rev 省略すると作業ツリーのファイルを読む
 * @returns {string}
 */
function readVersion(filePath, rev) {
  return rev ? git(['show', `${rev}:${filePath}`]) : fs.readFileSync(filePath, 'utf8');
}

/**
 * 分岐点を求める相手のブランチを返す
 *
 * @returns {string}
 */
function defaultBase() {
  try {
    return git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim();
  } catch {
    return 'main';
  }
}

/**
 * 差分の対象のファイルからコメントの一覧を返す
 *
 * @param {string} fromRev
 * @param {string|undefined} toRev 省略すると作業ツリーと比べ、未追跡のファイルも含める
 * @returns {{path: string, groups: {start: number, end: number, lines: string[]}[]}[]}
 */
function collect(fromRev, toRev) {
  const revs = toRev ? [fromRev, toRev] : [fromRev];
  const diff = git(['diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', ...revs, '--', ...PATHSPECS]);
  const entries = parseDiff(diff).filter((f) => f.newPath);

  if (!toRev) {
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...PATHSPECS]).split('\0').filter(Boolean);
    for (const newPath of untracked) {
      const count = fs.readFileSync(newPath, 'utf8').split('\n').length;
      entries.push({ oldPath: null, newPath, added: new Set(Array.from({ length: count }, (_, i) => i + 1)), removed: new Set() });
    }
  }

  const files = [];
  for (const entry of entries) {
    if (EXCLUDED_PATH.test(entry.newPath)) continue;
    const removedTexts = new Set();
    if (entry.oldPath && entry.removed.size > 0) {
      const oldComments = commentLines(entry.oldPath, readVersion(entry.oldPath, fromRev));
      for (const line of entry.removed) {
        if (oldComments.has(line)) removedTexts.add(oldComments.get(line).trim());
      }
    }
    const comments = commentLines(entry.newPath, readVersion(entry.newPath, toRev));
    const groups = groupComments(comments, entry.added, removedTexts);
    if (groups.length > 0) files.push({ path: entry.newPath, groups });
  }
  return files;
}

try {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      base: { type: 'string' },
      output: { type: 'string', short: 'o' },
    },
  });
  // 出力先の相対パスは、呼び出したディレクトリを基準にする
  const output = values.output && path.resolve(values.output);
  process.chdir(git(['rev-parse', '--show-toplevel']).trim());

  const fromRev = values.from || git(['merge-base', 'HEAD', values.base || defaultBase()]).trim();
  const files = collect(fromRev, values.to);
  const fromLabel = `\`${values.from || git(['rev-parse', '--short', fromRev]).trim()}\``;
  const text = render(files, fromLabel, values.to ? ` \`${values.to}\` ` : '作業ツリー');

  if (output) fs.writeFileSync(output, text);
  else process.stdout.write(text);
  console.error(`${files.length} ${files.reduce((sum, f) => sum + f.groups.length, 0)}`);
} catch (e) {
  console.error(e.stderr ? e.stderr.toString().trim() : e.message);
  process.exit(1);
}
