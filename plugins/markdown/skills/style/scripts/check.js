#!/usr/bin/env node
// 使い方: node check.js [--no-h1] [<file>...]
// ファイルを指定しないか - を指定したときは標準入力を検査する。
// 既定では先頭の H1 を 1 つだけ認める。--no-h1 では H1 をすべて検出する（frontmatter があるときも同じ）。
// リンク先のファイルは検査するファイルからの相対パスで確かめる。標準入力では同じ文書内のアンカーだけを確かめる。
// 問題があれば終了コード 1 を返す。
const fs = require('fs');
const path = require('path');

// リストの中のコードブロックは深く字下げされるため、字下げの幅は問わない
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const INDENTED_CODE = /^(?: {4}|\t)/;
const MATH_FENCE = /^\s*\$\$\s*$/;
// 区切りの ` の数が同じものだけを対にする。空行をまたぐものは段落が違うので対にしない
const INLINE_CODE = /(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g;
const CODE_MARK = '\u0001';
const ATX_HEADING = /^ {0,3}(#{1,6})(?:\s|$)/;
const SETEXT_H1 = /^ {0,3}=+\s*$/;
const THEMATIC_BREAK = /^ {0,3}([*_-])(?:\s*\1){2,}\s*$/;
const LINK_REFERENCE = /^ {0,3}\[[^\]]+\]:\s/;
// [a](b) と、画像を入れ子にした [![a](b)](c) の両方のリンク先を拾うため、](  から読む
const LINK_DEST = /(?<!\\)\]\(\s*(<[^>]*>|(?:[^()\s]|\([^()\s]*\))*)/g;
const REFERENCE_DEST = /^ {0,3}\[(?!\^)[^\]]+\]:\s+(<[^>]*>|\S+)/;
// スキームのある URL と、/ で始まるパスは表示する環境で解決先が変わるため確かめない
const UNCHECKED_DEST = /^(?:[a-z][a-z0-9+.-]*:|\/)/i;
const MARKDOWN_FILE = /\.(?:md|markdown)$/i;
// 行番号へのリンク（#L10、#L10-L20）と #top は見出しがなくても有効
const SPECIAL_ANCHOR = /^(?:L\d+(?:-L\d+)?|top)$/i;
const BLOCK_MARKER = /^\s*(?:>\s*)*(?:(?:[*+-]|\d+[.)])\s+)?/;
const DEFINITION = /^ {0,3}:\s+\S/;
const LIST_ITEM = /^(\s*)(?:[*+-]|\d+[.)])\s+(.*)$/;
const GITHUB_ALERT = /^\s*>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;
const JAPANESE = /[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}、。「」]/u;
const QUOTED = /"[^"]*"|“[^”]*”/g;
// 句読点と括弧は隣にスペースを入れないため、かなと漢字だけにする
const JP = '[\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Han}ー々]';
// 「AIが1行」の「が」のように 1 文字が 2 か所に関わるため、先読みで重ねて拾う
const NO_SPACE = new RegExp(`(?=(${JP}[A-Za-z0-9\\u0001]|[A-Za-z0-9\\u0001]${JP}))`, 'gu');
const UI_LABEL = /\[[^\]\n]+\](?![(\[:])/g;

/**
 * コードブロック・<pre>・数式ブロックの行を返す
 *
 * @param {string[]} lines
 * @param {number} start 検査を始める行の添字
 * @returns {{code: boolean[], fences: Map<number, boolean>, unclosed: number}}
 *   fences: 開始行の添字と、言語を指定しているか。unclosed: 閉じていないコードブロックの開始行の添字（なければ -1）
 */
function findCodeLines(lines, start) {
  const code = lines.map(() => false);
  const fences = new Map();
  let fence = null;
  let fenceStart = -1;
  let blockEnd = null;
  let inList = false;
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i];
    if (fence) {
      code[i] = true;
      const m = raw.match(FENCE);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && m[2].trim() === '') fence = null;
      continue;
    }
    if (blockEnd) {
      code[i] = true;
      if (blockEnd.test(raw)) blockEnd = null;
      continue;
    }
    const m = raw.match(FENCE);
    // ```a``` のように 1 行で閉じるものはインラインコードなので除く
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      code[i] = true;
      fence = m[1];
      fenceStart = i;
      fences.set(i, m[2].trim() !== '');
      continue;
    }
    if (/^\s*<pre\b/i.test(raw)) {
      code[i] = true;
      if (!/<\/pre>/i.test(raw)) blockEnd = /<\/pre>/i;
      continue;
    }
    if (MATH_FENCE.test(raw)) {
      code[i] = true;
      blockEnd = MATH_FENCE;
      continue;
    }
    // リストの中で 4 文字以上字下げした行は、項目の続きなのでコードではない
    const prevBlank = i === start || lines[i - 1].trim() === '';
    if (!inList && INDENTED_CODE.test(raw) && raw.trim() !== '' && (prevBlank || code[i - 1])) {
      code[i] = true;
      continue;
    }
    if (LIST_ITEM.test(raw)) inList = true;
    else if (raw.trim() !== '' && !/^\s/.test(raw)) inList = false;
  }
  return { code, fences, unclosed: fence ? fenceStart : -1 };
}

