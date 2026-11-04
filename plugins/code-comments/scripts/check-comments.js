#!/usr/bin/env node
// 使い方: node check-comments.js [--from REV] [--all] [パス...]
// パスはファイルかディレクトリ。省略すると、--from の版（既定: HEAD）から変わったファイルと未追跡のファイルを対象にする。
// 既定では変更された行に関係する問題だけを報告する。--all でファイル全体を検査する。
// 終了コード: 0 = 問題なし / 1 = 問題あり / 2 = 失敗
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { SOURCE_PATHSPECS, langOf } = require('./lib/scan');
const { checkSource } = require('./lib/checks');
const { changedLinesFromGit } = require('./lib/added-lines');

const MAX_BUFFER = 1024 * 1024 * 1024;

/**
 * 検出結果を 1 件 1 行の文字列に変換する
 *
 * @param {string} filePath
 * @param {{line: number, rule: string, message: string}[]} findings
 * @returns {string[]}
 */
function formatFindings(filePath, findings) {
  return findings.map((f) => `${filePath}:${f.line} [${f.rule}] ${f.message}`);
}

/**
 * git を実行して NUL 区切りの出力を配列に変換する
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string[]}
 */
function gitList(args, cwd) {
  const output = execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
  return output.split('\0').filter(Boolean);
}

/**
 * 版から変わったファイルと未追跡のファイルの絶対パスを返す
 *
 * @param {string} from
 * @returns {string[]}
 */
function changedFiles(from) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const changed = gitList(['diff', '--name-only', '--diff-filter=d', '-z', from, '--', ...SOURCE_PATHSPECS], root);
  const untracked = gitList(['ls-files', '--others', '--exclude-standard', '-z', '--', ...SOURCE_PATHSPECS], root);
  return [...changed, ...untracked].map((name) => path.join(root, name));
}

/**
 * 指定されたパスを検査するファイルの絶対パスに変換する
 *
 * ディレクトリは git の管理下のファイルと未追跡のファイルに展開する。
 *
 * @param {string[]} paths
 * @returns {string[]}
 * @throws {Error} パスが見つからないとき
 */
function expandPaths(paths) {
  const files = [];
  for (const p of paths) {
    const resolved = path.resolve(p);
    if (!fs.existsSync(resolved)) throw new Error(`見つからない: ${p}`);
    if (fs.statSync(resolved).isDirectory()) {
      const names = gitList(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...SOURCE_PATHSPECS], resolved);
      files.push(...names.map((name) => path.join(resolved, name)).filter((f) => fs.existsSync(f)));
    } else if (langOf(resolved)) {
      files.push(resolved);
    }
  }
  return files;
}

if (require.main === module) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        all: { type: 'boolean', default: false },
        from: { type: 'string', default: 'HEAD' },
      },
    });
    if (positionals.length === 0 || !values.all) {
      try {
        execFileSync('git', ['rev-parse', '--verify', '--quiet', `${values.from}^{commit}`], { stdio: 'ignore' });
      } catch {
        // リポジトリの外のファイルは差分がなく、全体を検査するため、パスの指定があれば続ける
        if (positionals.length === 0 || values.from !== 'HEAD') throw new Error(`版が見つからない: ${values.from}`);
      }
    }
    const files = positionals.length === 0 ? changedFiles(values.from) : expandPaths(positionals);
    let count = 0;
    for (const file of files) {
      const changed = values.all ? null : changedLinesFromGit(file, values.from);
      const findings = checkSource(fs.readFileSync(file, 'utf8'), langOf(file), changed && changed.added, changed ? changed.nearDeletion : undefined);
      const label = path.relative(process.cwd(), file).split(path.sep).join('/');
      formatFindings(label, findings).forEach((l) => console.log(l));
      count += findings.length;
    }
    console.log(`${files.length} ファイル: 問題 ${count} 件`);
    process.exitCode = count > 0 ? 1 : 0;
  } catch (e) {
    console.error(e.stderr && e.stderr.length > 0 ? e.stderr.toString().trim() : e.message);
    process.exitCode = 2;
  }
}

module.exports = { formatFindings };
