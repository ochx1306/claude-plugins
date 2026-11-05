#!/usr/bin/env node
// PreToolUse(Bash|PowerShell) hook。コミットを作る git コマンドを次のように止める。
// - commit スキルの検査を通っていない git commit と、対象ファイルを明示しない git add を拒否する
// - 検査を通った git commit は、ユーザーの承認を挟んでから実行させる
// - 保護ブランチとブランチを判定できない操作も確認する
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CONFIG_PATH, loadConfig } = require('./lib/config');
const { repoRoot, currentBranch, operationInProgress, indexTree } = require('./lib/git');
const { hashFile, getRecord } = require('./lib/commit-record');

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
const BULK_ADD_ARGS = ['-A', '--all', '-u', '--update', '.', './', ':/'];
const SKILL_GUIDE = '/git:commit スキルで検査してから git commit -F <メッセージのファイル> を単独で実行する';

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
 * コマンド文字列に含まれる、確認の対象の git コマンドを返す
 *
 * cd と git -C を順に追い、実行するディレクトリを判定する。
 * 同じコマンド文字列で先にブランチを切り替えると今のブランチでは判定できないため、switched で示す。
 * 同じコマンド文字列でステージ内容を変えられると検査の結果を保証できないため、cd 以外のコマンドの有無を sole で示す。
 *
 * @param {string} command
 * @param {string} cwd
 * @returns {{commits: {subcommand: string, args: string[], dir: string|null, switched: boolean, sole: boolean}[], bulkAdds: {dir: string|null}[]}}
 */
function findTargets(command, cwd) {
  const commits = [];
  const bulkAdds = [];
  let dir = cwd;
  let switched = false;
  let otherCommands = 0;
  for (const segment of tokenize(command)) {
    const start = segment.findIndex((t) => !COMMAND_PREFIXES.includes(t) && !/^\w+=/.test(t));
    if (start === -1) continue;
    const tokens = segment.slice(start);
    const name = path.win32.basename(tokens[0]).toLowerCase();

    if (CD_COMMANDS.includes(name)) {
      const target = tokens.slice(1).filter((t) => !t.startsWith('-')).pop();
      dir = target === undefined ? null : resolveDir(dir, target);
      continue;
    }
    otherCommands++;
    if (name !== 'git' && name !== 'git.exe') continue;

    const git = parseGit(tokens, dir);
    if (git.subcommand === 'switch' || git.subcommand === 'checkout') switched = true;
    if (git.subcommand === 'rebase' && rebaseSwitchesBranch(git.args)) switched = true;
    if (git.subcommand === 'add' && git.args.some((a) => BULK_ADD_ARGS.includes(a))) bulkAdds.push({ dir: git.dir });
    if (createsCommit(git.subcommand, git.args)) commits.push({ ...git, switched });
  }
  return {
    commits: commits.map((c) => ({ ...c, sole: otherCommands === 1 })),
    bulkAdds,
  };
}

/**
 * スキルの手順で許可する git commit の引数を返す
 *
 * @param {string[]} args
 * @returns {{messageFile: string|null, amend: boolean, unknown: string[]}}
 */
function parseCommitArgs(args) {
  const parsed = { messageFile: null, amend: false, unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-F' || arg === '--file') parsed.messageFile = args[++i] ?? null;
    else if (arg.startsWith('--file=')) parsed.messageFile = arg.slice('--file='.length);
    else if (arg === '--amend') parsed.amend = true;
    else if (arg !== '-q' && arg !== '--quiet') parsed.unknown.push(arg);
  }
  return parsed;
}

/**
 * git commit が検査の記録と一致するかを判定する
 *
 * @param {{args: string[], dir: string|null, sole: boolean}} commit
 * @returns {{denied: string}|{approval: string}}
 */
function verifySkillCommit(commit) {
  if (repoRoot(commit.dir) === null) return { denied: `コミットするリポジトリを判定できない。${SKILL_GUIDE}` };
  if (!commit.sole) return { denied: `git commit を他のコマンドと続けて実行できない。${SKILL_GUIDE}` };

  const { messageFile, amend, unknown } = parseCommitArgs(commit.args);
  if (unknown.length > 0) return { denied: `git commit に ${unknown.join(' ')} を使えない。${SKILL_GUIDE}` };
  if (messageFile === null) return { denied: `メッセージのファイルの指定がない。${SKILL_GUIDE}` };

  const record = getRecord(commit.dir);
  if (record === null) return { denied: `検査の記録がない。${SKILL_GUIDE}` };
  const messagePath = resolveDir(commit.dir, messageFile);
  if (messagePath === null || hashFile(messagePath) !== record.messageHash) {
    return { denied: `メッセージが検査のあとで変わっている。${SKILL_GUIDE}` };
  }
  if (indexTree(commit.dir) !== record.tree) {
    return { denied: `ステージ内容が検査のあとで変わっている。${SKILL_GUIDE}` };
  }
  if (amend !== record.amend) return { denied: `--amend の有無が検査と違う。${SKILL_GUIDE}` };

  const warnings = record.warnings.length > 0 ? ` / 警告: ${record.warnings.join(' / ')}` : '';
  return { approval: `コミットの承認: ${record.title}（${record.fileCount} ファイル）${warnings}` };
}

/**
 * コミットを作る git コマンドに保護ブランチの確認が必要な理由を返す
 *
 * @param {{dir: string|null, switched: boolean}} commit
 * @param {{protectedBranches: string[], error: string|null}} config
 * @returns {string|null} 確認が不要なら null
 */
function protectionReason(commit, config) {
  if (config.error) return `${config.error}ため、保護ブランチを判定できない`;
  if (config.protectedBranches.length === 0) return null;
  if (commit.switched) return '同じコマンドでブランチを切り替えるため、コミット先のブランチを判定できない';
  const { branch, known } = currentBranch(commit.dir);
  if (!known) return 'コミット先のブランチを判定できない';
  if (config.protectedBranches.includes(branch)) return `${branch} は保護ブランチ（${CONFIG_PATH} の protectedBranches）`;
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

const { commits, bulkAdds } = findTargets(command, input.cwd || process.cwd());
const denials = [];
const confirmations = [];

for (const { dir } of bulkAdds) {
  if (loadConfig(repoRoot(dir)).commit.enforce) {
    denials.push('git add は対象のファイルを明示する（-A、-u、. を使わない）');
  }
}

for (const commit of commits) {
  const config = loadConfig(repoRoot(commit.dir));
  // 進行中の操作を完了するコミットのメッセージは git が用意するため、スキルを通さない
  if (commit.subcommand === 'commit' && config.commit.enforce && operationInProgress(commit.dir) === null) {
    const result = verifySkillCommit(commit);
    if (result.denied) denials.push(result.denied);
    else confirmations.push(result.approval);
  }
  const reason = protectionReason(commit, config);
  if (reason) confirmations.push(reason);
}

if (denials.length === 0 && confirmations.length === 0) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: denials.length > 0 ? 'deny' : 'ask',
      permissionDecisionReason: [...new Set(denials.length > 0 ? denials : confirmations)].join(' / '),
    },
  })
);
