// ~/.claude/backlog.json の読み込み。会社のリポジトリのパスやスペースの URL を公開リポジトリに置かないため、ホームに置く。
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'backlog.json');

/**
 * ~/.claude/backlog.json の設定を返す
 *
 * @returns {{repos: string[], baseBranch?: string, space?: string, apiKey?: string, subtask?: object}} ファイルがないか読めないときは repos だけの既定値
 */
function loadConfig() {
  const defaults = { repos: [] };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return defaults;
  }
}

module.exports = { CONFIG_PATH, loadConfig };
