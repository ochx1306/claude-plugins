---
name: check
description: PHP・JS・TS の docblock が正しい関数の直前に付いているかと、コメントの書き方を機械的に検査する。関数を追加・移動・削除したあと、docblock を書き足した・直したあと、コミットの前、「docblock の位置を確認して」「孤立した docblock」「@param と引数が合っているか」「コメントを検査して」と言われたときに使う。
argument-hint: "[--from 版] [--all] [パス...]"
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/../../scripts/check-comments.js" *)
---

## 目的

編集のたびに動く hook と同じ検査を、ブランチ全体やディレクトリに対して実行する。目で読んで「付いている」と判断せず、スクリプトの結果を根拠にする。

## 手順

スクリプトを実行する。ユーザーが引数を指定していれば、そのまま渡す。

```sh
node "${CLAUDE_SKILL_DIR}/../../scripts/check-comments.js" $ARGUMENTS
```

誤検出もあるため、各項目を確認し、問題があるものだけ直す。直したらもう一度実行する。コメントだけを直したときは、verify スキルで実行コードが変わっていないことも確かめる。

## 使い方

```sh
# 未コミットの変更（HEAD との差）に関係する問題
node "${CLAUDE_SKILL_DIR}/../../scripts/check-comments.js"

# ブランチで変えたところに関係する問題
node "${CLAUDE_SKILL_DIR}/../../scripts/check-comments.js" --from origin/main

# ファイルやディレクトリの全体
node "${CLAUDE_SKILL_DIR}/../../scripts/check-comments.js" --all src/
```

| オプション | 意味 | 既定 |
|---|---|---|
| `--from REV` | 変更を比べる元の版 | `HEAD` |
| `--all` | 変更に関係なく、対象のファイルの全体を検査する | 変更に関係する問題だけ |

終了コードは、`0` が問題なし、`1` が問題あり、`2` が失敗。

既存のコードには古い指摘が多いことがあるため、既定では変更に関係する問題だけを報告する。関数と docblock の結び付きの検査は、変更した行に隣り合う箇所も対象にする。既存の docblock と関数の間に新しい関数を入れたときや、関数を消して docblock だけが残ったときは、変更していない行の指摘も出る。

## 関数と docblock の結び付きの指摘

| ルール | 内容 | よくある原因 |
|---|---|---|
| `missing-docblock` | docblock がない関数 | 既存の docblock と関数の間に新しい関数を入れた |
| `docblock-orphan` | 直後が別の docblock、閉じ括弧、ファイルの終わりの docblock | 同上の取り残された側。関数を消して docblock だけ残した |
| `docblock-mismatch` | `@param` の名前が引数にない | 別の関数の docblock。引数名の変更に追従していない。綴りの違い |
| `param-missing` | `@param` がない引数がある | 引数を足したのに docblock を直していない |
| `param-order` | `@param` の順序が引数と違う | 引数の順序を変えたのに docblock を直していない |

次のものは検査しない。

- クロージャ、関数の中の arrow 関数、PHP の `use function`
- 1 行の `/** @var Type $x */` と `/** @type {T} */`
- `@typedef` や `@license` のように単独で置く docblock、ファイル先頭の docblock の孤立
- `@inheritdoc` の付いた docblock と、`@param` を 1 つも書いていない docblock の引数の突き合わせ

## 指摘が出たら

`missing-docblock` と `docblock-orphan` が隣り合って出たときは、既存の docblock と関数の間に新しい関数を入れた取り違えのことが多い。新しい関数を、既存の docblock より前か既存の関数の後ろへ移す。
