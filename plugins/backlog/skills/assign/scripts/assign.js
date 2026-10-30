#!/usr/bin/env node
// 使い方:
//   node assign.js status [課題キー]  状態を集め、次の手順と AskUserQuestion の選択肢を JSON で出力する
//   node assign.js find <課題キー>    ~/.claude/backlog.json の repos から、同じ課題ディレクトリがあるリポジトリを探す
// SKILL.md の !`...` から呼ばれ、失敗するとスキルの起動ごと止まるため、終了コードは常に 0 にする。
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// \b は _ を単語の文字として扱い、PP-1234_PP-1235 の境界を認識しないため、前後を文字クラスで判定する
const KEY_PATTERN = /(?<![A-Za-z0-9])[A-Z][A-Z0-9_]*-[0-9]+(?![0-9])/g;
const NOT_KEY_PREFIXES = ['UTF', 'SHA', 'ISO', 'COVID', 'MD', 'RFC', 'TLS', 'SSL', 'HTTP', 'IPV'];
const CATEGORIES = ['進捗.md', '仕様の調査および要件定義.md', '実装.md', 'AIレビュー.md', '第三者テスト.md'];
const TEMPLATE_MARK = '（Backlog からコピペ）';
const BASE_BRANCH = 'hotfix';

/**
 * ~/.claude/backlog.json の設定を返す
 *
 * 会社のリポジトリのパスは公開リポジトリに置けないため、プラグインの外の設定ファイルから読む。
 *
 * @returns {{repos: string[]}}
 */
function loadConfig() {
  const defaults = { repos: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'backlog.json'), 'utf8'));
    return { ...defaults, ...raw };
  } catch {
    return defaults;
  }
}

/**
 * git コマンドの標準出力を返す
 *
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {string|null} 失敗したときは null
 */
function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * 文字列に含まれる課題キーを返す
 *
 * @param {string} text
 * @returns {string[]} 出現順
 */
function findKeys(text) {
  return (text.match(KEY_PATTERN) || []).filter((k) => !NOT_KEY_PREFIXES.includes(k.split('-')[0]));
}

/**
 * ブランチ名に課題キーが含まれるかを判定する
 *
 * PP-1234 が PP-12345 に部分一致しないよう、前後が _ か / か端であることを条件にする。
 *
 * @param {string} branch
 * @param {string} key
 * @returns {boolean}
 */
function branchHasKey(branch, key) {
  return new RegExp(`(^|[_/])${key}([_/]|$)`).test(branch);
}

/**
 * ver.X フォルダを番号の大きい順に並べるための比較結果を返す
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} a が新しければ負の数
 */
