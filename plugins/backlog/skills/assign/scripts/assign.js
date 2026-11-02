#!/usr/bin/env node
// 使い方:
//   node assign.js status [課題キー]
//     状態を集め、次の手順と AskUserQuestion の選択肢を JSON で出力する
//   node assign.js start <課題キー> [--dir-only] [--stash] [--branch <ブランチ>]
//     課題ディレクトリを作り、ブランチを準備する
//   node assign.js branch <課題キー> [--stash] [--branch <ブランチ>]
//     ブランチに切り替える。なければ origin/hotfix から作成する
//   node assign.js unset-upstream <課題キー>
//     課題ブランチの上流を外す
//   node assign.js requirement <課題キー> [--section <見出し>]
//     標準入力の親課題の本文から「## 要求」を取り出し、00_サマリー/要求.md に書き込む
//   node assign.js unit <課題キー> <くくりの名前>
//     次の番号のくくりを作り、それまでのくくりを閉じる
//   node assign.js file <課題キー> <段階> [--summary]
//     最新のくくり（--summary ならサマリー）に段階のファイルを作る
//   node assign.js find <課題キー>
//     ~/.claude/backlog.json の repos から、同じ課題ディレクトリがあるリポジトリを探す
// SKILL.md の !`...` から呼ばれ、失敗するとスキルの起動ごと止まるため、終了コードは常に 0 にする。
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SUMMARY_DIR, STAGES, SUMMARY_ONLY, TEMPLATES, listUnits, inspectIssueDir } = require('./lib/issue');

// \b は _ を単語の文字として扱い、PP-1234_PP-1235 の境界を認識しないため、前後を文字クラスで判定する
const KEY_PATTERN = /(?<![A-Za-z0-9])[A-Z][A-Z0-9_]*-[0-9]+(?![0-9])/g;
const NOT_KEY_PREFIXES = ['UTF', 'SHA', 'ISO', 'COVID', 'MD', 'RFC', 'TLS', 'SSL', 'HTTP', 'IPV'];
const BASE_BRANCH = 'hotfix';
const REQUIREMENT_SECTION = '要求';
// 親課題には Backlog 側で更新する「## 進捗」もあり、要求の候補にはならないため、見出しの選択肢から除く
const NOT_REQUIREMENT_SECTIONS = ['進捗'];

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

  const state = result.issueDir.state;
  if (state === 'missing') {
    result.next = 'ask-create';
    result.question = createQuestion(key, result.repo.name, candidates[0] || null, result.dirty.count);
    return result;
  }
  result.next = { legacy: 'summarize-legacy', 'no-requirement': 'fetch-requirement', ready: 'summarize' }[state];
  if (state === 'no-requirement') result.requirementCommand = runCommand('requirement', key);
  if (state === 'ready' && !result.issueDir.latestUnit) result.next = 'propose-unit';
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

  fs.mkdirSync(path.join(root, '.claude', key, SUMMARY_DIR), { recursive: true });
  done.push(`.claude/${key}/${SUMMARY_DIR}/ を作成`);
  const switched = opts.dirOnly ? 'ました' : `、${git(['symbolic-ref', '--short', 'HEAD'], root)} ブランチに切り替えました`;
  return {
    ok: true,
    done,
    next: 'fetch-requirement',
    requirementCommand: runCommand('requirement', key),
    message: `\`.claude/${key}/\` を作成し${switched}。`,
  };
}

/**
 * Markdown の本文から、指定した見出しのセクションの中身を返す
 *
 * @param {string} body
 * @param {string} section 見出しの文字列（## を除く）
 * @returns {string|null} 見出しがないときは null
 */
function extractSection(body, section) {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, '').trim() === section);
  if (start === -1) return null;
  // 同じ階層か上の階層の見出しが来たところで、セクションが終わる
  const end = lines.findIndex((l, i) => i > start && /^#{1,2}\s+/.test(l));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
}

/**
 * requirement サブコマンドの結果を返す
 *
 * MCP で取得した本文を渡し直さずに見出しを選び直せるよう、本文は一時ディレクトリに保存して使い回す。
 *
 * @param {string} root
 * @param {string} key
 * @param {string|undefined} section 取り出す見出し。省略時は「要求」
 * @param {string} stdin
 * @returns {object}
 */
