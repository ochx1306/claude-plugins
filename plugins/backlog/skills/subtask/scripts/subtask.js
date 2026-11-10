#!/usr/bin/env node
// 使い方:
//   node subtask.js status "[課題キー] [雛形]"
//     親課題と雛形を確かめ、次の手順と AskUserQuestion の選択肢を JSON で出力する
//   node subtask.js plan <課題キー> <雛形> [--set <項目>=<値>]...
//     作成する子課題の全項目の値を出力する
//   node subtask.js create <課題キー> <雛形> [--set <項目>=<値>]...
//     子課題を作成する
// SKILL.md の !`...` から呼ばれ、失敗するとスキルの起動ごと止まるため、終了コードは常に 0 にする。
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CONFIG_PATH, loadConfig } = require('../../../scripts/lib/config');
const { findKeys, isKey } = require('../../../scripts/lib/key');

const TEMPLATE_ROOT = path.join(os.homedir(), '.claude', 'backlog', 'subtasks');
// 雛形のディレクトリ名の先頭の番号。雛形の並び順にだけ使い、雛形の名前には含めない
const ORDER_PATTERN = /^(\d+)_(.+)$/;
const MODES = ['fixed', 'default', 'ask'];
// 子課題の項目。from は値の出どころに指定できるもの、multi は複数の値を持てる項目
const FIELDS = {
  summary: { label: '件名', from: [] },
  issueType: { label: '種別', from: ['parent'] },
  priority: { label: '優先度', from: ['parent'] },
  category: { label: 'カテゴリー', from: ['parent'], multi: true },
  milestone: { label: 'マイルストーン', from: ['parent'], multi: true },
  assignee: { label: '担当者', from: ['parent', 'me'] },
  startDate: { label: '開始日', from: ['parent'], date: true },
  dueDate: { label: '期限日', from: ['parent'], date: true },
};
// settings.json に書かれていない項目の設定。件名の既定値は雛形の名前にする
const DEFAULT_FIELDS = {
  issueType: { from: 'parent', mode: 'default' },
  priority: { from: 'parent', mode: 'default' },
};
// Backlog の課題の作成で必須の項目
const REQUIRED = ['summary', 'issueType', 'priority'];
const PLACEHOLDER_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Backlog API の呼び出しでわかった失敗
 */
class BacklogError extends Error {}

/**
 * スペースの URL と API キーを返す
 *
 * @returns {{space: string, apiKey: string}|{error: string}}
 */
function loadCredentials() {
  const config = loadConfig();
  const space = typeof config.space === 'string' ? config.space.trim().replace(/\/+$/, '') : '';
  const apiKey = process.env.BACKLOG_API_KEY || config.apiKey || '';
  const lacks = [];
  if (!/^https?:\/\//.test(space)) lacks.push(`${CONFIG_PATH} の space（例: "https://example.backlog.jp"）`);
  if (!apiKey) lacks.push(`環境変数 BACKLOG_API_KEY か ${CONFIG_PATH} の apiKey`);
  return lacks.length > 0 ? { error: `${lacks.join('と、')}を設定してください` } : { space, apiKey };
}

/**
 * Backlog API のクライアントを生成する
 *
 * @param {{space: string, apiKey: string}} credentials
 * @returns {{space: string, get: Function, post: Function}}
 */
function createClient({ space, apiKey }) {
  const request = async (method, apiPath, params) => {
    const url = new URL(`${space}/api/v2${apiPath}`);
    url.searchParams.set('apiKey', apiKey);
    const init = { method };
    if (method === 'GET') {
      for (const [k, v] of params) url.searchParams.append(k, v);
    } else {
      init.body = new URLSearchParams(params);
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      // URL には API キーが含まれるため、失敗の理由に URL を含めない
      throw new BacklogError(`${space} に接続できません: ${e.cause ? e.cause.code || e.cause.message : e.message}`);
    }
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    if (res.status === 401) throw new BacklogError('API キーが無効です');
    let detail = text;
    try {
      detail = JSON.parse(text).errors.map((e) => e.message).join(' / ');
    } catch {
      // 本文が JSON でなければそのまま出す
    }
    throw new BacklogError(`Backlog API がエラーを返しました（${method} ${apiPath}、${res.status}）: ${detail}`);
  };
  return {
    space,
    get: (apiPath, params = []) => request('GET', apiPath, params),
    post: (apiPath, params = []) => request('POST', apiPath, params),
  };
}

/**
 * 雛形の一覧を並び順で返す
 *
 * @returns {{name: string, dir: string}[]} ディレクトリの先頭の番号の順。番号がないものは名前の順で後ろに並べる
 */
function listTemplates() {
  if (!fs.existsSync(TEMPLATE_ROOT)) return [];
  return fs
    .readdirSync(TEMPLATE_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const m = e.name.match(ORDER_PATTERN);
      return { name: m ? m[2] : e.name, order: m ? Number(m[1]) : Infinity, dir: path.join(TEMPLATE_ROOT, e.name) };
    })
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map(({ name, dir }) => ({ name, dir }));
}

