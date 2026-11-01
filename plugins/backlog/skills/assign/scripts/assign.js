#!/usr/bin/env node
// 使い方:
//   node assign.js status [課題キー]
//     状態を集め、次の手順と AskUserQuestion の選択肢を JSON で出力する
//   node assign.js start <課題キー> [--dir-only] [--stash] [--branch <ブランチ>]
//     課題ディレクトリと親課題.md の雛形を作り、ブランチを準備する
//   node assign.js branch <課題キー> [--stash] [--branch <ブランチ>]
//     ブランチに切り替える。なければ origin/hotfix から作成する
//   node assign.js unset-upstream <課題キー>
//     課題ブランチの上流を外す
//   node assign.js parent <課題キー> --title <件名>
//     標準入力の課題本文を親課題.md に書き込む
//   node assign.js find <課題キー>
//     ~/.claude/backlog.json の repos から、同じ課題ディレクトリがあるリポジトリを探す
// SKILL.md の !`...` から呼ばれ、失敗するとスキルの起動ごと止まるため、終了コードは常に 0 にする。
const { execFileSync, spawnSync } = require('child_process');
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
 * 失敗時の理由も含めて git コマンドの結果を返す
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ok: boolean, output: string}}
 */
function gitRun(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
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
 * ローカルと origin のブランチ名を返す
 *
 * @param {string} root
 * @returns {{local: string[], remote: string[]}} remote は origin/ を除いた名前
 */
function listBranches(root) {
  const refs = (git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'], root) || '').split('\n');
  return {
    local: refs.filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length)),
    remote: refs
      .filter((r) => r.startsWith('refs/remotes/origin/'))
      .map((r) => r.slice('refs/remotes/origin/'.length))
      .filter((r) => r !== 'HEAD'),
  };
}

/**
 * 選択肢を選んだときに実行するコマンドを返す
 *
 * @param {...string} args assign.js に渡す引数
 * @returns {string}
 */
