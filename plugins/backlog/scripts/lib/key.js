// Backlog の課題キー（PP-1234）の検出。
// \b は _ を単語の文字として扱い、PP-1234_PP-1235 の境界を認識しないため、前後を文字クラスで判定する
const KEY_PATTERN = /(?<![A-Za-z0-9])[A-Z][A-Z0-9_]*-[0-9]+(?![0-9])/g;
const NOT_KEY_PREFIXES = ['UTF', 'SHA', 'ISO', 'COVID', 'MD', 'RFC', 'TLS', 'SSL', 'HTTP', 'IPV'];

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
 * 文字列が課題キーそのものかを判定する
 *
 * @param {string} text
 * @returns {boolean}
 */
function isKey(text) {
  const keys = findKeys(text);
  return keys.length === 1 && keys[0] === text;
}

module.exports = { findKeys, isKey };