/**
 * JSON のファイルを読んで返す
 *
 * @param {string} file
 * @returns {object} ファイルがないときは空のオブジェクト
 * @throws {BacklogError} JSON として読めないとき
 */
function readJson(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new BacklogError(`${file} を JSON として読めません: ${e.message}`);
  }
}

/**
 * 雛形の項目の設定と本文の雛形を返す
 *
 * 共通の settings.json に雛形の settings.json を項目ごとに重ねる。
 *
 * @param {{name: string, dir: string}} template
 * @returns {{fields: Object<string, {value?: *, from?: string, mode: string}>, body: string}}
 * @throws {BacklogError} 設定が正しくないとき
 */
function loadTemplate(template) {
  const commonFile = path.join(TEMPLATE_ROOT, 'settings.json');
  const ownFile = path.join(template.dir, 'settings.json');
  const merged = { summary: { value: template.name, mode: 'fixed' }, ...DEFAULT_FIELDS, ...readJson(commonFile), ...readJson(ownFile) };

  const fields = {};
  for (const [field, setting] of Object.entries(merged)) {
    const def = FIELDS[field];
    const where = `${template.name} の ${field}`;
    if (!def) throw new BacklogError(`${where} は項目ではありません。使える項目: ${Object.keys(FIELDS).join(' / ')}`);
    if (typeof setting !== 'object' || setting === null || Array.isArray(setting)) {
      throw new BacklogError(`${where} は { "value": ..., "mode": ... } の形で書いてください`);
    }
    const mode = setting.mode || 'default';
    if (!MODES.includes(mode)) throw new BacklogError(`${where} の mode は ${MODES.join(' / ')} のどれかにしてください`);
    const hasValue = 'value' in setting;
    const hasFrom = 'from' in setting;
    if (hasValue && hasFrom) throw new BacklogError(`${where} には value と from のどちらか一方だけを書いてください`);
    if (mode === 'ask' && (hasValue || hasFrom)) throw new BacklogError(`${where} は mode が ask のため、value と from は書けません`);
    if (mode === 'fixed' && !hasValue && !hasFrom) throw new BacklogError(`${where} は mode が fixed のため、value か from を書いてください`);
    if (hasFrom && !def.from.includes(setting.from)) {
      throw new BacklogError(`${where} の from に使えるのは ${def.from.join(' / ') || '（なし）'} です`);
    }
    fields[field] = { mode, ...(hasValue ? { value: setting.value } : {}), ...(hasFrom ? { from: setting.from } : {}) };
  }

  const bodyFile = path.join(template.dir, 'body.md');
  const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8').replace(/\r\n/g, '\n') : '';
  return { fields, body };
}

/**
 * 雛形の差し込みを親課題の値に置き換えた文字列を返す
 *
 * @param {string} text
 * @param {object} parent 親課題
 * @param {string} space
 * @returns {string}
 * @throws {BacklogError} 知らない差し込みがあるとき
 */