function runCommand(...args) {
  // Windows のパスの \ は bash で解釈が変わるため、/ にそろえる
  const script = __filename.replace(/\\/g, '/');
  return ['node', `"${script}"`, ...args.map((a) => (/[\s"<>]/.test(a) ? JSON.stringify(a) : a))].join(' ');
}

/**
 * 課題ディレクトリがないときの AskUserQuestion を生成する
 *
 * @param {string} key
 * @param {string} repoName
 * @param {string|null} existingBranch 課題キーを含む既存ブランチ
 * @param {number} dirtyCount 未コミットの変更の数
 * @returns {{question: string, options: {label: string, description: string, run: string|null}[]}}
 */
function createQuestion(key, repoName, existingBranch, dirtyCount) {
  // 未着手の課題に対する手元の変更は別課題のものである可能性が高いため、未コミットの変更があれば退避を既定にする
  const stash = dirtyCount > 0;
  const dirtyNote = stash ? `未コミットの変更が ${dirtyCount} 件あります（別課題の変更の可能性があります）。` : '';
  const branchArgs = existingBranch ? ['--branch', existingBranch] : [];
  const stashArgs = stash ? ['--stash'] : [];
  const target = existingBranch
    ? `${existingBranch} に切り替える`
    : `origin/${BASE_BRANCH} から ${key} を作成してチェックアウト`;

  return {
    question: existingBranch
      ? `${dirtyNote}${key} は ${repoName} に未着手です（ブランチ ${existingBranch} は既にあります）。ディレクトリを作成して着手しますか？`
      : `${dirtyNote}${key} は ${repoName} に未着手です。ディレクトリとブランチを作成しますか？`,
    options: [
      {
        label: stash ? 'stash して着手' : '作成して着手',
        description: `${stash ? '未コミットの変更を stash し、' : ''}.claude/${key} を作成し、${target}`,
        run: runCommand('start', key, ...branchArgs, ...stashArgs),
      },
      {
        label: 'ディレクトリのみ',
        description: 'ブランチは作らない（既存ブランチで作業する、まだ切りたくない場合）',
        run: runCommand('start', key, '--dir-only'),
      },
      { label: '作成しない', description: 'リポジトリを間違えたかもしれない。何もしない', run: null },
      { label: '他リポジトリを探す', description: '他のリポジトリに同じ課題ディレクトリがないか探す', run: runCommand('find', key) },
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
 * @returns {{action: string, question: string, options: {label: string, description: string, run: string|null}[]}}
 */
function branchQuestion(key, current, candidates, dirtyCount) {
  const dirtyNote = dirtyCount > 0 ? `未コミットの変更が ${dirtyCount} 件あります。` : '';
  const stay = { label: '今のブランチのまま', description: `${current} で作業する`, run: null };
  const withStash = (option) =>
    dirtyCount > 0
      ? [option, { label: `stash して${option.label}`, description: `未コミットの変更を stash してから${option.label}`, run: `${option.run} --stash` }]
      : [option];

  if (candidates.length === 0) {
    return {
      action: 'ask-create-branch',
      question: `${dirtyNote}${key} ブランチがありません。origin/${BASE_BRANCH} から作成しますか？`,
      options: [
        ...withStash({ label: '作成して切り替える', description: `origin/${BASE_BRANCH} から ${key} を作成する`, run: runCommand('branch', key) }),
        stay,
      ],
    };
  }
  if (candidates.length === 1) {
    return {
      action: 'ask-switch',
      question: `${dirtyNote}現在 ${current} にいます。${candidates[0]} に切り替えますか？`,
      options: [
        ...withStash({ label: '切り替える', description: `${candidates[0]} に切り替える`, run: runCommand('branch', key, '--branch', candidates[0]) }),
        stay,
      ],
    };
  }
  // AskUserQuestion の選択肢は 4 つまでのため、候補は 3 つまでにし、stash の選択肢は出さない
  return {
    action: 'ask-choose',
    question: `${dirtyNote}${key} を含むブランチが複数あります。どれで作業しますか？`,
    options: [
      ...candidates.slice(0, 3).map((b) => ({ label: b, description: `${b} に切り替える`, run: runCommand('branch', key, '--branch', b) })),
      stay,
    ],
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

  const { local, remote } = listBranches(root);
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
      result.upstreamQuestion = {
        question: `${key} の上流が ${upstream} になっています。このままだと git pull で ${upstream} の変更が混ざります。上流を外しますか？`,
        options: [
          {
            label: '外す',
            description: `git branch --unset-upstream ${key}（ローカルの設定を消すだけで、コミットは消えない）`,
            run: runCommand('unset-upstream', key),
          },
          { label: 'そのまま', description: '上流を変えない', run: null },
        ],
      };
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
    result.question = createQuestion(key, result.repo.name, candidates[0] || null, result.dirty.count);
    return result;
  }
  result.next = result.issueDir.state === 'ready' ? 'summarize' : 'ask-paste';
  if (result.next === 'ask-paste') result.pasteCommand = runCommand('parent', key, '--title', '<件名>');
  if (result.branch.onIssueBranch) {
    result.branchAction = 'none';
  } else {
    const { action, ...question } = branchQuestion(key, current, candidates, result.dirty.count);
    result.branchAction = action;
    result.branchQuestion = question;
  }
  return result;
}

/**
 * 課題ブランチへの切り替えの結果を返す
 *
 * ブランチがなければ origin/hotfix から作成する。
 *
 * @param {string} root
 * @param {string} key
 * @param {{branch?: string, stash?: boolean}} opts branch は切り替え先。省略時は課題キーと同名のブランチ
 * @returns {{ok: boolean, done: string[], message?: string}}
 */
function switchBranch(root, key, opts) {
  const done = [];
  if (opts.stash) {
    // .claude/ は git の追跡対象外で課題のメモが入っているため、stash の対象から外す
    const r = gitRun(['stash', 'push', '--include-untracked', '-m', `assign: ${key} に切り替える前の変更`, '--', '.', ':(exclude).claude'], root);
    if (!r.ok) return { ok: false, done, message: `stash に失敗しました: ${r.output}` };
    done.push(`git stash（${r.output.split('\n')[0]}）`);
  }

  const target = opts.branch || key;
  const { local, remote } = listBranches(root);
  if (local.includes(target) || remote.includes(target)) {
    const r = gitRun(['switch', target], root);
    if (!r.ok) return { ok: false, done, message: `${target} への切り替えに失敗しました: ${r.output}` };
    done.push(`git switch ${target}`);
    return { ok: true, done };
  }
  if (target !== key) return { ok: false, done, message: `ブランチ ${target} がありません` };

  // 手元の origin/hotfix が古いまま分岐すると差分が余計に乗るため、fetch してから分岐する
  const fetch = gitRun(['fetch', 'origin', BASE_BRANCH], root);
  if (!fetch.ok) return { ok: false, done, message: `git fetch origin ${BASE_BRANCH} に失敗しました: ${fetch.output}` };
  done.push(`git fetch origin ${BASE_BRANCH}`);
  // 上流が origin/hotfix になると git pull で hotfix の変更が混ざるため、--no-track で上流を付けない
  const create = gitRun(['switch', '-c', key, '--no-track', `origin/${BASE_BRANCH}`], root);
  if (!create.ok) return { ok: false, done, message: `${key} の作成に失敗しました: ${create.output}` };
  done.push(`git switch -c ${key} --no-track origin/${BASE_BRANCH}`);
  return { ok: true, done };
}

/**
 * start サブコマンドの結果を返す
 *
 * @param {string} root
 * @param {string} key
 * @param {{branch?: string, stash?: boolean, dirOnly?: boolean}} opts
 * @returns {object}
 */
function start(root, key, opts) {
  const done = [];
  if (!opts.dirOnly) {
    const r = switchBranch(root, key, opts);
    done.push(...r.done);
    if (!r.ok) return { ok: false, done, message: r.message };
  }

  const dir = path.join(root, '.claude', key);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '親課題.md');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# ${key} xxxx\n\n## 課題内容\n\n${TEMPLATE_MARK}\n\n## 補足・関連\n\n-\n`);
    done.push(`.claude/${key}/親課題.md を雛形で作成`);
  }

  const switched = opts.dirOnly ? 'ました' : `、${git(['symbolic-ref', '--short', 'HEAD'], root)} ブランチに切り替えました`;
  return {
    ok: true,
    done,
    next: 'ask-paste',
    pasteCommand: runCommand('parent', key, '--title', '<件名>'),
    message: `\`.claude/${key}/\` を作成し${switched}。Backlog の課題ページを開いて、「課題キーとタイトル」と「本文」を貼ってください。 \`親課題.md\` に保存します。`,
  };
}

/**
 * 標準入力の課題本文から親課題.md を生成する
 *
 * 親課題.md は git の追跡対象外で壊すと復元できないため、雛形のままのときだけ書き込み、記入済みなら上書きしない。
 *
 * @param {string} root
 * @param {string} key
 * @param {string|undefined} title 課題の件名
 * @param {string} body 課題の本文
 * @returns {object}
 */
function writeParent(root, key, title, body) {
  if (!title) return { ok: false, message: '--title で件名を指定してください' };
  if (!body.trim()) return { ok: false, message: '標準入力に課題の本文がありません' };

  const dir = path.join(root, '.claude', key);
  const file = path.join(dir, '親課題.md');
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(TEMPLATE_MARK)) {
    return { ok: false, message: '親課題.md は記入済みのため上書きしません。追記するときは「補足・関連」に書き足してください' };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `# ${key} ${title}\n\n## 課題内容\n\n${body.trim()}\n\n## 補足・関連\n\n-\n`);
  return { ok: true, done: [`.claude/${key}/親課題.md に書き込み`], next: 'propose' };
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

/**
 * コマンドライン引数を位置引数とオプションに分けて返す
 *
 * @param {string[]} argv
 * @returns {{positional: string[], opts: {branch?: string, title?: string, stash?: boolean, dirOnly?: boolean}}}
 */
function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stash') opts.stash = true;
    else if (a === '--dir-only') opts.dirOnly = true;
    else if (a === '--branch') opts.branch = argv[++i];
    else if (a === '--title') opts.title = argv[++i];
    else positional.push(a.trim());
  }
  return { positional, opts };
}

/**
 * サブコマンドを実行し、結果を返す
 *
 * @param {string} command
 * @param {string[]} argv
 * @returns {object}
 */
function main(command, argv) {
  const { positional, opts } = parseArgs(argv);
  const key = positional[0] || '';
  if (command === 'status') return status(key);
  if (command === 'find') return find(key);

  const root = git(['rev-parse', '--show-toplevel']);
  if (!root) return { ok: false, message: 'git リポジトリではありません' };
  if (findKeys(key)[0] !== key) return { ok: false, message: `「${key}」は課題キーではありません` };

  if (command === 'start') return start(root, key, opts);
  if (command === 'branch') return switchBranch(root, key, opts);
  if (command === 'parent') return writeParent(root, key, opts.title, fs.readFileSync(0, 'utf8'));
  if (command === 'unset-upstream') {
    const r = gitRun(['branch', '--unset-upstream', key], root);
    return r.ok ? { ok: true, done: [`git branch --unset-upstream ${key}`] } : { ok: false, message: r.output };
  }
  return { ok: false, message: `不明なサブコマンドです: ${command}` };
}

let output;
try {
  output = main(process.argv[2], process.argv.slice(3));
} catch (e) {
  output = { ok: false, next: 'error', message: e.message };
}
process.stdout.write(JSON.stringify(output, null, 2) + '\n');
