#!/usr/bin/env node
// 使い方:
//   node commit.js status
//     ステージ内容と未追跡ファイルの状況、適用される設定を JSON で出力する
//   node commit.js check --message <ファイル> [--amend]
//     メッセージとステージ内容を検査し、結果を JSON で出力する。errors がなければ記録を残し、hook が git commit を通す
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../../../scripts/lib/config');
const { git, gitPaths, repoRoot, currentBranch, operationInProgress, indexTree } = require('../../../scripts/lib/git');
const { hashFile, addRecord, deleteRecord } = require('../../../scripts/lib/commit-record');
const { getFormat, checkMessage } = require('./lib/message');

const ISSUE_KEY = /(?<![A-Za-z0-9])[A-Z][A-Z0-9_]*-[0-9]+(?![0-9])/g;
const SENSITIVE = /(^|\/)(\.env(?!\.(example|sample|template)$)(\.[^/]+)?|id_rsa|id_ed25519|credentials[^/]*|secrets?[^/]*|[^/]+\.(pem|key|p12|pfx))$/i;
const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|dist\/|build\/|vendor\/|[^/]+\.min\.(js|css)$)/;
// git の空のツリーのハッシュ。親のないコミットの比較先に使う
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * パスの一覧を、コミットの判断に関わる種類ごとに分けて返す
 *
 * @param {string[]} paths
 * @param {string[]} ignoredPaths
 * @returns {{sensitive: string[], generated: string[], ignored: string[], gitignore: string[]}}
 */
function classifyPaths(paths, ignoredPaths) {
  return {
    sensitive: paths.filter((p) => SENSITIVE.test(p)),
    generated: paths.filter((p) => GENERATED.test(p)),
    ignored: paths.filter((p) => ignoredPaths.some((i) => p.startsWith(i))),
    gitignore: paths.filter((p) => path.posix.basename(p) === '.gitignore'),
  };
}

/**
 * ブランチ名と資料のディレクトリから、課題キーの候補を返す
 *
 * @param {string} root
 * @param {string|null} branch
 * @param {string[]} ignoredPaths
 * @returns {{branch: string[], directories: string[]}}
 */
function findIssueKeys(root, branch, ignoredPaths) {
  const directories = ignoredPaths.flatMap((dir) => {
    try {
      return fs.readdirSync(path.join(root, dir)).filter((name) => (name.match(ISSUE_KEY) || [])[0] === name);
    } catch {
      return [];
    }
  });
  return { branch: (branch || '').match(ISSUE_KEY) || [], directories };
}

/**
 * ステージ内容と未追跡ファイルの状況を返す
 *
 * @param {string} root
 * @returns {object}
 */
function getStatus(root) {
  const config = loadConfig(root);
  const { branch } = currentBranch(root);
  const staged = gitPaths(['diff', '--cached', '--name-only', '--no-renames', '-z'], root);
  const untracked = gitPaths(['ls-files', '--others', '--exclude-standard', '-z'], root);
  const format = getFormat(config.commit);
  return {
    repo: root,
    branch,
    detached: branch === null,
    protectedBranch: config.protectedBranches.includes(branch),
    operation: operationInProgress(root),
    configError: config.error || format.error,
    format: format.regex ? format.regex.source : null,
    ignoredPaths: config.commit.ignoredPaths,
    issueKeys: config.commit.format === 'issue-key' ? findIssueKeys(root, branch, config.commit.ignoredPaths) : null,
    staged,
    stagedSignals: classifyPaths(staged, config.commit.ignoredPaths),
    unstaged: gitPaths(['diff', '--name-only', '-z'], root),
    untracked,
    untrackedSignals: classifyPaths(untracked, config.commit.ignoredPaths),
    recentSubjects: git(['log', '--format=%s', '-10'], root).stdout.split('\n').filter(Boolean),
  };
}

/**
 * メッセージとステージ内容の問題を返す
 *
 * @param {string} root
 * @param {string} message
 * @param {boolean} amend
 * @returns {{errors: string[], warnings: string[], staged: string[], unstaged: string[], untracked: string[], tree: string|null}}
 */
