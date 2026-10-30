#!/usr/bin/env node
// 使い方: node check-comments.js [--all] <file>...
// 既定では git の差分で追加された行だけを検査する。--all でファイル全体を検査する。
// 問題があれば終了コード 1 を返す。
const fs = require('fs');
const path = require('path');
const { langOf } = require('./lib/scan');
const { checkSource } = require('./lib/checks');
const { addedLinesFromGit } = require('./lib/added-lines');

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

if (require.main === module) {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const files = args.filter((a) => a !== '--all');
  let count = 0;
  for (const file of files) {
    const lang = langOf(file);
    if (!lang) continue;
    const filePath = path.resolve(file);
    const added = all ? null : addedLinesFromGit(filePath);
    const findings = checkSource(fs.readFileSync(filePath, 'utf8'), lang, added);
    formatFindings(file, findings).forEach((l) => console.log(l));
    count += findings.length;
  }
  process.exit(count > 0 ? 1 : 0);
}

module.exports = { formatFindings };
