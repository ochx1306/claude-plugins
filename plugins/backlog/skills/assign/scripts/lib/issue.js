// 課題ディレクトリ（.claude/<課題キー>/）の構成を扱う。assign.js と、閉じたユニットを守る hook の両方から使う。
const fs = require('fs');
const path = require('path');

const SUMMARY_DIR = '00_サマリー';
const STAGES = ['要求', '調査および要件定義', '実装', 'PR本文', 'AIレビュー', '第三者テスト', '開発者確認', 'リリース後の動作確認'];
const SUMMARY_ONLY = ['進捗', 'やること'];
// サマリーへの反映漏れの判定から除くファイル。要求は Backlog から取得し、進捗とやることはユニットと関係なく更新する
const NOT_REFLECTED = ['要求', ...SUMMARY_ONLY];
const UNIT_PATTERN = /^(\d{2,})_(.+)$/;
const TEMPLATES = {
  調査および要件定義: '## 仕様の調査\n\n\n## 要件定義\n\n',
  実装: '## 概要\n\n\n## 詳細\n\n',
  PR本文: '## 概要\n\n\n## 詳細\n\n',
};
const LEGACY_CATEGORIES = ['進捗.md', '仕様の調査および要件定義.md', '実装.md', 'AIレビュー.md', '第三者テスト.md'];

/**
 * 課題ディレクトリのユニットを番号の順に返す
 *
 * @param {string} issueDir
 * @returns {{name: string, number: number, path: string}[]} サマリーは含めない
 */
function listUnits(issueDir) {
  if (!fs.existsSync(issueDir)) return [];
  return fs
    .readdirSync(issueDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== SUMMARY_DIR)
    .map((e) => ({ name: e.name, m: e.name.match(UNIT_PATTERN) }))
    .filter((e) => e.m && Number(e.m[1]) > 0)
    .map((e) => ({ name: e.name, number: Number(e.m[1]), path: path.join(issueDir, e.name) }))
    .sort((a, b) => a.number - b.number);
}

/**
 * フォルダにあるステージのファイルと、雛形のままのものを返す
 *
 * @param {string} dir
 * @param {string[]} names 対象のステージ名
 * @returns {{files: Object<string, string>, unfilled: string[], newest: number}} newest はファイルの最終更新日時の最大値
 */
function inspectStages(dir, names) {
  const files = {};
  const unfilled = [];
  let newest = 0;
  for (const name of names) {
    const file = path.join(dir, `${name}.md`);
    if (!fs.existsSync(file)) continue;
    files[name] = file;
    const content = fs.readFileSync(file, 'utf8').trim();
    if (content === '' || content === (TEMPLATES[name] || '').trim()) unfilled.push(name);
    newest = Math.max(newest, fs.statSync(file).mtimeMs);
  }
  return { files, unfilled, newest };
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
 * 古い構成（親課題.md と ver.X）の課題ディレクトリのファイルを返す
 *
 * @param {string} dir
 * @param {string[]} entries
 * @returns {Object<string, string>} カテゴリごとに、番号の大きい ver.X から遡って最初に見つかったファイル
 */
function legacyFiles(dir, entries) {
  const files = {};
  for (const name of ['親課題.md', 'やること.md']) {
    if (entries.includes(name)) files[name] = path.join(dir, name);
  }
  const versions = entries.filter((e) => /^ver\.\d+(\.\d+)*$/.test(e)).sort(compareVersionDesc);
  for (const category of LEGACY_CATEGORIES) {
    const ver = versions.find((v) => fs.existsSync(path.join(dir, v, category)));
    if (ver) files[category] = path.join(dir, ver, category);
  }
  return files;
}

/**
 * 課題ディレクトリの状態を返す
 *
 * @param {string} dir
 * @returns {object} state は missing / legacy / no-requirement / ready のいずれか
 */
function inspectIssueDir(dir) {
  if (!fs.existsSync(dir)) return { path: dir, state: 'missing' };
  const entries = fs.readdirSync(dir);
  const summaryDir = path.join(dir, SUMMARY_DIR);
  if (!entries.includes(SUMMARY_DIR) && (entries.includes('親課題.md') || entries.some((e) => e.startsWith('ver.')))) {
    return { path: dir, state: 'legacy', files: legacyFiles(dir, entries) };
  }

  const summary = { path: summaryDir, ...inspectStages(summaryDir, [...STAGES, ...SUMMARY_ONLY]) };
  const units = listUnits(dir).map((u) => {
    const stages = inspectStages(u.path, STAGES);
    return { ...u, ...stages, missing: STAGES.filter((s) => !stages.files[s]) };
  });
  const latest = units[units.length - 1] || null;
  const closed = units.slice(0, -1);

  // ユニットを閉じたらサマリーに反映するため、閉じたユニットがサマリーより新しければ反映漏れとみなす
  const reflected = inspectStages(summaryDir, STAGES.filter((s) => !NOT_REFLECTED.includes(s))).newest;
  const stale = closed.filter((u) => u.newest > reflected).map((u) => u.name);

  const result = {
    path: dir,
    state: summary.files['要求'] ? 'ready' : 'no-requirement',
    summary,
    units: units.map(({ name, files, unfilled, missing }) => ({ name, files, unfilled, missing })),
    latestUnit: latest && latest.name,
  };
  if (stale.length > 0) result.summaryStale = stale;
  return result;
}

/**
 * ファイルが閉じたユニットの中にあるかを判定する
 *
 * @param {string} filePath
 * @returns {{closed: boolean, unit?: string, latest?: string}}
 */
function closedUnitOf(filePath) {
  const parts = path.resolve(filePath).split(path.sep);
  const i = parts.lastIndexOf('.claude');
  // .claude/<課題キー>/<ユニット>/<ファイル> の形のときだけ対象にする
  if (i === -1 || parts.length < i + 4) return { closed: false };
  const unit = parts[i + 2];
  const m = unit.match(UNIT_PATTERN);
  if (!m || Number(m[1]) === 0) return { closed: false };

  const units = listUnits(parts.slice(0, i + 2).join(path.sep));
  const latest = units[units.length - 1];
  if (!latest || latest.name === unit || !units.some((u) => u.name === unit)) return { closed: false };
  return { closed: true, unit, latest: latest.name };
}

module.exports = { SUMMARY_DIR, STAGES, SUMMARY_ONLY, TEMPLATES, UNIT_PATTERN, listUnits, inspectIssueDir, closedUnitOf };
