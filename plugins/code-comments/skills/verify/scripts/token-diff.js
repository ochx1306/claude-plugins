#!/usr/bin/env node
// 使い方（git リポジトリの中で実行する）:
//   node token-diff.js [--from REV] [--to REV] [パス...]
//   node token-diff.js --files 変更前 変更後
//   node token-diff.js --dump ファイル
// PHP・JS・TS のファイルの変更がコメントと空白だけかを、トークン列の比較で確かめる。
// --from の既定は HEAD、--to の既定は作業ツリー。パスを省略すると、2 つの版の間で変わったファイルをすべて比べる。
// 終了コード: 0 = すべて一致 / 1 = 差分あり / 2 = 失敗
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { diffHunks } = require('./lib/tokens');
const { tokenizeJs } = require('./lib/tokenize-js');
const { tokenizePhp } = require('./lib/tokenize-php');

const PLAIN_JS = new Set(['js', 'mjs', 'cjs']);
const JSX = new Set(['jsx', 'tsx']);
const TS = new Set(['ts', 'mts', 'cts']);
const EXTENSIONS = ['php', ...PLAIN_JS, ...JSX, ...TS];
const PATHSPECS = EXTENSIONS.map((ext) => `*.${ext}`);
const MAX_BUFFER = 1024 * 1024 * 1024;
const MAX_DISPLAY_LENGTH = 300;
const EXIT = { same: 0, different: 1, failed: 2 };

/**
 * git を実行して標準出力を返す
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Buffer}
 */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * ファイルの内容を文字列に変換する
 *
 * UTF-8 以外のバイト列を置換文字にすると、違うバイト列が同じ文字列になるため、1 バイトずつ別の文字にする。
 *
 * @param {Buffer} buffer
 * @returns {string} 改行は LF にそろえる
 */
function decode(buffer) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    text = buffer.toString('latin1');
  }
  return text.replace(/\r\n/g, '\n');
}

/**
 * ファイルの拡張子を返す
 *
 * @param {string} filePath
 * @returns {string} 小文字の拡張子
 */
function extensionOf(filePath) {
  return path.extname(filePath).slice(1).toLowerCase();
}

/**
 * ソースをトークン列に変換する
 *
 * 通常の JS は JSX を含むことがあるため、JSX を許可する。TS の <T>x は型アサーションのため許可しない。
 *
 * @param {string} filePath 拡張子で言語を判定する
 * @param {string} source
 * @returns {{tokens: string[], lines: number[]}}
 * @throws {Error} 解析できないとき
 */
function tokenize(filePath, source) {
  const ext = extensionOf(filePath);
  if (ext === 'php') return tokenizePhp(source);
  if (PLAIN_JS.has(ext) || JSX.has(ext)) return tokenizeJs(source, true);
  if (TS.has(ext)) return tokenizeJs(source, false);
  throw new Error('対象外の拡張子');
}

/**
 * トークン区間の行番号の表示を返す
 *
 * @param {number[]} lines
 * @param {number} start
 * @param {number} end 含まない
 * @returns {string}
 */
function lineRange(lines, start, end) {
  if (start >= end) {
    const near = lines[start] === undefined ? lines[lines.length - 1] || 0 : lines[start];
    return `なし（${near}行目付近）`;
  }
  return lines[start] === lines[end - 1] ? `${lines[start]}行目` : `${lines[start]}-${lines[end - 1]}行目`;
}

/**
 * トークン区間を 1 行の表示に変換する
 *
 * @param {string[]} tokens
 * @param {number} start
 * @param {number} end 含まない
 * @returns {string}
 */
function joinTokens(tokens, start, end) {
  const text = tokens.slice(start, end).join(' ').replace(/\n/g, '\\n');
  return text.length > MAX_DISPLAY_LENGTH ? `${text.slice(0, MAX_DISPLAY_LENGTH)} ...` : text;
}

/**
 * PHP のバージョンで解釈が変わる構文の注意の行を返す
 *
 * 変更の前後で行番号だけが違う同じ注意は、変更後のものだけを返す。
 *
 * @param {{notes?: string[]}} before
 * @param {{notes?: string[]}} after
 * @returns {string[]}
 */
