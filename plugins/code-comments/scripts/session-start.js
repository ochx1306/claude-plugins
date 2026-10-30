#!/usr/bin/env node
// SessionStart hook の標準出力はコンテキストに追加されるため、原則の本文をそのまま出力する
const fs = require('fs');
const path = require('path');

const rulesPath = path.join(__dirname, '..', 'rules', 'comments.md');
process.stdout.write(fs.readFileSync(rulesPath, 'utf8'));
