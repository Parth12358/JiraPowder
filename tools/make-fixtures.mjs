#!/usr/bin/env node
// Writes synthetic fixtures in mcp-atlassian 0.23 output format (see NOTES.md → Phase 2) to
// src-tauri/tests/fixtures/, plus the expected normalizer output for each.
//
// The expected Ticket values come from the truth table below, NOT from the Rust normalizer,
// so the fixture tests are an independent check.
//
//   node tools/make-fixtures.mjs
//
// Real, redacted fixtures from your Jira (tools/redact.mjs) can sit next to these.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'tests', 'fixtures');
const SITE = 'https://example.atlassian.net';
const SP = 'customfield_10016';
const SPRINT = 'customfield_10020';
const ME = 'acc-0001';

const PEOPLE = {
  'Parth': ME,
  'Maya Chen': 'acc-0002',
  'Dev Patel': 'acc-0003',
  'Sam Okafor': 'acc-0004',
  'Lena Ruiz': 'acc-0005',
};
const SPRINTS = {
  S42: { id: 42, name: 'PAY Sprint 42', state: 'closed', boardId: 7 },
  S43: { id: 43, name: 'PAY Sprint 43', state: 'active', boardId: 7 },
  S44: { id: 44, name: 'PAY Sprint 44', state: 'future', boardId: 7 },
};
const STATUS = {
  todo: { name: 'To Do', category: 'To Do', color: 'blue-gray' },
  prog: { name: 'In Progress', category: 'In Progress', color: 'yellow' },
  review: { name: 'In Review', category: 'In Progress', color: 'yellow' },
  done: { name: 'Done', category: 'Done', color: 'green' },
};
const TYPE = { story: 'Story', task: 'Task', bug: 'Bug' };
const PRI = { high: 'High', med: 'Medium', low: 'Low' };
const EPIC = { id: '10050', key: 'PAY-50', summary: 'Payouts v2' };

// Same 16 tickets as src/sample.ts.
const ROWS = [
  ['PAY-101', 'task', 'med', 'Define payout ledger schema', 'done', 'Maya Chen', 'S42', 3, []],
  ['PAY-110', 'task', 'med', 'Auth scopes for payouts API', 'done', 'Dev Patel', 'S42', 2, []],
  ['PAY-102', 'task', 'high', 'Migrate ledger tables to Postgres 16', 'prog', 'Parth', 'S43', 5, ['PAY-101']],
  ['PAY-111', 'story', 'med', 'Rate limiting on write endpoints', 'prog', 'Dev Patel', 'S43', 3, ['PAY-110']],
  ['PAY-106', 'story', 'med', 'Retry and idempotency keys', 'review', 'Maya Chen', 'S43', 3, ['PAY-101']],
  ['PAY-103', 'story', 'high', 'Ledger write API', 'todo', 'Parth', 'S43', 5, ['PAY-102', 'PAY-111']],
  ['PAY-115', 'bug', 'high', 'Fix currency rounding on JPY payouts', 'prog', 'Parth', 'S43', 1, []],
  ['PAY-104', 'story', 'high', 'Payout scheduler service', 'todo', 'Dev Patel', 'S43', 8, ['PAY-103']],
  ['PAY-105', 'story', 'med', 'NACHA bank file export', 'todo', 'Sam Okafor', 'S43', 5, ['PAY-103']],
  ['PAY-113', 'task', 'low', 'Payouts API reference docs', 'todo', 'Lena Ruiz', 'S43', 2, ['PAY-103']],
  ['PAY-107', 'story', 'med', 'Payout status webhooks', 'todo', 'Parth', 'S43', 5, ['PAY-104', 'PAY-106']],
  ['PAY-109', 'story', 'med', 'Nightly reconciliation job', 'todo', 'Sam Okafor', 'S43', 5, ['PAY-105', 'PAY-103']],
  ['PAY-108', 'story', 'med', 'Admin payouts dashboard', 'todo', 'Lena Ruiz', 'S44', 8, ['PAY-107']],
  ['PAY-112', 'task', 'med', 'Load test payout flow', 'todo', 'Parth', 'S44', 3, ['PAY-104', 'PAY-109']],
  ['PAY-116', 'task', 'low', 'Regenerate SDK types', 'todo', 'Lena Ruiz', 'S44', 1, ['PAY-113']],
  ['PAY-114', 'task', 'low', 'Feature-flag rollout plan', 'todo', 'Maya Chen', 'S44', 2, ['PAY-112', 'PAY-108']],
].map(([k, ty, pr, t, s, a, sp, p, by]) => ({ k, ty, pr, t, s, a, sp, p, by }));

