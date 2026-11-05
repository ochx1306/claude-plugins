// commit スキルの検査結果の記録。検査したメッセージとステージ内容のままコミットされることを、hook が確かめるために使う。
const crypto = require('crypto');
const fs = require('fs');
const { gitStatePath } = require('./git');

const RECORD_FILE = 'claude-commit-check.json';

/**
 * ファイルの内容のハッシュを返す
 *
 * @param {string} filePath
 * @returns {string|null} 読めなければ null
 */
function hashFile(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * 検査の記録を .git に追加する
 *
 * @param {string} dir
 * @param {{messageHash: string, tree: string, amend: boolean, title: string, fileCount: number, warnings: string[]}} record
 */
function addRecord(dir, record) {
  fs.writeFileSync(gitStatePath(dir, RECORD_FILE), JSON.stringify(record));
}

/**
 * 検査の記録を削除する
 *
 * @param {string} dir
 */
function deleteRecord(dir) {
  fs.rmSync(gitStatePath(dir, RECORD_FILE), { force: true });
}

/**
 * 検査の記録を返す
 *
 * @param {string} dir
 * @returns {object|null} 記録がなければ null
 */
function getRecord(dir) {
  try {
    return JSON.parse(fs.readFileSync(gitStatePath(dir, RECORD_FILE), 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { hashFile, addRecord, deleteRecord, getRecord };
