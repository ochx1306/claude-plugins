#!/usr/bin/env node
// PreToolUse(Edit|MultiEdit|Write|NotebookEdit) hook。閉じたユニット（最新でないユニット）のファイルの書き換えを拒否する。
const fs = require('fs');
const { closedUnitOf } = require('./lib/issue');

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
const toolInput = input.tool_input || {};
const filePath = toolInput.file_path || toolInput.notebook_path;
if (!filePath) process.exit(0);

const { closed, unit, latest } = closedUnitOf(filePath);
if (!closed) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${unit} は閉じたユニットのため書き換えられない。書き換えてよいのは最新のユニット ${latest} とサマリーだけ。直す必要があれば、最新のユニットに書く`,
    },
  })
);