const byKey = Object.fromEntries(ROWS.map((r) => [r.k, r]));
const blocksOf = (k) => ROWS.filter((r) => r.by.includes(k)).map((r) => r.k);
const num = (k) => 10000 + Number(k.split('-')[1]);
const BLOCKS = { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
const RELATES = { id: '10003', name: 'Relates', inward: 'relates to', outward: 'relates to' };

const linkedIssue = (k) => {
  const r = byKey[k];
  return {
    id: String(num(k)),
    key: k,
    fields: { summary: r.t, status: STATUS[r.s], priority: { name: PRI[r.pr] }, issuetype: { name: TYPE[r.ty] } },
  };
};
const user = (name) => ({
  account_id: PEOPLE[name],
  display_name: name,
  name,
  email: `${name.split(' ')[0].toLowerCase()}@example.com`,
  avatar_url: `${SITE}/avatar/${PEOPLE[name]}`,
});

/** One issue exactly as mcp-atlassian's JiraIssue.to_simplified_dict() prints it. */
function simplified(r) {
  let linkId = 20000 + num(r.k) * 10;
  const issuelinks = [
    ...r.by.map((b) => ({ id: String(linkId++), type: BLOCKS, inward_issue: linkedIssue(b) })),
    ...blocksOf(r.k).map((d) => ({ id: String(linkId++), type: BLOCKS, outward_issue: linkedIssue(d) })),
  ];
  return {
    id: String(num(r.k)),
    key: r.k,
    summary: r.t,
    browse_url: `${SITE}/browse/${r.k}`,
    status: STATUS[r.s],
    issue_type: { name: TYPE[r.ty] },
    priority: { name: PRI[r.pr] },
    parent: {
      id: EPIC.id,
      key: EPIC.key,
      self: `${SITE}/rest/api/3/issue/${EPIC.id}`,
      fields: { summary: EPIC.summary, status: STATUS.prog, priority: { name: 'Medium' }, issuetype: { name: 'Epic' } },
    },
    assignee: user(r.a),
    issuelinks,
    [SP]: { value: r.p, name: 'Story point estimate' },
    [SPRINT]: {
      value: [{ ...SPRINTS[r.sp], goal: '', startDate: '2026-10-12T09:00:00.000Z', endDate: '2026-10-26T09:00:00.000Z' }],
      name: 'Sprint',
    },
  };
}

/** Expected Ticket (src/types.ts) for a truth-table row. */
function expected(r, inScope) {
  const name = r.a;
  return {
    key: r.k,
    summary: r.t,
    status: r.s,
    statusName: STATUS[r.s].name,
    type: r.ty,
    typeName: TYPE[r.ty],
    priority: r.pr,
    assignee: { name, initials: name.split(' ').slice(0, 2).map((w) => w[0].toUpperCase()).join('') },
    isMine: PEOPLE[name] === ME,
    sprint: { id: SPRINTS[r.sp].id, name: SPRINTS[r.sp].name, state: SPRINTS[r.sp].state },
    points: r.p,
    epic: EPIC.summary,
    blockedBy: [...r.by],
    blocks: blocksOf(r.k),
    url: `${SITE}/browse/${r.k}`,
    inScope,
  };
}

const search = (issues, extra = {}) => ({ total: issues.length, start_at: 0, max_results: 50, issues, ...extra });
/** MCP CallToolResult with the JSON in a text block (FastMCP's `-> str` tools). */
const textResult = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: false });
/** Same, but also with structuredContent {result: "<json>"} as newer FastMCP versions send. */
const structuredResult = (payload) => ({ ...textResult(payload), structuredContent: { result: JSON.stringify(payload, null, 2) } });

const write = (name, v) => {
  writeFileSync(join(OUT, name), JSON.stringify(v, null, 2) + '\n');
  console.log('wrote', name);
};
mkdirSync(OUT, { recursive: true });

// --- the sample project, as the fake server serves it ---
write('fake-issues.json', { site: SITE, me: ME, issues: ROWS.map(simplified) });

// --- scope search: open sprints (S43) ---
const inSprint = ROWS.filter((r) => r.sp === 'S43');
write('search_open_sprints.json', structuredResult(search(inSprint.map(simplified))));
write('search_open_sprints.expected.json', inSprint.map((r) => expected(r, true)));

// --- "mine" search: summary only ---
const mine = inSprint.filter((r) => PEOPLE[r.a] === ME);
write('search_mine.json', textResult(search(mine.map((r) => ({ id: String(num(r.k)), key: r.k, summary: r.t })))));

// --- linked tickets outside the scope, fetched with key in (...) ---
const linked = ['PAY-101', 'PAY-110', 'PAY-108', 'PAY-112', 'PAY-116'];
write('search_linked.json', textResult(search(linked.map((k) => simplified(byKey[k])))));
write('search_linked.expected.json', linked.map((k) => ({ ...expected(byKey[k], false), isMine: false })));

// --- jira_get_issue returns one simplified issue (no search wrapper) ---
write('get_issue.json', textResult(simplified(byKey['PAY-103'])));
write('get_issue.expected.json', [expected(byKey['PAY-103'], true)].map((t) => ({ ...t, isMine: false })));

