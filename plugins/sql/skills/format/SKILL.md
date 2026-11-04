---
name: format
description: SQL と、PHP の文字列連結（`$sql .= "..." . PHP_EOL;`）で書いた SQL を整形する。「SQL を整形して」「SQL のインデントを直して」と言われたとき、PHP の文字列連結の SQL を書くときに使う。
argument-hint: "[PHP ファイル] [--start 行] [--end 行]"
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/format.js" *)
---

## 目的

SQL の整形をスクリプトに任せる。整形のルールを AI が推論で再現せず、スクリプトの結果をそのまま使う。

## 手順

### PHP ファイルの文字列連結を整形する

範囲の指定がなければファイル全体を対象にする。範囲の指定があれば、`--start` と `--end` に 1 始まりの行番号を渡す。スクリプトが直接ファイルを書き換えるので、結果を Edit で書き写さない。

```sh
node "${CLAUDE_SKILL_DIR}/scripts/format.js" <ファイル> --write
```

`--write` を付けなければ、変更の案だけを表示する。

出力の読み方は次のとおり。`[構造を保持]` のブロックは、自動で整形されたと誤解されないよう、その旨をユーザーに伝える。

| 表示 | 意味 |
|---|---|
| `[整形]` | 構造も含めて整形した |
| `[構造を保持]` | 式の連結・変数展開・SQL のコメントを含むため、行の分け方を変えずパディングだけを直した |
| `[ERROR]` | 行末が SQL の文字列の途中になっているなど、解析できない。失敗が 1 つでもあれば、ファイルは書き換えない |

### 新しく SQL を書く

生の SQL を標準入力で渡す。AI が整形した結果を手で書かない。

```sh
# PHP の文字列連結にする。--base-indent はコードの字下げの文字数
node "${CLAUDE_SKILL_DIR}/scripts/format.js" --php --var '$sql' --base-indent 8 <<'SQL'
SELECT id, name FROM users WHERE status = 1
SQL

# 生の SQL のまま整形する
node "${CLAUDE_SKILL_DIR}/scripts/format.js" --raw <<'SQL'
SELECT id, name FROM users WHERE status = 1
SQL
```

## 整形のルール

変更できない部分は次のとおり。

- 独立した行にする: `SELECT` `FROM` `WHERE` `UPDATE` `SET` `GROUP BY` `HAVING` `ORDER BY` `INSERT INTO` `VALUES` `DELETE FROM` `ON DUPLICATE KEY UPDATE`、`JOIN` の類、`UNION` の類。
- 内容の行の先頭に置く: `ON` `AND` `OR`。括弧と `CASE` の中、`BETWEEN` の `AND` では改行しない。
- 値と同じ行に書く: `LIMIT` `OFFSET` `FOR UPDATE`。
- カンマで項目ごとの行にする: `SELECT` `GROUP BY` `ORDER BY` `VALUES` `SET` `ON DUPLICATE KEY UPDATE`。
- `SELECT` で始まる括弧はサブクエリとして展開する。`VALUES` と `INSERT INTO` の括弧は、括弧も独立した行にする。ほかの括弧は 1 行のまま保つ。

`~/.claude/sql.json` で変更できる部分は次のとおり。ファイルがなければ既定値を使う。

| 設定 | 意味 | 既定値 |
|---|---|---|
| `comma` | カンマの位置。`trailing` か `leading` | `trailing` |
| `indent` | 字下げの文字数 | `4` |
| `padding` | PHP の連結で、最長の行に足して右パディングする文字数。`null` でパディングなし | `null` |

## 安全のための動作

- 整形の前後で SQL のトークン列が変わるときは、そのブロックの構造を変えない。
- 先頭の演算子は変えない。`$sql .= "..."` から始まるブロックは `.=` のまま保つ。
- キーワードで始まる行がないブロックは、SQL でないとみなして対象にしない。
- 1 行だけの代入は対象にしない。
- UTF-8 以外のファイルは書き換えない。改行コードは元のまま保つ。