/**
 * インラインコードを目印の 1 文字に置き換えた行を返す
 *
 * インラインコードは複数行にまたがることがあるため、行に分ける前の本文で置き換える。
 *
 * @param {string[]} lines
 * @param {boolean[]} skip 検査しない行（コードブロックなど）
 * @returns {string[]}
 */
function maskInlineCode(lines, skip) {
  return lines
    .map((l, i) => (skip[i] ? '' : l))
    .join('\n')
    .replace(INLINE_CODE, (m) => CODE_MARK + '\n'.repeat((m.match(/\n/g) || []).length))
    .split('\n');
}

/**
 * HTML タグ・リンク先を空にした行を返す
 *
 * いずれも中の記号が記法の検査対象ではないため、取り除いてから検査する。
 *
 * @param {string} text maskInlineCode を通した行
 * @returns {string}
 */
function maskInline(text) {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\]\([^)]*\)/g, ']()')
    .replace(/\\[*_]/g, '');
}

/**
 * イタリックになる箇所を返す
 *
 * GFM では英数字に挟まれた _ は強調にならないため、snake_case などは対象外にする。
 *
 * @param {string} text maskInline を通した行
 * @returns {string[]}
 */
function findItalics(text) {
  const body = text.replace(BLOCK_MARKER, '').replace(/\*\*|__/g, '');
  const stars = body.match(/(?<!\*)\*(?=\S)[^*\n]*?\S\*(?!\*)/g) || [];
  const underscores = body.match(/(?<![\p{L}\p{N}_])_(?=\S)[^_\n]*?[^_\s]_(?![\p{L}\p{N}_])/gu) || [];
  return [...stars, ...underscores];
}

/**
 * 日本語の文の中にあるダブルクォーテーションを返す
 *
 * 英文の中の引用は英語の表記として正しいため、中身か前後に日本語があるものだけを対象にする。
 *
 * @param {string} text maskInline を通した行
 * @returns {string[]}
 */
function findJapaneseQuotes(text) {
  const found = [];
  for (const m of text.matchAll(QUOTED)) {
    const before = text.slice(0, m.index).trimEnd().slice(-1);
    const after = text.slice(m.index + m[0].length).trimStart().charAt(0);
    if (JAPANESE.test(m[0]) || JAPANESE.test(before) || JAPANESE.test(after)) found.push(m[0]);
  }
  if (/["“”]/.test(text.replace(QUOTED, '')) && JAPANESE.test(text)) found.push('対になっていない引用符');
  return found;
}

/**
 * 和文と英数字・インラインコード・UI 要素の [ ] が、スペースなしで接している箇所を返す
 *
 * インラインコードは目印の 1 文字を英数字と同じに扱う。
 *
 * @param {string} line maskInlineCode を通した行
 * @returns {string[]}
 */
function findMissingSpaces(line) {
  const text = line.replace(/<[^>]*>/g, '').replace(/\]\([^)]*\)/g, ']()');
  const found = [...text.matchAll(NO_SPACE)].map((m) => m[1]);
  const jp = new RegExp(JP, 'u');
  for (const m of text.matchAll(UI_LABEL)) {
    const before = text.charAt(m.index - 1);
    const after = text.charAt(m.index + m[0].length);
    if (jp.test(before) || jp.test(after)) found.push(`${before}${m[0]}${after}`);
  }
  return found.map((s) => s.replace(/\u0001/g, '`…`'));
}

