#!/usr/bin/env node
// PreToolUse(Bash|PowerShell) hook。保護ブランチにコミットを作る git コマンドを、ユーザーの確認を挟んでから実行させる。
// 保護ブランチは ~/.claude/git.json の protectedBranches で設定する。ブランチを判定できないコミットも確認する。
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'git.json');
const SEPARATORS = ';|&()\n';
const CD_COMMANDS = ['cd', 'chdir', 'pushd', 'sl', 'set-location'];
const COMMAND_PREFIXES = ['{', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'command', 'exec', 'time'];
// 値を次のトークンに取る git のグローバルオプション
const GIT_VALUE_OPTIONS = ['-c', '--exec-path', '--namespace', '--config-env'];
// 作業ディレクトリと別のリポジトリを指すため、ブランチを判定できないオプション
const GIT_REPO_OPTIONS = ['--git-dir', '--work-tree'];
const COMMIT_SUBCOMMANDS = ['commit', 'merge', 'cherry-pick', 'rebase', 'revert', 'pull', 'am'];
// 進行中の操作を取り消すか情報を表示するだけで、コミットを作らないオプション
const NO_COMMIT_OPTIONS = ['--abort', '--quit', '--edit-todo', '--show-current-patch', '--dry-run'];
// 値を次のトークンに取る git rebase のオプション
const REBASE_VALUE_OPTIONS = ['--onto', '-s', '--strategy', '-X', '--strategy-option', '-x', '--exec'];

/**
 * コマンド文字列をコマンドごとのトークン列に変換する
 *
 * ヒアドキュメントと PowerShell のヒア文字列はコミットメッセージなどの本文のため、先に削除する。
 *
 * @param {string} command
 * @returns {string[][]}
 */
function tokenize(command) {
  const source = command
    .replace(/<<-?\s*(['"]?)([\w-]+)\1[\s\S]*?\n\s*\2(?=\s|$)/g, '')
    .replace(/@'[\s\S]*?\n'@/g, "''")
    .replace(/@"[\s\S]*?\n"@/g, "''");

  const segments = [];
  let tokens = [];
  let token = null;
  let quote = null;
  const endToken = () => {
    if (token !== null) tokens.push(token);
    token = null;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && source[i + 1] === '"') {
        token += '"';
        i++;
      } else if (ch === quote) {
        quote = null;
      } else {
        token += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      token = token ?? '';
    } else if (SEPARATORS.includes(ch)) {
      endSegment();
    } else if (/\s/.test(ch)) {
      endToken();
    } else {
      token = (token ?? '') + ch;
    }
  }
  endSegment();
  return segments;
}

/**
 * パスを現在のディレクトリからの絶対パスに変換する
 *
 * Git Bash の /c/dev 形式は Node と git.exe が解釈できないため、Windows では C:/dev 形式に変換する。
 *
 * @param {string|null} dir 基準のディレクトリ。不明なら null
 * @param {string} target
 * @returns {string|null} 基準が不明なら null（target が絶対パスなら target の絶対パス）
 */
function resolveDir(dir, target) {
  let native = target.replace(/^~(?=$|[\\/])/, os.homedir());
  if (process.platform === 'win32') native = native.replace(/^\/([a-zA-Z])(?=$|\/)/, '$1:');
  if (path.isAbsolute(native)) return path.resolve(native);
  return dir === null ? null : path.resolve(dir, native);
}

/**
 * git コマンドのサブコマンドと実行ディレクトリを返す
 *
 * @param {string[]} tokens
 * @param {string|null} dir
 * @returns {{subcommand: string|undefined, args: string[], dir: string|null}}
 */
function parseGit(tokens, dir) {
  let gitDir = dir;
  let i = 1;
  for (; i < tokens.length && tokens[i].startsWith('-'); i++) {
    const option = tokens[i];
    if (option === '-C') {
      i++;
      gitDir = tokens[i] === undefined ? null : resolveDir(gitDir, tokens[i]);
    } else if (GIT_REPO_OPTIONS.some((o) => option === o || option.startsWith(`${o}=`))) {
      gitDir = null;
      if (GIT_REPO_OPTIONS.includes(option)) i++;
    } else if (GIT_VALUE_OPTIONS.includes(option)) {
      i++;
    }
  }
  return { subcommand: tokens[i], args: tokens.slice(i + 1), dir: gitDir };
}

/**
 * git コマンドがコミットを作るかを判定する
 *
 * git merge --no-commit は fast-forward ならブランチを進めるため、--no-ff もあるときだけ対象から外す。
 *
 * @param {string|undefined} subcommand
 * @param {string[]} args
 * @returns {boolean}
 */
function createsCommit(subcommand, args) {
  if (!COMMIT_SUBCOMMANDS.includes(subcommand)) return false;
  if (subcommand === 'commit') return true;
  if (args.some((a) => NO_COMMIT_OPTIONS.includes(a))) return false;
  if (subcommand === 'merge') return !(args.includes('--squash') || (args.includes('--no-commit') && args.includes('--no-ff')));
  if (subcommand === 'cherry-pick' || subcommand === 'revert') return !(args.includes('-n') || args.includes('--no-commit'));
  return true;
}

/**
 * git rebase が引数のブランチに切り替えるかを判定する
 *
 * @param {string[]} args
 * @returns {boolean} git rebase <upstream> <branch> の形なら true
 */
function rebaseSwitchesBranch(args) {
  const positional = args.filter((a, i) => !a.startsWith('-') && !REBASE_VALUE_OPTIONS.includes(args[i - 1]));
  return positional.length >= 2;
}

/**
 * コマンド文字列に含まれる、コミットを作る git コマンドを返す
 *
 * cd と git -C を順に追い、コミットするディレクトリを判定する。
 * 同じコマンド文字列で先にブランチを切り替えると今のブランチでは判定できないため、switched で示す。
 *
 * @param {string} command
 * @param {string} cwd
 * @returns {{dir: string|null, switched: boolean}[]}
 */
function findCommits(command, cwd) {
  const commits = [];
  let dir = cwd;
  let switched = false;
  for (const segment of tokenize(command)) {
    const start = segment.findIndex((t) => !COMMAND_PREFIXES.includes(t) && !/^\w+=/.test(t));
    if (start === -1) continue;
    const tokens = segment.slice(start);
    const name = path.win32.basename(tokens[0]).toLowerCase();

    if (CD_COMMANDS.includes(name)) {
      const target = tokens.slice(1).filter((t) => !t.startsWith('-')).pop();
      dir = target === undefined ? null : resolveDir(dir, target);
    } else if (name === 'git' || name === 'git.exe') {
      const git = parseGit(tokens, dir);
      if (git.subcommand === 'switch' || git.subcommand === 'checkout') switched = true;
      if (git.subcommand === 'rebase' && rebaseSwitchesBranch(git.args)) switched = true;
      if (createsCommit(git.subcommand, git.args)) commits.push({ dir: git.dir, switched });
    }
  }
  return commits;
}

/**
 * 保護ブランチの一覧を返す
 *
 * @returns {string[]|null} 設定ファイルがなければ空の配列。読めない内容なら null
 */
function loadProtectedBranches() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    return [];
  }
  try {
    const { protectedBranches = [] } = JSON.parse(raw);
    return Array.isArray(protectedBranches) ? protectedBranches : null;
  } catch {
    return null;
  }
}

