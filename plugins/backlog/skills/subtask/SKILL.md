---
name: subtask
description: Backlog の親課題に、雛形で決めた形の子課題を 1 つ作成する。「子課題を作って」「実装の子課題を切って」「第三者テストの課題を追加して」と言われたとき、ステージの作業を始める前に子課題が必要になったときに使う。雛形の選択、毎回決める値（開始日・期限日など）の確認、作成前の確認、Backlog API での作成までを担当する。
argument-hint: "[課題キー] [雛形]"
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/subtask.js" *)
---

## 目的

親課題に、ステージごとの子課題を必要になったときに 1 つずつ作る。件名・種別・担当者などの決まった形は雛形で決め、毎回同じ形で作る。

値の決定・ID への変換・重複の確認・作成はスクリプトが行う。AI は質問と結果の伝達だけを行う。

## 状態

親課題・作成済みの子課題・雛形の一覧は、起動時にスクリプトが集めて下に埋め込む。同じ情報を取り直さない。

```!
node "${CLAUDE_SKILL_DIR}/scripts/subtask.js" status "$ARGUMENTS"
```

## 進め方の原則

- `question` は、`label` と `description` をそのまま `AskUserQuestion` に渡す。文言や選択肢を作り直さない。
- 選ばれた選択肢の `run` を、そのまま Bash で実行する。`run` が `null` なら何もしない。
- スクリプトの結果の `ok` が `false` なら、`message` を伝えて止まる。
- Backlog への書き込みは `create` だけで行う。Backlog MCP サーバーで課題を作ったり、API を直接呼んだりしない。
- 値を変えるときは `--set <項目>=<値>` を付けて `plan` を実行し直す。値を空にする（`--set dueDate=`）と「設定しない」になる。

## 手順

`next` で決まる。

| `next` | すること |
|---|---|
| `stop-no-config` | `message` を伝え、「設定」の書き方を示して止まる |
| `stop-no-templates` | `message` を伝え、「雛形」の書き方を示して止まる |
| `invalid-key` | `message` を伝え、課題キーを聞き直す |
| `ask-key` | 課題キーを聞く。答えが来たら `node "${CLAUDE_SKILL_DIR}/scripts/subtask.js" status "<課題キー> <templateName>"` で取り直す |
| `ask-template` | 1 |
| `ask-values` | 2 |
| `confirm` | 3 |
| `exists` | `message` と `existing.url` を伝えて止まる |
| `all-created` | `message` を伝えて止まる |
| `error` | `message` を伝えて止まる |

### 1. 雛形を選ぶ

`message` があれば先に伝える（指定された雛形が無かったとき）。作成済みの子課題（`children`）を 1 行で示してから、`question` を聞く。選ばれた選択肢の `run`（`plan`）を実行し、その結果の `next` で続ける。

「Other」で雛形の名前が入力されたときは、`templates` にある名前か確かめてから `node "${CLAUDE_SKILL_DIR}/scripts/subtask.js" plan <課題キー> <雛形>` を実行する。

### 2. 毎回決める値を聞く

`ask` に並んだ項目を、`label` を並べて 1 回のメッセージで聞く。「なし」と答えられることも書き添える。

答えを `--set` にして、`planCommand` の末尾に付けて実行する。

- 日付は `YYYY-MM-DD` にする。「来週の金曜」のような答えは今日の日付から計算し、計算した日付を確認のときに示す
- 「なし」は `--set <項目>=` にする

### 3. 作成前に確認する

`preview` を表にして示す。`mode` が `fixed` の項目には「固定」と添える。`description`（本文）が空でなければ、表の下にそのまま示す。そのあと `question` を聞く。

- 「作成する」: `run`（`create`）を実行し、結果の `message` と `issue.url` を伝える
- 「値を変える」: 変えたい項目と値を聞き、`--set` を付けて `planCommand` を実行し直す。そのあと 3 をやり直す

## 雛形

雛形は `~/.claude/backlog/subtasks/` の下のディレクトリに置く。ディレクトリ名が雛形の名前になる。先頭に `01_` のような番号を付けると、その順で選択肢に並ぶ（番号は名前に含めない）。

```
~/.claude/backlog/subtasks/
├── settings.json             全部の雛形に共通の設定
├── 01_調査および要件定義/
│   ├── settings.json         この雛形の設定。共通の設定を項目ごとに上書きする
│   └── body.md               本文の雛形
└── 02_実装/
    └── ...
```

`settings.json` の例:

```json
{
  "issueType": { "value": "タスク", "mode": "fixed" },
  "priority":  { "from": "parent", "mode": "default" },
  "category":  { "from": "parent", "mode": "default" },
  "milestone": { "value": null, "mode": "fixed" },
  "assignee":  { "from": "me", "mode": "fixed" },
  "startDate": { "mode": "ask" },
  "dueDate":   { "mode": "ask" }
}
```

項目:

| 項目 | 内容 | `from` に使える値 |
|---|---|---|
| `summary` | 件名。書かなければ雛形の名前で固定 | |
| `issueType` | 種別。書かなければ親課題の種別が初期値 | `parent` |
| `priority` | 優先度。書かなければ親課題の優先度が初期値 | `parent` |
| `category` | カテゴリー（複数可） | `parent` |
| `milestone` | マイルストーン（複数可） | `parent` |
| `assignee` | 担当者 | `parent`・`me` |
| `startDate` | 開始日 | `parent` |
| `dueDate` | 期限日 | `parent` |

各項目には、値の出どころと扱いを書く。

- 出どころ: `value`（書いた値）か `from`（`parent` は親課題の値、`me` は自分）のどちらか一方。`value` は Backlog の画面に出る名前で書き、複数のときは配列にする。`null` は「設定しない」
- 扱い（`mode`）
  - `fixed`: その値で作る。変えられない
  - `default`: その値を初期値にする。確認のときに変えられる（省略したときもこれ）
  - `ask`: 初期値なしで毎回聞く。`value` と `from` は書かない

`summary` と `body.md` には、親課題の値を差し込める: `{{parent.key}}`・`{{parent.summary}}`・`{{parent.url}}`

## 設定

スペースの URL と API キーは公開リポジトリに置かない。

- スペースの URL: `~/.claude/backlog.json` の `space`（例: `"https://example.backlog.jp"`）
- API キー: 環境変数 `BACKLOG_API_KEY`。無ければ `~/.claude/backlog.json` の `apiKey`