/**
 * 文末の「。」の有無が混ざったリストを検出結果に追加する
 *
 * 「：」で終わる項目は下位のリストを導く見出しの役割なので、比べる対象から外す。
 *
 * @param {{line: number, end: string}[]} items 同じリストの項目
 * @param {(line: number, rule: string, message: string) => void} add
 */
function checkListPeriods(items, add) {
  const targets = items.filter((item) => !/[:：]$/.test(item.end));
  const withPeriod = targets.filter((item) => item.end.endsWith('。'));
  if (withPeriod.length === 0 || withPeriod.length === targets.length) return;
  const without = targets.filter((item) => !item.end.endsWith('。')).map((item) => item.line);
  add(items[0].line, 'list-period', `同じリストで文末の「。」が混ざっている（「。」なし: ${without.join(', ')} 行目）。文なら「。」を付け、体言止めなら付けない`);
}

/**
 * 見出しのアンカーを返す
 *
 * GitHub の生成規則で作るため、規則の違う環境では一致しないことがある。
 *
 * @param {string} heading 見出しの文字列
 * @returns {string}
 */
function slugify(heading) {
  return heading
    .trim()
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

/**
 * 文書の中でリンク先にできるアンカーを返す
 *
 * @param {string} source
 * @returns {Set<string>} 小文字にしたアンカー
 */
function collectAnchors(source) {
  const lines = source.split(/\r?\n/);
  const frontmatterEnd = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  const { code } = findCodeLines(lines, frontmatterEnd + 1);
  const anchors = new Set();
  const counts = new Map();
  lines.forEach((raw, i) => {
    if (i <= frontmatterEnd || code[i]) return;
    for (const m of raw.matchAll(/<[a-z][^>]*\b(?:id|name)=["']([^"']+)["']/gi)) anchors.add(m[1].toLowerCase());
    const atx = raw.match(/^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/);
    const isSetext = i > 0 && !code[i - 1] && lines[i - 1].trim() !== '' && /^ {0,3}(?:=+|-+)\s*$/.test(raw);
    if (!atx && !isSetext) return;
    const slug = slugify(atx ? atx[1] : lines[i - 1]);
    const count = counts.get(slug) || 0;
    // 同じ見出しが続くと GitHub は -1、-2 を付ける
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
    counts.set(slug, count + 1);
  });
  return anchors;
}

/**
 * ファイルの有無を、大文字と小文字を区別して判定する
 *
 * Windows では大文字と小文字が違っても開けるが、GitHub ではリンクが切れるため、一覧の名前と比べる。
 *
 * @param {string} target
 * @returns {boolean}
 */
function fileExists(target) {
  try {
    return fs.readdirSync(path.dirname(target)).includes(path.basename(target));
  } catch {
    return false;
  }
}

/**
 * リンク先の問題を返す
 *
 * @param {string} dest リンク先
 * @param {string|undefined} filePath 検査するファイル。標準入力のときは undefined
 * @param {() => Set<string>} ownAnchors 検査する文書のアンカーを返す
 * @returns {{rule: string, message: string}|null}
 */
function checkLink(dest, filePath, ownAnchors) {
  if (dest === '') return { rule: 'broken-link', message: 'リンク先が空になっている' };
  if (UNCHECKED_DEST.test(dest)) return null;
  const [pathPart, ...rest] = dest.split('#');
  const anchor = rest.join('#');
  let target = '';
  if (pathPart !== '' && !pathPart.startsWith('?')) {
    if (!filePath) return null;
    target = path.resolve(path.dirname(filePath), decode(pathPart.split('?')[0]));
    if (!fileExists(target)) return { rule: 'broken-link', message: `リンク先のファイルがない: ${dest}` };
    if (!MARKDOWN_FILE.test(target)) return null;
  }
  if (anchor === '' || SPECIAL_ANCHOR.test(anchor)) return null;
  const anchors = target ? collectAnchors(fs.readFileSync(target, 'utf8')) : ownAnchors();
  if (anchors.has(decode(anchor).toLowerCase())) return null;
  return { rule: 'broken-anchor', message: `リンク先の見出しがない: ${dest}` };
}

/**
 * パーセントエンコードを戻した文字列を返す
 *
 * @param {string} text
 * @returns {string} 戻せないときは元の文字列
 */
function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Markdown の記法ルールに反する箇所を返す
 *
 * @param {string} source
 * @param {{noH1?: boolean, filePath?: string}} [options] noH1: タイトルを本文と別に持つ文書として、H1 をすべて検出する。filePath: 相対リンクの基準にするファイル
 * @returns {{line: number, rule: string, message: string}[]}
 */
function checkMarkdown(source, options = {}) {
  const lines = source.split(/\r?\n/);
  const findings = [];
  const add = (line, rule, message) => findings.push({ line, rule, message });
  let prevLevel = 1;
  let headingCount = 0;
  // frontmatter は本文ではないため検査しない。タイトルは frontmatter が持つので、本文の H1 は認めない
  const frontmatterEnd = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  const noH1 = options.noH1 || frontmatterEnd > 0;
  const { code, fences, unclosed } = findCodeLines(lines, frontmatterEnd + 1);
  const masked = maskInlineCode(lines, lines.map((_, i) => i <= frontmatterEnd || code[i]));
  let anchors = null;
  const ownAnchors = () => {
    if (!anchors) anchors = collectAnchors(source);
    return anchors;
  };
  // 字下げの幅ごとに、まだ終わっていないリストの項目を持つ
  const lists = new Map();
  let lastItem = null;
  const closeLists = (deeperThan) => {
    for (const [indent, items] of lists) {
      if (indent <= deeperThan) continue;
      checkListPeriods(items, add);
      lists.delete(indent);
    }
  };
  const itemEnd = (text) => text.trim().replace(/[*_`]+$/, '');

  lines.forEach((raw, i) => {
    const line = i + 1;
    if (i <= frontmatterEnd) return;
    if (fences.get(i) === false) add(line, 'code-lang', 'コードブロックに言語を指定していない。該当する言語がなければ text にする');
    if (code[i]) {
      if (!/^\s/.test(raw) && !code[i - 1]) closeLists(-1);
      return;
    }
    const reference = masked[i].match(REFERENCE_DEST);
    // \[x](y) はリンクにならないため、読む前に取り除く
    const linkable = masked[i].replace(/\\\[[^\]]*\]/g, '');
    const dests = reference ? [reference[1]] : [...linkable.matchAll(LINK_DEST)].map((m) => m[1]);
    for (const dest of dests) {
      const problem = checkLink(dest.replace(/^<|>$/g, ''), options.filePath, ownAnchors);
      if (problem) add(line, problem.rule, problem.message);
    }
    if (LINK_REFERENCE.test(raw)) return;

    const prev = i > 0 ? lines[i - 1].trim() : '';
    const heading = raw.match(ATX_HEADING);
    let level = heading ? heading[1].length : 0;
    if (!level && SETEXT_H1.test(raw) && prev !== '') level = 1;
    if (level === 1 && noH1) add(line, 'h1', 'H1 を使っている。タイトルを別に持つ文書なので、本文は ## から始める');
    if (level === 1 && !noH1 && headingCount > 0) add(line, 'h1', 'H1 がタイトル以外にある。H1 は先頭に 1 つだけにする');
    if (level === 4) add(line, 'h4', '#### を使っている。同じ構成の項目を並べる場合か確認する');
    if (level >= 5) add(line, 'h5', `${'#'.repeat(level)} を使っている。#### までにし、足りなければ文書の分割を検討する`);
    if (level >= 2 && level > prevLevel + 1) {
      add(line, 'heading-skip', `見出しのレベルが ${'#'.repeat(prevLevel)} から ${'#'.repeat(level)} に飛んでいる`);
    }
    if (level) {
      prevLevel = level;
      headingCount += 1;
    }

    const item = THEMATIC_BREAK.test(raw) ? null : raw.match(LIST_ITEM);
    if (item) {
      const indent = item[1].length;
      closeLists(indent);
      if (!lists.has(indent)) lists.set(indent, []);
      lastItem = { line, end: itemEnd(item[2]) };
      lists.get(indent).push(lastItem);
    } else if (raw.trim() !== '') {
      if (lastItem && !level && (/^\s/.test(raw) || prev !== '')) {
        lastItem.end = itemEnd(raw);
      } else {
        closeLists(-1);
        lastItem = null;
      }
    }

    if (DEFINITION.test(raw) && prev !== '') add(line, 'definition-list', '定義リストを使っている。2 列のテーブルにする');
    const withoutCode = masked[i];
    if (/<details\b/i.test(withoutCode)) add(line, 'details', '折りたたみを使っている。本筋に必須でない長い補足か確認する');
    if (/<(?:em|i)\b/i.test(withoutCode)) add(line, 'italic', 'イタリックを使っている（HTML タグ）');
    if (GITHUB_ALERT.test(raw)) add(line, 'github-alert', 'GitHub のアラートを使っている。ほかの環境では文字列のまま表示されるため、警告の語句をボールドにする');
    for (const m of withoutCode.match(/(?<!!)\[(?:こちら|ここ|コチラ)[^\]]{0,8}\]\(/g) || []) {
      add(line, 'link-text', `リンクテキストが行き先を表していない: ${m.slice(0, -1)}`);
    }
    if (/!\[\s*\]\(/.test(withoutCode)) add(line, 'image-alt', '画像の代替テキストが空になっている');
    const missing = findMissingSpaces(masked[i]);
    if (missing.length > 0) add(line, 'space', `和文と英数字の間にスペースがない: ${missing.join('、')}`);

    const text = maskInline(masked[i]);
    if (THEMATIC_BREAK.test(text)) return;
    for (const m of findItalics(text)) add(line, 'italic', `イタリックを使っている: ${m}`);
    for (const m of findJapaneseQuotes(text)) add(line, 'double-quote', `日本語の文でダブルクォーテーションを使っている: ${m}。「」にする`);
    if (/[［］]/.test(text)) add(line, 'fullwidth-bracket', '全角の［］を使っている。UI 要素なら半角の [ ] にする');
    if (/[Ａ-Ｚａ-ｚ０-９]/.test(text)) add(line, 'fullwidth-alnum', '全角の英数字を使っている。半角にする');
    if (/[｡-ﾟ]/.test(text)) add(line, 'halfwidth-kana', '半角カナを使っている。全角にする');
    const bolds = text.match(/\*\*[^*]+?\*\*|__[^_]+?__/g) || [];
    for (const b of bolds) {
      if (/^(?:\*\*|__)[「『].*[」』](?:\*\*|__)$/.test(b)) add(line, 'bold-quote', `ボールドと括弧を重ねている: ${b}`);
    }
    for (const m of text.match(/[「『](?:\*\*|__)[^*_]+?(?:\*\*|__)[」』]/g) || []) {
      add(line, 'bold-quote', `ボールドと括弧を重ねている: ${m}`);
    }
    const body = text.replace(BLOCK_MARKER, '').trim();
    if (/^(?:\*\*[^*]+\*\*|__[^_]+__)[。.:：]?$/.test(body)) {
      add(line, 'bold-line', '行全体がボールドになっている。見出しの代わりなら見出しにし、文なら警告・必須事項の語句だけにする');
    }
  });

  closeLists(-1);
  if (unclosed >= 0) add(unclosed + 1, 'unclosed-fence', '（参考）コードブロックが閉じていない');
  return findings;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const noH1 = args.includes('--no-h1');
  const paths = args.filter((a) => a !== '--no-h1');
  const files = paths.length > 0 ? paths : ['-'];
  let count = 0;
  for (const file of files) {
    const source = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
    const label = file === '-' ? 'stdin' : file;
    const findings = checkMarkdown(source, { noH1, filePath: file === '-' ? undefined : file });
    findings.forEach((f) => console.log(`${label}:${f.line} [${f.rule}] ${f.message}`));
    count += findings.length;
  }
  process.exit(count > 0 ? 1 : 0);
}

module.exports = { checkMarkdown };