function render(text, parent, space) {
  const values = {
    'parent.key': parent.issueKey,
    'parent.summary': parent.summary,
    'parent.url': `${space}/view/${parent.issueKey}`,
  };
  return text.replace(PLACEHOLDER_PATTERN, (all, name) => {
    if (!(name in values)) throw new BacklogError(`{{${name}}} は差し込めません。使える差し込み: ${Object.keys(values).map((v) => `{{${v}}}`).join(' / ')}`);
    return values[name];
  });
}

/**
 * --set の指定を項目ごとの値にして返す
 *
 * @param {string[]} sets 「項目=値」の形の文字列
 * @returns {Object<string, string>}
 * @throws {BacklogError} 形が正しくないとき
 */
function parseSets(sets) {
  const result = {};
  for (const s of sets) {
    const i = s.indexOf('=');
    const field = i === -1 ? s : s.slice(0, i);
    if (i === -1 || !FIELDS[field]) throw new BacklogError(`--set ${s} は「項目=値」の形にしてください。使える項目: ${Object.keys(FIELDS).join(' / ')}`);
    result[field] = s.slice(i + 1).trim();
  }
  return result;
}

/**
 * 日付の文字列が YYYY-MM-DD の形の実在する日付かを判定する
 *
 * @param {string} text
 * @returns {boolean}
 */
function isDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

/**
 * 親課題と、その子課題の一覧を返す
 *
 * @param {object} client
 * @param {string} key
 * @returns {Promise<{parent: object, children: object[]}>}
 * @throws {BacklogError} 課題が子課題のとき
 */
async function fetchParent(client, key) {
  const parent = await client.get(`/issues/${key}`);
  if (parent.parentIssueId) {
    const grand = await client.get(`/issues/${parent.parentIssueId}`);
    throw new BacklogError(`${key} は ${grand.issueKey} の子課題です。Backlog の子課題は 1 階層だけのため、親課題の ${grand.issueKey} を指定してください`);
  }
  const children = await client.get('/issues', [
    ['projectId[]', parent.projectId],
    ['parentIssueId[]', parent.id],
    ['count', 100],
  ]);
  return { parent, children };
}

/**
 * 名前の一覧を、Backlog の候補と照らして ID 付きにして返す
 *
 * @param {string[]} names
 * @param {{id: number, name: string}[]} candidates
 * @param {string} label 項目の表示名
 * @returns {{id: number, name: string}[]}
 * @throws {BacklogError} 候補にない名前があるとき
 */
function matchNames(names, candidates, label) {
  return names.map((n) => {
    const found = candidates.find((c) => c.name === n || c.userId === n);
    if (!found) throw new BacklogError(`${label}「${n}」が見つかりません。候補: ${candidates.map((c) => c.name).join(' / ')}`);
    return { id: found.id, name: found.name };
  });
}

/**
 * 子課題の全項目の値を生成する
 *
 * @param {object} client
 * @param {string} key 親課題の課題キー
 * @param {string} templateName
 * @param {string[]} sets --set の指定
 * @returns {Promise<object>}
 * @throws {BacklogError} 雛形・指定・親課題のいずれかが正しくないとき
 */