function versionNotes(before, after) {
  const notes = new Map();
  for (const note of [...(after.notes || []), ...(before.notes || [])]) {
    const key = note.replace(/^\d+行目: /, '');
    if (!notes.has(key)) notes.set(key, `  [注意] ${note}`);
  }
  return [...notes.values()];
}

/**
 * 1 組のソースを比べた結果の行を返す
 *
 * @param {{label: string, beforePath: string, afterPath: string, before: string, after: string}} pair
 * @returns {{status: 'same'|'different'|'failed', lines: string[]}}
 */
function compare({ label, beforePath, afterPath, before, after }) {
  let a;
  let b;
  try {
    a = tokenize(beforePath, before);
  } catch (e) {
    return { status: 'failed', lines: [`[ERROR] ${label}: 変更前を解析できない（${e.message}）`] };
  }
  try {
    b = tokenize(afterPath, after);
  } catch (e) {
    return { status: 'failed', lines: [`[ERROR] ${label}: 変更後を解析できない（${e.message}）`] };
  }
  const notes = versionNotes(a, b);
  const hunks = diffHunks(a.tokens, b.tokens);
  if (hunks.length === 0) {
    return { status: 'same', lines: [`[OK] ${label}（${a.tokens.length} トークン一致）`, ...notes] };
  }
  const lines = [`[NG] ${label}（差分 ${hunks.length} か所・トークン数 ${a.tokens.length} → ${b.tokens.length}）`, ...notes];
  for (const [aStart, aEnd, bStart, bEnd] of hunks) {
    lines.push(`  変更前 ${lineRange(a.lines, aStart, aEnd)} / 変更後 ${lineRange(b.lines, bStart, bEnd)}`);
    if (aStart < aEnd) lines.push(`    - ${joinTokens(a.tokens, aStart, aEnd)}`);
    if (bStart < bEnd) lines.push(`    + ${joinTokens(b.tokens, bStart, bEnd)}`);
  }
  return { status: 'different', lines };
}

/**
 * 2 つの版の間で変わったファイルの組を返す
 *
 * @param {string} root
 * @param {string} from
 * @param {string|undefined} to 省略すると作業ツリーと比べ、未追跡のファイルも含める
 * @returns {{beforePath: string|null, afterPath: string|null}[]}
 */
function changedFiles(root, from, to) {
  const revs = to ? [from, to] : [from];
  const fields = git(['diff', '--name-status', '-z', '-M', '--no-ext-diff', ...revs, '--', ...PATHSPECS], root).toString('utf8').split('\0');
  const files = [];
  for (let i = 0; i + 1 < fields.length; ) {
    const status = fields[i][0];
    if (status === 'R') {
      files.push({ beforePath: fields[i + 1], afterPath: fields[i + 2] });
      i += 3;
    } else if (status === 'C') {
      files.push({ beforePath: null, afterPath: fields[i + 2] });
      i += 3;
    } else {
      const name = fields[i + 1];
      files.push({ beforePath: status === 'A' ? null : name, afterPath: status === 'D' ? null : name });
      i += 2;
    }
  }
  if (!to) {
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...PATHSPECS], root).toString('utf8').split('\0').filter(Boolean);
    for (const name of untracked) files.push({ beforePath: null, afterPath: name });
  }
  return files;
}

/**
 * 指定された版のファイルの内容を返す
 *
 * @param {string} root
 * @param {string} filePath リポジトリのルートからのパス
 * @param {string|undefined} rev 省略すると作業ツリーのファイルを読む
 * @returns {string|null} ファイルがないときは null
 */
function readVersion(root, filePath, rev) {
  try {
    return decode(rev ? git(['show', `${rev}:${filePath}`], root) : fs.readFileSync(path.join(root, filePath)));
  } catch {
    return null;
  }
}

/**
 * git の 2 つの版を比べる組を返す
 *
 * @param {string} from
 * @param {string|undefined} to
 * @param {string[]} paths 空なら変わったファイルをすべて比べる
 * @returns {{root: string, files: {beforePath: string|null, afterPath: string|null}[]}}
 */