/**
 * 今のブランチを返す
 *
 * @param {string|null} dir
 * @returns {{branch: string|null, known: boolean}} HEAD がブランチを指していなければ branch は null
 */
function currentBranch(dir) {
  if (dir === null) return { branch: null, known: false };
  const r = spawnSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  if (r.status === 0) return { branch: r.stdout.trim(), known: true };
  return { branch: null, known: r.status === 1 };
}

/**
 * コミットを作る git コマンドに確認が必要な理由を返す
 *
 * @param {{dir: string|null, switched: boolean}} commit
 * @param {string[]} protectedBranches
 * @returns {string|null} 確認が不要なら null
 */
function confirmationReason(commit, protectedBranches) {
  if (commit.switched) return '同じコマンドでブランチを切り替えるため、コミット先のブランチを判定できない';
  const { branch, known } = currentBranch(commit.dir);
  if (!known) return 'コミット先のブランチを判定できない';
  if (protectedBranches.includes(branch)) return `${branch} は保護ブランチ（${CONFIG_PATH} の protectedBranches）`;
  return null;
}

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
const command = (input.tool_input || {}).command;
if (typeof command !== 'string') process.exit(0);

const commits = findCommits(command, input.cwd || process.cwd());
if (commits.length === 0) process.exit(0);

const protectedBranches = loadProtectedBranches();
let reasons;
if (protectedBranches === null) {
  reasons = [`${CONFIG_PATH} を読めないため、保護ブランチを判定できない`];
} else if (protectedBranches.length === 0) {
  process.exit(0);
} else {
  reasons = commits.map((c) => confirmationReason(c, protectedBranches)).filter(Boolean);
}
if (reasons.length === 0) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: [...new Set(reasons)].join(' / '),
    },
  })
);
