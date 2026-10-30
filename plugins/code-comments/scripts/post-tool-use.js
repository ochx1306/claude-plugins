#!/usr/bin/env node
// PostToolUse(Edit|MultiEdit|Write) hook。編集で入った行のコメントを検査し、問題があれば Claude に差し戻す。
const fs = require('fs');
const { langOf } = require('./lib/scan');
const { checkSource } = require('./lib/checks');
const { addedLinesFromGit, addedLinesFromEdits } = require('./lib/added-lines');
const { formatFindings } = require('./check-comments');

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const toolInput = input.tool_input || {};
const filePath = toolInput.file_path;
const lang = filePath && langOf(filePath);
if (!lang || !fs.existsSync(filePath)) process.exit(0);

const source = fs.readFileSync(filePath, 'utf8');
let added;
if (input.tool_name === 'Edit') {
  added = addedLinesFromEdits(source, [toolInput.new_string || '']);
} else if (input.tool_name === 'MultiEdit') {
  added = addedLinesFromEdits(source, (toolInput.edits || []).map((e) => e.new_string || ''));
}
// フォーマッターなどで new_string がそのまま残っていないときは、git の差分で代わりにする
if (added === undefined) added = addedLinesFromGit(filePath);

const findings = checkSource(source, lang, added);
if (findings.length === 0) process.exit(0);

const reason = [
  'コメントの検出スクリプトが次の箇所を報告した。誤検出もあるため、各項目を確認し、問題があるものだけ直す。',
  ...formatFindings(filePath, findings),
].join('\n');
process.stdout.write(JSON.stringify({ decision: 'block', reason }));
