// ~/.claude/git.json の読み込み。会社のルールを公開リポジトリと会社のリポジトリのどちらにも置かないため、ホームに置く。
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'git.json');
const DEFAULT_COMMIT = {
  enforce: true,
  format: 'none',
  pattern: null,
  ignoredPaths: [],
  titleMaxLength: 50,
  maxFiles: 50,
};

/**
 * パスを比較できる形に変換する
 *
 * @param {string} target
 * @returns {string}
 */
function normalizePath(target) {
  const resolved = path.resolve(target.replace(/^~(?=$|[\\/])/, os.homedir()));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * リポジトリがルールの path の中にあるかを判定する
 *
 * @param {string} repoRoot
 * @param {string} rulePath
 * @returns {boolean}
 */
function isInside(repoRoot, rulePath) {
  const root = normalizePath(repoRoot);
  const rule = normalizePath(rulePath);
  return root === rule || root.startsWith(rule.endsWith(path.sep) ? rule : rule + path.sep);
}

/**
 * リポジトリに適用する設定を返す
 *
 * repos の path に一致するルールのうち最も長いものを、最上位の設定に重ねる。
 *
 * @param {string|null} repoRoot リポジトリがわからなければ null（最上位の設定だけを使う）
 * @returns {{protectedBranches: string[], commit: object, error: string|null}}
 */
function loadConfig(repoRoot) {
  const defaults = { protectedBranches: [], commit: { ...DEFAULT_COMMIT }, error: null };
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    return defaults;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...defaults, error: `${CONFIG_PATH} を JSON として読めない` };
  }
  const { repos = [] } = parsed;
  if (!Array.isArray(repos) || repos.some((r) => typeof r.path !== 'string')) {
    return { ...defaults, error: `${CONFIG_PATH} の repos は path を持つオブジェクトの配列にする` };
  }

  const rule = repoRoot === null
    ? {}
    : repos.filter((r) => isInside(repoRoot, r.path)).sort((a, b) => b.path.length - a.path.length)[0] || {};
  const protectedBranches = rule.protectedBranches ?? parsed.protectedBranches ?? [];
  if (!Array.isArray(protectedBranches)) {
    return { ...defaults, error: `${CONFIG_PATH} の protectedBranches は配列にする` };
  }
  return {
    protectedBranches,
    commit: { ...DEFAULT_COMMIT, ...parsed.commit, ...rule.commit },
    error: null,
  };
}

module.exports = { CONFIG_PATH, loadConfig };