function compareVersionDesc(a, b) {
  const pa = a.slice(4).split('.').map(Number);
  const pb = b.slice(4).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 課題ディレクトリの状態と、カテゴリごとの最新ファイルを返す
 *
 * @param {string} dir
 * @returns {{path: string, state: 'missing'|'empty'|'template'|'ready', files: Object<string, string>}}
 */
function inspectIssueDir(dir) {
  if (!fs.existsSync(dir)) return { path: dir, state: 'missing', files: {} };
  const entries = fs.readdirSync(dir);
  if (entries.length === 0) return { path: dir, state: 'empty', files: {} };

  const files = {};
  for (const name of ['親課題.md', 'やること.md']) {
    if (entries.includes(name)) files[name] = path.join(dir, name);
  }
  // カテゴリごとに版数を持たないため、番号の大きい ver.X から遡って最初に見つかったものを最新とする
  const versions = entries.filter((e) => /^ver\.\d+(\.\d+)*$/.test(e)).sort(compareVersionDesc);
  for (const category of CATEGORIES) {
    const ver = versions.find((v) => fs.existsSync(path.join(dir, v, category)));
    if (ver) files[category] = path.join(dir, ver, category);
  }

  const parent = files['親課題.md'] && fs.readFileSync(files['親課題.md'], 'utf8');
  const state = !parent || parent.includes(TEMPLATE_MARK) ? 'template' : 'ready';
  return { path: dir, state, files };
}

/**
 * 課題ディレクトリがないときの AskUserQuestion を生成する
 *
 * @param {string} key
 * @param {string} repoName
 * @param {string|null} existingBranch 課題キーを含む既存ブランチ
 * @returns {{question: string, options: {label: string, description: string}[]}}
 */
function createQuestion(key, repoName, existingBranch) {
  const notCreate = { label: '作成しない', description: 'リポジトリを間違えたかもしれない。何もしない' };
  const findOther = { label: '他リポジトリを探す', description: '他のリポジトリに同じ課題ディレクトリがないか探す' };
  if (existingBranch) {
    return {
      question: `${key} は ${repoName} に未着手です（ブランチ ${existingBranch} は既にあります）。ディレクトリを作成して着手しますか？`,
      options: [
        { label: '作成して着手', description: `.claude/${key} を作成し、${existingBranch} に切り替える` },
        notCreate,
        findOther,
      ],
    };
  }
  return {
    question: `${key} は ${repoName} に未着手です。ディレクトリとブランチを作成しますか？`,
    options: [
      { label: '作成して着手', description: `.claude/${key} を作成し、origin/${BASE_BRANCH} から ${key} を作成してチェックアウト` },
      { label: 'ディレクトリのみ', description: 'ブランチは作らない（既存ブランチで作業する、まだ切りたくない場合）' },
      notCreate,
      findOther,
    ],
  };
}

/**
 * 課題ブランチに切り替えるための AskUserQuestion を生成する
 *
 * @param {string} key
 * @param {string} current 現在のブランチ
 * @param {string[]} candidates 課題キーを含むブランチ
 * @param {number} dirtyCount 未コミットの変更の数
 * @returns {{action: string, question: string, options: {label: string, description: string}[]}}
 */
function branchQuestion(key, current, candidates, dirtyCount) {
  const dirtyNote = dirtyCount > 0 ? `未コミットの変更が ${dirtyCount} 件あります。` : '';
  const stay = { label: '今のブランチのまま', description: `${current} で作業する` };
  const stash = dirtyCount > 0 ? [{ label: 'stash して切り替える', description: '未コミットの変更を git stash で退避してから切り替える' }] : [];

  if (candidates.length === 0) {
    return {
      action: 'ask-create-branch',
      question: `${dirtyNote}${key} ブランチがありません。origin/${BASE_BRANCH} から作成しますか？`,
      options: [{ label: '作成して切り替える', description: `origin/${BASE_BRANCH} から ${key} を作成する` }, ...stash, stay],
    };
  }
  if (candidates.length === 1) {
    return {
      action: 'ask-switch',
      question: `${dirtyNote}現在 ${current} にいます。${candidates[0]} に切り替えますか？`,
      options: [{ label: '切り替える', description: `git switch ${candidates[0]}` }, ...stash, stay],
    };
  }
  // AskUserQuestion の選択肢は 4 つまでのため、候補は 3 つまでにする
  return {
    action: 'ask-choose',
    question: `${dirtyNote}${key} を含むブランチが複数あります。どれで作業しますか？`,
    options: [...candidates.slice(0, 3).map((b) => ({ label: b, description: `git switch ${b}` })), stay],
  };
}

/**
 * status サブコマンドの結果を返す
 *
 * @param {string} arg 課題キーの引数。ない場合は空文字列
 * @returns {object}
 */
function status(arg) {
  const root = git(['rev-parse', '--show-toplevel']);
  if (!root) return { next: 'stop-not-git', message: 'git リポジトリではありません' };

  const current = git(['symbolic-ref', '--short', 'HEAD'], root) || 'HEAD';
  const result = { repo: { root, name: path.basename(root) }, branch: { current } };

  let key = null;
  if (arg) {
    const keys = findKeys(arg);
    if (keys.length !== 1 || keys[0] !== arg) {
      return { ...result, next: 'invalid-key', message: `「${arg}」は課題キーではありません。課題キーを確認してください` };
    }
    key = arg;
    result.keySource = 'argument';
  } else {
    // 複合名（PP-1234_PP-1235）は先頭の課題キーを使う
    key = findKeys(current)[0] || null;
    result.keySource = key ? 'branch' : null;
  }
  if (!key) return { ...result, next: 'ask-key', message: `ブランチ ${current} から課題キーを検出できませんでした` };
  result.key = key;

  const dirtyFiles = (git(['status', '--porcelain'], root) || '').split('\n').filter((l) => l && !l.slice(3).startsWith('.claude/'));
  result.dirty = { count: dirtyFiles.length, files: dirtyFiles.slice(0, 20) };

  const refs = (git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'], root) || '').split('\n');
  const local = refs.filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length));
  const remote = refs.filter((r) => r.startsWith('refs/remotes/origin/')).map((r) => r.slice('refs/remotes/origin/'.length)).filter((r) => r !== 'HEAD');
  const localMatches = local.filter((b) => branchHasKey(b, key));
  const remoteMatches = remote.filter((b) => branchHasKey(b, key));
  // リモートにだけあるブランチも git switch で同名のローカルブランチになるため、候補に含める
  const candidates = [...new Set([...localMatches, ...remoteMatches])];
  Object.assign(result.branch, {
    onIssueBranch: branchHasKey(current, key),
    local: localMatches,
    remoteOnly: remoteMatches.filter((b) => !localMatches.includes(b)),
  });

  if (local.includes(key)) {
    const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${key}@{upstream}`], root);
    result.branch.upstream = upstream;
    if (upstream && upstream !== `origin/${key}`) {
      result.branch.upstreamWarning = `${key} の上流が ${upstream} になっている。git pull で ${upstream} の変更が混ざるため、git branch --unset-upstream ${key} で外す`;
    }
  }

  const logBranch = result.branch.onIssueBranch ? current : localMatches[0];
  if (logBranch) result.log = (git(['log', '--oneline', '-10', logBranch], root) || '').split('\n').filter(Boolean);

  const claudeDir = path.join(root, '.claude');
  result.issueDir = inspectIssueDir(path.join(claudeDir, key));
  if (fs.existsSync(claudeDir)) {
    result.otherIssueDirs = fs
      .readdirSync(claudeDir)
      .filter((d) => d !== key && findKeys(d)[0] === d)
      .map((d) => ({ d, t: fs.statSync(path.join(claudeDir, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 10)
      .map((x) => x.d);
  }

  if (result.issueDir.state === 'missing') {
    result.next = 'ask-create';
    result.question = createQuestion(key, result.repo.name, candidates[0] || null);
    return result;
  }
  result.next = result.issueDir.state === 'ready' ? 'summarize' : 'ask-paste';
  if (!result.branch.onIssueBranch) {
    const { action, ...question } = branchQuestion(key, current, candidates, result.dirty.count);
    result.branchAction = action;
    result.branchQuestion = question;
  } else {
    result.branchAction = 'none';
  }
  return result;
}

/**
 * find サブコマンドの結果を返す
 *
 * @param {string} key
 * @returns {object}
 */
function find(key) {
  const { repos } = loadConfig();
  if (repos.length === 0) {
    return { found: [], message: '~/.claude/backlog.json に repos が設定されていません（例: {"repos": ["C:/path/to/repo"]}）' };
  }
  return { found: repos.filter((r) => fs.existsSync(path.join(r, '.claude', key))), searched: repos };
}

const [command, arg = ''] = process.argv.slice(2);
let output;
try {
  output = command === 'find' ? find(arg.trim()) : status(arg.trim());
} catch (e) {
  output = { next: 'error', message: e.message };
}
process.stdout.write(JSON.stringify(output, null, 2) + '\n');
