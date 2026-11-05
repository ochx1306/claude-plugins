const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OPERATIONS = [
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
];

/**
 * git コマンドの結果を返す
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{status: number|null, stdout: string}} cwd が存在しなければ status は null
 */
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '' };
}

/**
 * NUL 区切りで出力する git コマンドのパスの一覧を返す
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string[]}
 */
function gitPaths(args, cwd) {
  return git(args, cwd).stdout.split('\0').filter(Boolean);
}

/**
 * リポジトリのルートを返す
 *
 * @param {string|null} dir
 * @returns {string|null} リポジトリの外か dir が不明なら null
 */
function repoRoot(dir) {
  if (dir === null) return null;
  const r = git(['rev-parse', '--show-toplevel'], dir);
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * 今のブランチを返す
 *
 * @param {string|null} dir
 * @returns {{branch: string|null, known: boolean}} HEAD がブランチを指していなければ branch は null
 */
function currentBranch(dir) {
  if (dir === null) return { branch: null, known: false };
  const r = git(['symbolic-ref', '--short', '-q', 'HEAD'], dir);
  if (r.status === 0) return { branch: r.stdout.trim(), known: true };
  return { branch: null, known: r.status === 1 };
}

/**
 * .git の中のファイルの絶対パスを返す
 *
 * worktree では .git がファイルになるため、パスを git に問い合わせる。
 *
 * @param {string} dir
 * @param {string} name
 * @returns {string|null}
 */
function gitStatePath(dir, name) {
  const r = git(['rev-parse', '--git-path', name], dir);
  return r.status === 0 ? path.resolve(dir, r.stdout.trim()) : null;
}

/**
 * 進行中の merge や rebase などの操作を返す
 *
 * @param {string|null} dir
 * @returns {string|null} 進行中の操作がなければ null
 */
function operationInProgress(dir) {
  if (dir === null) return null;
  const found = OPERATIONS.find(([name]) => {
    const statePath = gitStatePath(dir, name);
    return statePath !== null && fs.existsSync(statePath);
  });
  return found ? found[1] : null;
}

/**
 * ステージ内容のツリーのハッシュを返す
 *
 * @param {string} dir
 * @returns {string|null} コンフリクトが残っていて書き出せなければ null
 */
function indexTree(dir) {
  const r = git(['write-tree'], dir);
  return r.status === 0 ? r.stdout.trim() : null;
}

module.exports = { git, gitPaths, repoRoot, currentBranch, gitStatePath, operationInProgress, indexTree };