async function build(client, key, templateName, sets) {
  const template = listTemplates().find((t) => t.name === templateName);
  if (!template) throw new BacklogError(`雛形「${templateName}」がありません。雛形は ${TEMPLATE_ROOT} の下のディレクトリです`);
  const { fields, body } = loadTemplate(template);
  const overrides = parseSets(sets);
  const { parent, children } = await fetchParent(client, key);

  // 候補の一覧は、名前から ID に変える項目があるときだけ取得する
  const cache = {};
  const lookup = (name, fetcher) => (cache[name] ??= fetcher());
  const candidatesOf = {
    issueType: () => lookup('issueType', () => client.get(`/projects/${parent.projectId}/issueTypes`)),
    priority: () => lookup('priority', () => client.get('/priorities')),
    category: () => lookup('category', () => client.get(`/projects/${parent.projectId}/categories`)),
    milestone: () => lookup('milestone', () => client.get(`/projects/${parent.projectId}/versions`)),
    assignee: () => lookup('assignee', () => client.get(`/projects/${parent.projectId}/users`)),
  };
  const fromParent = {
    issueType: () => [parent.issueType],
    priority: () => [parent.priority],
    category: () => parent.category || [],
    milestone: () => parent.milestone || [],
    assignee: () => (parent.assignee ? [parent.assignee] : []),
    startDate: () => (parent.startDate ? [parent.startDate.slice(0, 10)] : []),
    dueDate: () => (parent.dueDate ? [parent.dueDate.slice(0, 10)] : []),
  };

  const items = [];
  const missing = [];
  for (const [field, def] of Object.entries(FIELDS)) {
    const setting = fields[field] || { mode: 'default', value: null };
    const item = { field, label: def.label, mode: setting.mode };
    let values;
    if (field in overrides) {
      if (setting.mode === 'fixed') throw new BacklogError(`${def.label}（${field}）は雛形「${templateName}」で固定のため、変えられません`);
      const raw = overrides[field];
      values = raw === '' ? [] : def.multi ? raw.split(',').map((v) => v.trim()).filter(Boolean) : [raw];
      item.source = 'set';
    } else if (setting.mode === 'ask') {
      missing.push({ field, label: def.label });
      items.push({ ...item, value: null });
      continue;
    } else if (setting.from === 'parent') {
      values = fromParent[field]();
      item.source = 'parent';
    } else if (setting.from === 'me') {
      values = [await lookup('me', () => client.get('/users/myself'))];
      item.source = 'me';
    } else {
      const v = setting.value;
      values = v === null || v === undefined || v === '' ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
      item.source = 'value';
    }
    if (!def.multi && values.length > 1) throw new BacklogError(`${def.label}（${field}）に指定できる値は 1 つだけです`);

    if (field === 'summary') {
      values = values.map((v) => render(v, parent, client.space));
    } else if (def.date) {
      const bad = values.find((v) => !isDate(v));
      if (bad) throw new BacklogError(`${def.label}「${bad}」は YYYY-MM-DD の形の日付にしてください`);
    } else if (values.some((v) => typeof v === 'string')) {
      // 親課題と自分の値は ID を持つ。雛形と --set の値は名前のため、候補と照らして ID を取得する
      values = matchNames(values, await candidatesOf[field](), def.label);
    }
    items.push({ ...item, value: values.length === 0 ? null : def.multi ? values : values[0] });
  }

  const get = (field) => items.find((i) => i.field === field).value;
  for (const field of REQUIRED) {
    if (get(field) === null && !missing.some((m) => m.field === field)) {
      throw new BacklogError(`${FIELDS[field].label}（${field}）は必須です。雛形「${templateName}」の settings.json に書くか、--set で指定してください`);
    }
  }
  const start = get('startDate');
  const due = get('dueDate');
  if (start && due && start > due) throw new BacklogError(`開始日 ${start} が期限日 ${due} より後になっています`);

  const summary = get('summary');
  const duplicate = summary && children.find((c) => c.summary === summary);
  return {
    parent: { key: parent.issueKey, summary: parent.summary, url: `${client.space}/view/${parent.issueKey}` },
    template: templateName,
    items,
    description: render(body, parent, client.space),
    missing,
    duplicate: duplicate ? { key: duplicate.issueKey, summary: duplicate.summary, url: `${client.space}/view/${duplicate.issueKey}` } : null,
    parentIssue: parent,
  };
}

/**
 * 項目の値を表示用の文字列にして返す
 *
 * @param {*} value
 * @returns {string}
 */
function display(value) {
  if (value === null) return '（設定しない）';
  if (Array.isArray(value)) return value.map(display).join('、');
  return typeof value === 'object' ? value.name : String(value);
}

/**
 * 選択肢を選んだときに実行するコマンドを返す
 *
 * @param {...string} args subtask.js に渡す引数
 * @returns {string}
 */
