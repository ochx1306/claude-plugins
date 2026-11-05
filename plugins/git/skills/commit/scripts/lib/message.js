const path = require('path');
const vocabulary = require('../../vocabulary.json');

const FORMATS = {
  none: null,
  conventional: '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\\([^)]+\\))?!?: \\S',
  'issue-key': '^[A-Z][A-Z0-9_]*-\\d+ \\S',
};
const TITLE_PREFIX = /^([A-Z][A-Z0-9_]*-\d+\s+|[a-z]+(\([^)]+\))?!?:\s*)/;
const TRAILER = /^[A-Za-z-]+: /;
const FILE_LIKE = /(?<![\w./-])[\w.-]*(?:\/[\w.-]+)*\.[A-Za-z][\w]*(?![\w/-])|(?<![\w./-])[\w.-]+(?:\/[\w.-]+)+(?![\w/-])/g;

/**
 * 設定から書式の正規表現を返す
 *
 * @param {{format: string, pattern: string|null}} commit
 * @returns {{regex: RegExp|null, error: string|null}}
 */
function getFormat(commit) {
  const source = commit.pattern ?? FORMATS[commit.format];
  if (source === undefined) return { regex: null, error: `commit.format の ${commit.format} は使えない（none / conventional / issue-key）` };
  if (source === null) return { regex: null, error: null };
  try {
    return { regex: new RegExp(source), error: null };
  } catch {
    return { regex: null, error: `commit.pattern の ${source} は正規表現として読めない` };
  }
}

/**
 * メッセージから検査の対象の行を返す
 *
 * Co-Authored-By などのトレーラーはメッセージの内容ではないため除く。
 *
 * @param {string} message
 * @returns {string[]}
 */
function contentLines(message) {
  return message.split(/\r?\n/).filter((line) => !TRAILER.test(line));
}

/**
 * メッセージに含まれる、ファイルのパスらしい文字列を返す
 *
 * @param {string} text
 * @returns {string[]}
 */
function findFileLikeNames(text) {
  // URL、メールアドレス、ホーム配下のパスはリポジトリの中を指さないため除く
  const repoText = text.replace(/\S+:\/\/\S+/g, ' ').replace(/\S+@\S+/g, ' ').replace(/~[\\/]\S*/g, ' ');
  return [...new Set(repoText.match(FILE_LIKE) || [])];
}

/**
 * コミットメッセージの問題を返す
 *
 * errors はコミットを止める機械的な違反。warnings は誤検出を含むため、AI が内容を見て判断する。
 *
 * @param {string} message
 * @param {{commit: object, trackedPaths: string[]}} options
 * @returns {{errors: string[], warnings: string[]}}
 */
function checkMessage(message, { commit, trackedPaths }) {
  const errors = [];
  const warnings = [];
  const lines = message.replace(/\s+$/, '').split(/\r?\n/);
  const title = lines[0] || '';
  const titleBody = title.replace(TITLE_PREFIX, '');

  if (title.trim() === '') errors.push('タイトルが空');
  if (lines.length > 1 && lines[1].trim() !== '') errors.push('タイトルと本文の間に空行がない');
  if (/　/.test(title)) errors.push('タイトルに全角スペースがある');
  if (/[。.]$/.test(title)) errors.push('タイトルの末尾に句点がある');
  if (vocabulary.vagueTitles.includes(titleBody.trim().toLowerCase())) {
    errors.push(`タイトルが「${titleBody.trim()}」だけで、何が変わったかわからない`);
  }

  const format = getFormat(commit);
  if (format.error) errors.push(format.error);
  else if (format.regex && !format.regex.test(title)) errors.push(`タイトルが書式に合わない: ${format.regex.source}`);

  if ([...titleBody].length > commit.titleMaxLength) {
    warnings.push(`タイトルが ${commit.titleMaxLength} 文字を超えている`);
  }

  const content = contentLines(lines.join('\n')).join('\n');
  for (const word of vocabulary.history) {
    if (content.includes(word)) warnings.push(`経緯を書いている可能性がある語: ${word}`);
  }
  for (const word of vocabulary.externalReferences) {
    if (content.includes(word)) warnings.push(`リポジトリにないものを参照している可能性がある語: ${word}`);
  }

  const baseNames = new Set(trackedPaths.map((p) => path.posix.basename(p)));
  for (const name of findFileLikeNames(content)) {
    const normalized = name.replace(/^\.\//, '').replace(/\/$/, '');
    const ignored = commit.ignoredPaths.some((p) => normalized.startsWith(p));
    if (ignored) errors.push(`コミットしない資料を参照している: ${name}`);
    else if (!trackedPaths.includes(normalized) && !baseNames.has(normalized) && !trackedPaths.some((p) => p.startsWith(`${normalized}/`))) {
      warnings.push(`追跡されていないファイルを参照している可能性がある: ${name}`);
    }
  }

  return { errors, warnings };
}

module.exports = { getFormat, checkMessage };