function inspect(root, message, amend) {
  const config = loadConfig(root);
  const staged = gitPaths(['diff', '--cached', '--name-only', '--no-renames', '-z'], root);
  const tracked = gitPaths(['ls-files', '-z'], root);
  const { errors, warnings } = checkMessage(message, {
    commit: config.commit,
    trackedPaths: [...new Set([...tracked, ...staged])],
  });
  const signals = classifyPaths(staged, config.commit.ignoredPaths);
  const tree = indexTree(root);

  if (config.error) errors.push(config.error);
  if (tree === null) errors.push('コンフリクトが残っている');
  if (staged.length === 0 && !amend) errors.push('ステージされたファイルがない');
  if (signals.ignored.length > 0) errors.push(`コミットしない資料がステージされている: ${signals.ignored.join(', ')}`);

  if (operationInProgress(root)) warnings.push(`${operationInProgress(root)} の途中`);
  if (currentBranch(root).branch === null) warnings.push('HEAD がブランチを指していない');
  if (signals.sensitive.length > 0) warnings.push(`機密の可能性があるファイルがステージされている: ${signals.sensitive.join(', ')}`);
  if (signals.gitignore.length > 0 && staged.length > signals.gitignore.length) warnings.push('.gitignore の変更と他の変更が同じコミットにある');
  if (signals.generated.length > 0 && staged.length > signals.generated.length) warnings.push(`生成物やロックファイルと実装の変更が同じコミットにある: ${signals.generated.join(', ')}`);
  if (staged.length >= config.commit.maxFiles) warnings.push(`ファイル数が ${config.commit.maxFiles} 以上（${staged.length}）`);
  if (amend && git(['branch', '-r', '--contains', 'HEAD'], root).stdout.trim() !== '') {
    warnings.push('push 済みのコミットを --amend しようとしている');
  }

  return {
    errors,
    warnings,
    staged,
    unstaged: gitPaths(['diff', '--name-only', '-z'], root),
    untracked: gitPaths(['ls-files', '--others', '--exclude-standard', '-z'], root),
    tree,
  };
}

/**
 * --amend で作り直したあとのコミットに含まれるファイルの数を返す
 *
 * @param {string} root
 * @returns {number}
 */
function getAmendedFileCount(root) {
  const base = git(['rev-parse', '-q', '--verify', 'HEAD~1'], root).status === 0 ? 'HEAD~1' : EMPTY_TREE;
  return gitPaths(['diff', '--cached', '--name-only', '--no-renames', '-z', base], root).length;
}

/**
 * メッセージとステージ内容の検査の結果を返す
 *
 * 問題がなければ、hook が照合する記録を残す。
 *
 * @param {string} root
 * @param {string} messageFile
 * @param {boolean} amend
 * @returns {object}
 */
function runCheck(root, messageFile, amend) {
  deleteRecord(root);
  const messageHash = hashFile(messageFile);
  if (messageHash === null) return { ok: false, errors: [`${messageFile} を読めない`], warnings: [] };

  const message = fs.readFileSync(messageFile, 'utf8');
  const { tree, ...result } = inspect(root, message, amend);
  const ok = result.errors.length === 0;
  if (ok) {
    addRecord(root, {
      messageHash,
      tree,
      amend,
      title: message.split(/\r?\n/)[0],
      fileCount: amend ? getAmendedFileCount(root) : result.staged.length,
      warnings: result.warnings,
    });
  }
  return { ok, ...result };
}

const [subcommand, ...args] = process.argv.slice(2);
const root = repoRoot(process.cwd());
let output;
if (root === null) {
  output = { ok: false, errors: ['git リポジトリの中で実行する'], warnings: [] };
} else if (subcommand === 'status') {
  output = getStatus(root);
} else if (subcommand === 'check' && args.includes('--message') && args[args.indexOf('--message') + 1]) {
  output = runCheck(root, path.resolve(args[args.indexOf('--message') + 1]), args.includes('--amend'));
} else {
  output = { ok: false, errors: ['使い方: commit.js status | commit.js check --message <ファイル> [--amend]'], warnings: [] };
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