function runCommand(...args) {
  // Windows のパスの \ は bash で解釈が変わるため、/ にそろえる
  const script = __filename.replace(/\\/g, '/');
  return ['node', `"${script}"`, ...args.map((a) => (/[\s"'<>|&;$`]/.test(a) || a === '' ? JSON.stringify(a) : a))].join(' ');
}

/**
 * --set の指定をコマンドの引数に変換する
 *
 * @param {string[]} sets
 * @returns {string[]}
 */
function argsOfSets(sets) {
  return sets.flatMap((s) => ['--set', s]);
}

/**
 * plan サブコマンドの結果を返す
 *
 * @param {object} client
 * @param {string} key
 * @param {string} templateName
 * @param {string[]} sets
 * @returns {Promise<object>}
 */
async function plan(client, key, templateName, sets) {
  const { parentIssue, ...result } = await build(client, key, templateName, sets);
  const preview = result.items.map(({ field, label, value, mode, source }) => ({ field, label, value: display(value), mode, source }));
  const base = { ok: true, parent: result.parent, template: templateName, preview, description: result.description };

  if (result.duplicate) {
    return { ...base, next: 'exists', message: `${result.parent.key} には同じ件名の子課題 ${result.duplicate.key}「${result.duplicate.summary}」があります`, existing: result.duplicate };
  }
  if (result.missing.length > 0) {
    return { ...base, next: 'ask-values', ask: result.missing, planCommand: runCommand('plan', key, templateName, ...argsOfSets(sets)) };
  }
  const summary = result.items.find((i) => i.field === 'summary').value;
  return {
    ...base,
    next: 'confirm',
    question: {
      question: `${result.parent.key}「${result.parent.summary}」に子課題「${summary}」を作成しますか？`,
      options: [
        { label: '作成する', description: '表示した内容で Backlog に子課題を作成する', run: runCommand('create', key, templateName, ...argsOfSets(sets)) },
        { label: '値を変える', description: '固定でない項目の値を変えてから確認し直す', run: null },
        { label: '作成しない', description: '何もしない', run: null },
      ],
    },
    planCommand: runCommand('plan', key, templateName, ...argsOfSets(sets)),
  };
}

/**
 * create サブコマンドの結果を返す
 *
 * @param {object} client
 * @param {string} key
 * @param {string} templateName
 * @param {string[]} sets
 * @returns {Promise<object>}
 */
async function create(client, key, templateName, sets) {
  const { parentIssue, items, description, missing, duplicate } = await build(client, key, templateName, sets);
  if (duplicate) return { ok: false, message: `${key} には同じ件名の子課題 ${duplicate.key} があるため、作成しませんでした`, existing: duplicate };
  if (missing.length > 0) return { ok: false, message: `${missing.map((m) => m.label).join('・')}が決まっていません`, ask: missing };

  const get = (field) => items.find((i) => i.field === field).value;
  const params = [
    ['projectId', parentIssue.projectId],
    ['parentIssueId', parentIssue.id],
    ['summary', get('summary')],
    ['issueTypeId', get('issueType').id],
    ['priorityId', get('priority').id],
  ];
  if (description) params.push(['description', description]);
  if (get('assignee')) params.push(['assigneeId', get('assignee').id]);
  if (get('startDate')) params.push(['startDate', get('startDate')]);
  if (get('dueDate')) params.push(['dueDate', get('dueDate')]);
  for (const c of get('category') || []) params.push(['categoryId[]', c.id]);
  for (const m of get('milestone') || []) params.push(['milestoneId[]', m.id]);

  const issue = await client.post('/issues', params);
  return {
    ok: true,
    issue: { key: issue.issueKey, summary: issue.summary, url: `${client.space}/view/${issue.issueKey}` },
    message: `${key} の子課題 ${issue.issueKey}「${issue.summary}」を作成しました`,
  };
}

/**
 * 現在のブランチ名の先頭の課題キーを返す
 *
 * @returns {string|null} git リポジトリでないか、課題キーがないときは null
 */
function keyFromBranch() {
  try {
    const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    // 複合名（PP-1234_PP-1235）は先頭が親課題のため、先頭の課題キーを使う
    return findKeys(branch)[0] || null;
  } catch {
    return null;
  }
}

/**
 * status サブコマンドの結果を返す
 *
 * @param {string} arg 「[課題キー] [雛形]」の文字列
 * @returns {Promise<object>}
 */
async function status(arg) {
  const credentials = loadCredentials();
  if (credentials.error) return { next: 'stop-no-config', message: credentials.error };
  const templates = listTemplates();
  if (templates.length === 0) return { next: 'stop-no-templates', message: `${TEMPLATE_ROOT} に雛形のディレクトリがありません` };

  const tokens = (arg || '').trim().split(/\s+/).filter(Boolean);
  const keyTokens = tokens.filter(isKey);
  if (keyTokens.length > 1) return { next: 'invalid-key', message: `課題キーが複数あります: ${keyTokens.join(' / ')}` };
  const templateName = tokens.filter((t) => !isKey(t)).join(' ');
  const key = keyTokens[0] || keyFromBranch();
  if (!key) return { next: 'ask-key', message: '引数とブランチ名から課題キーを検出できませんでした', templateName };

  const client = createClient(credentials);
  if (templateName && templates.some((t) => t.name === templateName)) return plan(client, key, templateName, []);

  const { parent, children } = await fetchParent(client, key);
  const summaries = new Set(children.map((c) => c.summary));
  const list = templates.map((t) => {
    const { fields } = loadTemplate(t);
    const s = fields.summary;
    // 件名を毎回決める雛形は作成済みかを判定できないため、未作成として扱う
    const summary = s && s.mode === 'fixed' && 'value' in s ? render(String(s.value), parent, client.space) : null;
    return { name: t.name, summary, created: summary !== null && summaries.has(summary) };
  });
  const remaining = list.filter((t) => !t.created);
  const result = {
    parent: { key: parent.issueKey, summary: parent.summary, url: `${client.space}/view/${parent.issueKey}` },
    children: children.map((c) => ({ key: c.issueKey, summary: c.summary, status: c.status && c.status.name })),
    templates: list,
  };
  if (templateName) result.message = `雛形「${templateName}」がありません`;
  if (remaining.length === 0) return { ...result, next: 'all-created', message: `${parent.issueKey} には、どの雛形の子課題も作成済みです` };

  // AskUserQuestion の選択肢は 4 つまでのため、雛形は 3 つまでにする。4 つ目以降は「Other」で名前を入力する
  return {
    ...result,
    next: 'ask-template',
    question: {
      question: `${parent.issueKey}「${parent.summary}」にどの子課題を作成しますか？`,
      options: [
        ...remaining.slice(0, 3).map((t) => ({ label: t.name, description: t.summary ? `件名「${t.summary}」` : '件名は作成の前に決める', run: runCommand('plan', key, t.name) })),
        { label: '作成しない', description: '何もしない', run: null },
      ],
    },
  };
}

/**
 * コマンドライン引数を位置引数と --set の指定に分けて返す
 *
 * @param {string[]} argv
 * @returns {{positional: string[], sets: string[]}}
 */
function parseArgs(argv) {
  const positional = [];
  const sets = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--set') sets.push(argv[++i] ?? '');
    else positional.push(argv[i].trim());
  }
  return { positional, sets };
}

/**
 * サブコマンドを実行し、結果を返す
 *
 * @param {string} command
 * @param {string[]} argv
 * @returns {Promise<object>}
 */
async function main(command, argv) {
  if (command === 'status') return status(argv.join(' '));
  if (command !== 'plan' && command !== 'create') return { ok: false, message: `不明なサブコマンドです: ${command}` };

  const { positional, sets } = parseArgs(argv);
  const [key, ...rest] = positional;
  if (!isKey(key || '')) return { ok: false, message: `「${key || ''}」は課題キーではありません` };
  const templateName = rest.join(' ');
  if (!templateName) return { ok: false, message: '雛形の名前を指定してください' };
  const credentials = loadCredentials();
  if (credentials.error) return { ok: false, next: 'stop-no-config', message: credentials.error };

  const client = createClient(credentials);
  return command === 'plan' ? plan(client, key, templateName, sets) : create(client, key, templateName, sets);
}

main(process.argv[2], process.argv.slice(3))
  .catch((e) => ({ ok: false, next: 'error', message: e instanceof BacklogError ? e.message : `${e.name}: ${e.message}` }))
  .then((output) => process.stdout.write(JSON.stringify(output, null, 2) + '\n'));
