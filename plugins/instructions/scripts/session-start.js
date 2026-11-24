#!/usr/bin/env node
// SessionStart hook の標準出力はコンテキストに追加されるため、指示の本文をそのまま出力する
const fs = require('fs');
const path = require('path');

const rulesPath = path.join(__dirname, '..', 'rules', 'instructions.md');
process.stdout.write(fs.readFileSync(rulesPath, 'utf8'));
