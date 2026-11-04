#!/usr/bin/env node
// 使い方:
//   node format.js <PHP ファイル> [--start N] [--end N] [--write]   文字列連結の SQL を整形する。--write がなければ案だけを表示する
//   node format.js --raw                                            標準入力の SQL を整形する
//   node format.js --php [--var '$sql'] [--base-indent N]           標準入力の SQL を PHP の文字列連結に変換する
// 整形の流儀は ~/.claude/sql.json の comma・indent・padding で変える。
// 終了コード: 0 = 成功 / 2 = 失敗
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('util');
const { formatSql } = require('./lib/sql-layout');
const { findBlocks, reformatBlock, wrapLines } = require('./lib/php-blocks');

const DEFAULT_STYLE = { comma: 'trailing', indent: 4, padding: null };

/**
 * 整形の流儀を返す
 *
 * @returns {{comma: 'leading'|'trailing', indent: number, padding: number|null}}
 * @throws {Error} 設定ファイルの内容が正しくないとき
 */
function loadStyle() {
  const configPath = path.join(os.homedir(), '.claude', 'sql.json');
  if (!fs.existsSync(configPath)) return DEFAULT_STYLE;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const style = { ...DEFAULT_STYLE, ...config };
  const unknown = Object.keys(config).filter((key) => !(key in DEFAULT_STYLE));
  if (unknown.length > 0) throw new Error(`${configPath}: 不明な設定（${unknown.join(', ')}）`);
  if (!['leading', 'trailing'].includes(style.comma)) throw new Error(`${configPath}: comma は leading か trailing にする`);
  if (!Number.isInteger(style.indent) || style.indent < 1) throw new Error(`${configPath}: indent は 1 以上の整数にする`);
  if (style.padding !== null && (!Number.isInteger(style.padding) || style.padding < 0)) throw new Error(`${configPath}: padding は 0 以上の整数か null にする`);
  return style;
}

/**
 * SQL を PHP のダブルクォートの中に書ける文字列に変換する
 *
 * @param {string} line
 * @returns {string}
 */
function escapeForDoubleQuote(line) {
  return line.replace(/[\\"$]/g, '\\$&');
}

/**
 * 標準入力の SQL を整形した文字列を返す
 *
 * @param {{comma: 'leading'|'trailing', indent: number, padding: number|null}} style
 * @param {string|undefined} varName PHP の変数名。省略すると生の SQL のまま返す
 * @param {number} baseIndent PHP のコードの字下げの文字数
 * @returns {string}
 */
function formatStdin(style, varName, baseIndent) {
  const formatted = formatSql(fs.readFileSync(0, 'utf8'), style);
  if (varName === undefined) return formatted.join('\n');
  const head = { indent: ' '.repeat(baseIndent), varName, op: '=', quote: '"', eol: 'PHP_EOL' };
  return wrapLines(formatted.map(escapeForDoubleQuote), head, style.padding).join('\n');
}

/**
 * ファイルの内容を文字列に変換する
 *
 * UTF-8 以外を置換文字で読むと、書き戻したときにファイルが壊れるため失敗にする。
 *
 * @param {string} filePath
 * @returns {string}
 * @throws {Error} UTF-8 でないとき
 */
function readUtf8(filePath) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(filePath));
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`見つからない: ${filePath}`);
    throw new Error(`UTF-8 として読めないため整形しない: ${filePath}`);
  }
}

/**
 * PHP ファイルの文字列連結の SQL を整形して結果を表示し、終了コードを返す
 *
 * 失敗したブロックが 1 つでもあれば、ファイルは書き換えない。
 *
 * @param {string} filePath
 * @param {{comma: 'leading'|'trailing', indent: number, padding: number|null}} style
 * @param {{start?: string, end?: string, write: boolean}} options
 * @returns {number}
 */
function formatPhpFile(filePath, style, options) {
  const source = readUtf8(filePath);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const first = options.start ? Number(options.start) - 1 : 0;
  const last = options.end ? Number(options.end) - 1 : lines.length - 1;
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first) throw new Error('--start と --end は 1 以上の行番号にする');

  const blocks = findBlocks(lines, first, Math.min(last, lines.length - 1));
  const replacements = [];
  const counts = { changed: 0, unchanged: 0, failed: 0 };
  for (const block of blocks) {
    const label = `${filePath}:${block.start + 1}-${block.end + 1}`;
    let result;
    try {
      result = reformatBlock(block, style);
    } catch (e) {
      console.log(`[ERROR] ${label}: ${e.message}`);
      counts.failed++;
      continue;
    }
    const before = lines.slice(block.start, block.end + 1);
    if (result.lines.join('\n') === before.join('\n')) {
      counts.unchanged++;
      continue;
    }
    counts.changed++;
    replacements.push({ block, lines: result.lines });
    console.log(result.kept ? `[構造を保持] ${label}: ${result.kept}。パディングだけを直す` : `[整形] ${label}`);
    if (!options.write) {
      before.forEach((l) => console.log(`- ${l}`));
      result.lines.forEach((l) => console.log(`+ ${l}`));
    }
  }

  const written = options.write && counts.failed === 0 && replacements.length > 0;
  if (written) {
    for (const { block, lines: replaced } of [...replacements].reverse()) {
      lines.splice(block.start, block.end - block.start + 1, ...replaced);
    }
    fs.writeFileSync(filePath, lines.join(newline));
  }
  const action = written ? '書き換えた' : '書き換えていない';
  console.log(`\nブロック ${blocks.length}: 変更 ${counts.changed} / 変更なし ${counts.unchanged} / 失敗 ${counts.failed}（ファイルは${action}）`);
  return counts.failed > 0 ? 2 : 0;
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      raw: { type: 'boolean', default: false },
      php: { type: 'boolean', default: false },
      var: { type: 'string', default: '$sql' },
      'base-indent': { type: 'string', default: '0' },
      start: { type: 'string' },
      end: { type: 'string' },
      write: { type: 'boolean', default: false },
    },
  });
  const style = loadStyle();
  if (values.raw || values.php) {
    if (positionals.length > 0) throw new Error('--raw と --php は標準入力を読むため、ファイルを指定しない');
    const baseIndent = Number(values['base-indent']);
    if (!Number.isInteger(baseIndent) || baseIndent < 0) throw new Error('--base-indent は 0 以上の整数にする');
    if (values.php && !/^\$\w+$/.test(values.var)) throw new Error('--var は $sql の形にする');
    console.log(formatStdin(style, values.php ? values.var : undefined, baseIndent));
  } else {
    if (positionals.length !== 1) throw new Error('PHP ファイルを 1 つ指定するか、--raw か --php を指定する');
    process.exitCode = formatPhpFile(positionals[0], style, values);
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 2;
}