function revisionFiles(from, to, paths) {
  const root = git(['rev-parse', '--show-toplevel'], process.cwd()).toString('utf8').trim();
  for (const rev of to ? [from, to] : [from]) {
    try {
      git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], root);
    } catch {
      throw new Error(`版が見つからない: ${rev}`);
    }
  }
  if (paths.length === 0) return { root, files: changedFiles(root, from, to) };
  const files = paths.map((p) => {
    const relative = path.relative(root, path.resolve(p)).split(path.sep).join('/');
    return { beforePath: relative, afterPath: relative };
  });
  return { root, files };
}

/**
 * git の 2 つの版のファイルを比べて結果を表示し、終了コードを返す
 *
 * @param {string} from
 * @param {string|undefined} to
 * @param {string[]} paths
 * @returns {number} 終了コード
 */
function compareRevisions(from, to, paths) {
  const { root, files } = revisionFiles(from, to, paths);
  const toLabel = to || '作業ツリー';
  if (files.length === 0) {
    console.log(`比べるファイルがない（${from} と ${toLabel} の間で変わった PHP・JS・TS のファイルがない）`);
    return EXIT.same;
  }
  console.log(`比較: ${from} → ${toLabel}（${files.length} ファイル）`);

  const counts = { same: 0, different: 0, skipped: 0, failed: 0 };
  for (const file of files) {
    const before = file.beforePath && readVersion(root, file.beforePath, from);
    const after = file.afterPath && readVersion(root, file.afterPath, to);
    const label = file.beforePath && file.afterPath && file.beforePath !== file.afterPath ? `${file.beforePath} → ${file.afterPath}` : file.afterPath || file.beforePath;
    if ((before === null || before === undefined) && (after === null || after === undefined)) {
      console.log(`[ERROR] ${label}: どちらの版にもない`);
      counts.failed++;
    } else if (before === null || before === undefined) {
      console.log(`[SKIP] ${label}（新しく追加されたファイル）`);
      counts.skipped++;
    } else if (after === null || after === undefined) {
      console.log(`[SKIP] ${label}（削除されたファイル）`);
      counts.skipped++;
    } else {
      const result = compare({ label, beforePath: file.beforePath, afterPath: file.afterPath, before, after });
      result.lines.forEach((line) => console.log(line));
      counts[result.status]++;
    }
  }
  console.log(`\n一致 ${counts.same} / 差分あり ${counts.different} / 対象外 ${counts.skipped} / 失敗 ${counts.failed}`);
  if (counts.failed > 0) return EXIT.failed;
  return counts.different > 0 ? EXIT.different : EXIT.same;
}

/**
 * git を使わず 2 つのファイルを比べて結果を表示し、終了コードを返す
 *
 * @param {string} beforePath
 * @param {string} afterPath
 * @returns {number} 終了コード
 */
function compareFiles(beforePath, afterPath) {
  const result = compare({
    label: `${beforePath} → ${afterPath}`,
    beforePath,
    afterPath,
    before: decode(fs.readFileSync(beforePath)),
    after: decode(fs.readFileSync(afterPath)),
  });
  result.lines.forEach((line) => console.log(line));
  return EXIT[result.status];
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      from: { type: 'string', default: 'HEAD' },
      to: { type: 'string' },
      files: { type: 'boolean', default: false },
      dump: { type: 'boolean', default: false },
    },
  });
  if (values.dump) {
    if (positionals.length !== 1) throw new Error('--dump には 1 つのファイルを指定する');
    const { tokens } = tokenize(positionals[0], decode(fs.readFileSync(positionals[0])));
    tokens.forEach((t) => console.log(t.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')));
  } else if (values.files) {
    if (positionals.length !== 2) throw new Error('--files には 2 つのファイルを指定する');
    process.exitCode = compareFiles(positionals[0], positionals[1]);
  } else {
    process.exitCode = compareRevisions(values.from, values.to, positionals);
  }
} catch (e) {
  console.error(e.stderr && e.stderr.length > 0 ? e.stderr.toString().trim() : e.message);
  process.exitCode = EXIT.failed;
}