function requirement(root, key, section, stdin) {
  const cache = path.join(os.tmpdir(), 'backlog-assign', `${key}.md`);
  let body = stdin;
  if (body.trim()) {
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, body);
  } else if (fs.existsSync(cache)) {
    body = fs.readFileSync(cache, 'utf8');
  } else {
    return { ok: false, message: '標準入力に親課題の本文がありません' };
  }

  const name = section || REQUIREMENT_SECTION;
  const content = extractSection(body, name);
  if (content === null) {
    const headings = body
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((l) => /^##\s+/.test(l))
      .map((l) => l.replace(/^##\s+/, '').trim())
      .filter((h) => !NOT_REQUIREMENT_SECTIONS.includes(h));
    // 今の課題は「## 要件」を使っていることが多いため、要件を含む見出しを先に並べる
    headings.sort((a, b) => Number(b.includes('要件')) - Number(a.includes('要件')));
    return {
      ok: false,
      next: 'ask-section',
      message: `親課題に「## ${name}」がありません`,
      question: {
        question: `${key} の親課題に「## ${name}」がありません。どのセクションを要求として使いますか？`,
        options: [
          ...headings.slice(0, 3).map((h) => ({ label: h, description: `「## ${h}」を要求として取り込む`, run: runCommand('requirement', key, '--section', h) })),
          { label: '取り込まない', description: '要求.md を作らない', run: null },
        ],
      },
    };
  }

  const dir = path.join(root, '.claude', key, SUMMARY_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '要求.md'), `${content}\n`);
  return { ok: true, done: [`親課題の「## ${name}」を .claude/${key}/${SUMMARY_DIR}/要求.md に書き込み`], next: 'propose-unit' };
}

/**
 * unit サブコマンドの結果を返す
 *
 * @param {string} root
 * @param {string} key
 * @param {string} name くくりの名前
 * @returns {object}
 */
function unit(root, key, name) {
  // Windows のファイル名に使えない文字と空白を _ にする
  const safe = (name || '').trim().replace(/[\\/:*?"<>|\s]+/g, '_');
  if (!safe) return { ok: false, message: 'くくりの名前を指定してください' };

  const issueDir = path.join(root, '.claude', key);
  const units = listUnits(issueDir);
  const previous = units[units.length - 1] || null;
  const number = (previous ? previous.number : 0) + 1;
  const dirName = `${String(number).padStart(2, '0')}_${safe}`;
  fs.mkdirSync(path.join(issueDir, dirName), { recursive: true });

  return {
    ok: true,
    done: [`.claude/${key}/${dirName}/ を作成`, ...(previous ? [`${previous.name} を閉じた（以後は書き換え禁止）`] : [])],
    unit: dirName,
    closed: previous && previous.name,
    next: previous ? 'reflect-summary' : 'write-unit',
  };
}

/**
 * file サブコマンドの結果を返す
 *
 * @param {string} root
 * @param {string} key
 * @param {string} stage 段階名
 * @param {boolean} summary true ならサマリーに作る
 * @returns {object}
 */
function stageFile(root, key, stage, summary) {
  const allowed = summary ? [...STAGES, ...SUMMARY_ONLY] : STAGES;
  if (!allowed.includes(stage)) return { ok: false, message: `「${stage}」は段階名ではありません。使える段階: ${allowed.join(' / ')}` };

  const issueDir = path.join(root, '.claude', key);
  let dir;
  if (summary) {
    dir = path.join(issueDir, SUMMARY_DIR);
  } else {
    const units = listUnits(issueDir);
    if (units.length === 0) return { ok: false, message: 'くくりがありません。先に unit でくくりを作ってください' };
    dir = units[units.length - 1].path;
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stage}.md`);
  if (fs.existsSync(file)) return { ok: true, path: file, created: false };
  fs.writeFileSync(file, TEMPLATES[stage] || '');
  return { ok: true, path: file, created: true };
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
 * @returns {{positional: string[], opts: {branch?: string, section?: string, stash?: boolean, dirOnly?: boolean, summary?: boolean}}}
 */
function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stash') opts.stash = true;
    else if (a === '--dir-only') opts.dirOnly = true;
    else if (a === '--summary') opts.summary = true;
    else if (a === '--branch') opts.branch = argv[++i];
    else if (a === '--section') opts.section = argv[++i];
    else positional.push(a.trim());
  }
  return { positional, opts };
}

/**
 * 標準入力の内容を返す
 *
 * @returns {string} 標準入力がないときは空文字列
 */
function readStdin() {
  // 選択肢の run から呼ばれたときは標準入力がなく、環境によっては読み込みが例外になる
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
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
  if (command === 'requirement') return requirement(root, key, opts.section, readStdin());
  if (command === 'unit') return unit(root, key, positional.slice(1).join(' '));
  if (command === 'file') return stageFile(root, key, positional[1], Boolean(opts.summary));
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
