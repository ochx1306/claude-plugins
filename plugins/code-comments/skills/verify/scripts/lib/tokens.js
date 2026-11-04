// 行番号の逆引きと、トークン列の差分の計算をまとめる。
const MAX_DIFF_CELLS = 25_000_000;

/**
 * 文字の位置から行番号を返す関数を生成する
 *
 * @param {string} source
 * @returns {(index: number) => number} 行番号は 1 始まり
 */
function lineLocator(source) {
  const starts = [0];
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) starts.push(i + 1);
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle] <= index) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/**
 * 2 つのトークン列の差分区間を返す
 *
 * 差分の範囲が広いと計算量が大きくなるため、先頭と末尾の一致を除いた範囲が上限を超えたら、1 つの区間として返す。
 *
 * @param {string[]} a 変更前
 * @param {string[]} b 変更後
 * @returns {[number, number, number, number][]} [変更前の始まり, 変更前の終わり, 変更後の始まり, 変更後の終わり]。終わりは含まない
 */
function diffHunks(a, b) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let endA = a.length;
  let endB = b.length;
  while (endA > head && endB > head && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - head;
  const m = endB - head;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || n * m > MAX_DIFF_CELLS) return [[head, endA, head, endB]];

  // 最長共通部分列の長さの表。table[i][j] は a[head + i] 以降と b[head + j] 以降の長さ
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[head + i] === b[head + j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const hunks = [];
  let current = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[head + i] === b[head + j]) {
      current = null;
      i++;
      j++;
      continue;
    }
    if (!current) {
      current = [head + i, head + i, head + j, head + j];
      hunks.push(current);
    }
    if (j >= m || (i < n && table[(i + 1) * width + j] >= table[i * width + j + 1])) {
      i++;
      current[1] = head + i;
    } else {
      j++;
      current[3] = head + j;
    }
  }
  return hunks;
}

module.exports = { lineLocator, diffHunks };
