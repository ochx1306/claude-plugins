const { execFileSync } = require('child_process');
const path = require('path');

/**
 * git の差分から追加された行番号を返す
 *
 * @param {string} filePath
 * @returns {Set<number>|null} git 管理外・未追跡・コミットがないときは、ファイル全体が新規なので null
 */
function addedLinesFromGit(filePath) {
  const run = (args) =>
    execFileSync('git', args, { cwd: path.dirname(filePath), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let diff;
  try {
    run(['ls-files', '--error-unmatch', path.basename(filePath)]);
    diff = run(['diff', '-U0', 'HEAD', '--', path.basename(filePath)]);
  } catch {
    return null;
  }

  const added = new Set();
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) added.add(start + i);
  }
  return added;
}

/**
 * Edit の new_string が入った行番号を返す
 *
 * @param {string} source 編集後のファイルの内容
 * @param {string[]} newStrings
 * @returns {Set<number>|undefined} new_string がファイル内に見つからないときは undefined
 */
function addedLinesFromEdits(source, newStrings) {
  const text = source.replace(/\r\n/g, '\n');
  const added = new Set();
  for (const raw of newStrings) {
    const s = raw.replace(/\r\n/g, '\n');
    if (s === '') continue;
    let idx = text.indexOf(s);
    if (idx === -1) return undefined;
    // replace_all で複数か所に入るため、すべての出現位置を対象にする
    while (idx !== -1) {
      const start = text.slice(0, idx).split('\n').length;
      const count = s.split('\n').length;
      for (let i = 0; i < count; i++) added.add(start + i);
      idx = text.indexOf(s, idx + s.length);
    }
  }
  return added;
}

module.exports = { addedLinesFromGit, addedLinesFromEdits };