// --- empty result ---
write('empty.json', textResult(search([])));

// --- hand-written edge cases ---
const edge = [
  // Unassigned (mcp-atlassian prints {"display_name": "Unassigned"}), no sprint, no points,
  // a non-Blocks link that must be ignored, and a Blocks link to an issue outside the result.
  {
    id: '30001',
    key: 'EDGE-1',
    summary: 'Unassigned, unscheduled',
    status: { name: 'Backlog', category: 'To Do', color: 'blue-gray' },
    issue_type: { name: 'Task' },
    assignee: { display_name: 'Unassigned' },
    issuelinks: [
      { id: '1', type: RELATES, outward_issue: { id: '30002', key: 'EDGE-2', fields: { summary: 'x' } } },
      { id: '2', type: BLOCKS, outward_issue: { id: '39999', key: 'OUT-9', fields: { summary: 'y' } } },
    ],
  },
  // A Blocks cycle: EDGE-2 blocks EDGE-3 and EDGE-3 blocks EDGE-2.
  {
    id: '30002',
    key: 'EDGE-2',
    summary: 'Cycle A',
    status: { name: 'In Progress', category: 'In Progress', color: 'yellow' },
    issue_type: { name: 'Bug' },
    priority: { name: 'Lowest' },
    assignee: user('Maya Chen'),
    issuelinks: [
      { id: '3', type: BLOCKS, outward_issue: { id: '30003', key: 'EDGE-3' } },
      { id: '4', type: BLOCKS, inward_issue: { id: '30003', key: 'EDGE-3' } },
    ],
    [SP]: { value: 2.5, name: 'Story point estimate' },
    [SPRINT]: { value: [], name: 'Sprint' },
  },
  // Raw Jira REST shape (fields.*, camelCase links, statusCategory.key), a Server-style
  // sprint string list, QA status → review, Sub-task → task, Highest priority.
  {
    id: '30003',
    key: 'EDGE-3',
    fields: {
      summary: 'Cycle B, raw REST shape',
      status: { name: 'In QA', statusCategory: { key: 'indeterminate', name: 'In Progress' } },
      issuetype: { name: 'Sub-task' },
      priority: { name: 'Highest' },
      assignee: { displayName: 'ada lovelace king', accountId: 'acc-0099' },
      issuelinks: [
        { id: '5', type: { name: 'blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'EDGE-2' } },
        { id: '6', type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'EDGE-2' } },
      ],
      [SP]: 1,
      [SPRINT]: [
        'com.atlassian.greenhopper.service.sprint.Sprint@1a[id=9,rapidViewId=2,state=CLOSED,name=Old Sprint,startDate=<null>]',
        'com.atlassian.greenhopper.service.sprint.Sprint@1b[id=12,rapidViewId=2,state=FUTURE,name=Later Sprint,startDate=<null>]',
        'com.atlassian.greenhopper.service.sprint.Sprint@1c[id=11,rapidViewId=2,state=FUTURE,name=Next Sprint,startDate=<null>]',
      ],
      parent: { key: 'EDGE-0', fields: { summary: 'Edge epic' } },
    },
  },
  // Missing summary → skipped with a warning.
  { id: '30004', key: 'EDGE-4', status: { name: 'To Do', category: 'To Do' } },
];
write('edge_cases.json', textResult(search(edge)));
const base = { typeName: '', epic: null, blockedBy: [], blocks: [], isMine: false, inScope: true };
write('edge_cases.expected.json', [
  {
    ...base,
    key: 'EDGE-1',
    summary: 'Unassigned, unscheduled',
    status: 'todo',
    statusName: 'Backlog',
    type: 'task',
    typeName: 'Task',
    priority: 'none',
    assignee: null,
    sprint: null,
    points: null,
    blocks: ['OUT-9'],
    url: `${SITE}/browse/EDGE-1`,
  },
  {
    ...base,
    key: 'EDGE-2',
    summary: 'Cycle A',
    status: 'prog',
    statusName: 'In Progress',
    type: 'bug',
    typeName: 'Bug',
    priority: 'lowest',
    assignee: { name: 'Maya Chen', initials: 'MC' },
    sprint: null,
    points: 2.5,
    blockedBy: ['EDGE-3'],
    blocks: ['EDGE-3'],
    url: `${SITE}/browse/EDGE-2`,
  },
  {
    ...base,
    key: 'EDGE-3',
    summary: 'Cycle B, raw REST shape',
    status: 'review',
    statusName: 'In QA',
    type: 'task',
    typeName: 'Sub-task',
    priority: 'highest',
    assignee: { name: 'ada lovelace king', initials: 'AL' },
    sprint: { id: 11, name: 'Next Sprint', state: 'future' },
    points: 1,
    epic: 'Edge epic',
    blockedBy: ['EDGE-2'],
    blocks: ['EDGE-2'],
    url: `${SITE}/browse/EDGE-3`,
  },
]);
