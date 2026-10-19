// Demo data. `npm run seed` = small realistic dataset (every Needs-Attention group populated).
// `npm run seed:large` additionally inserts ~50 000 items and ~500 000 events and prints EXPLAIN ANALYZE output.
// `--reset` wipes all data first. Demo password for every user: Passw0rd!demo (development only).

import { loadConfig } from '../config.js';
import { createPool, rows, one, type Pool } from '../db.js';
import { hashPassword } from '../auth/passwords.js';
import { appendEvent } from '../domain/events.js';
import { KIND_REQUIRES_APPROVAL } from '../../shared/contract.js';

export const DEMO_PASSWORD = 'Passw0rd!demo';
const args = new Set(process.argv.slice(2));

const USERS = [
  { key: 'ava', name: 'Ananya Iyer', email: 'ananya@kaveri.test' },
  { key: 'liam', name: 'Vikram Nair', email: 'vikram@kaveri.test' },
  { key: 'noor', name: 'Priya Sharma', email: 'priya@kaveri.test' },
  { key: 'raj', name: 'Rajesh Menon', email: 'rajesh@kaveri.test' },
  { key: 'mei', name: 'Meera Reddy', email: 'meera@kaveri.test' },
  { key: 'sam', name: 'Siddharth Rao', email: 'siddharth@kaveri.test' },
  { key: 'zoe', name: 'Zoya Khan', email: 'zoya@kaveri.test' },
] as const;
const TEAMS = ['Support', 'Platform', 'Finance', 'Legal'] as const;
const MEMBERSHIPS: Array<[string, (typeof TEAMS)[number], string[]]> = [
  ['ava', 'Support', ['admin']], ['ava', 'Platform', ['admin']], ['ava', 'Finance', ['admin']],
  ['liam', 'Support', ['lead', 'member']],
  ['noor', 'Support', ['member']], ['noor', 'Platform', ['member']],
  ['raj', 'Finance', ['approver']],
  ['mei', 'Finance', ['lead', 'member']], ['mei', 'Platform', ['member']],
  ['sam', 'Platform', ['member']],
  ['zoe', 'Legal', ['member']],
];

type Ids = Record<string, string>;

async function reset(pool: Pool): Promise<void> {
  // work_item_events is append-only by trigger (UPDATE/DELETE), but TRUNCATE is not blocked: fine for a dev reset.
  await pool.query('TRUNCATE notifications, outbox_jobs, idempotency_keys, work_item_events, work_items, membership_changes, memberships, sessions, teams, users CASCADE');
}

async function seedPeople(pool: Pool): Promise<{ users: Ids; teams: Ids }> {
  const hash = await hashPassword(DEMO_PASSWORD);
  const users: Ids = {};
  for (const u of USERS) {
    users[u.key] = (await one<{ id: string }>(pool, 'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id', [u.email, u.name, hash]))!.id;
  }
  const teams: Ids = {};
  for (const t of TEAMS) teams[t] = (await one<{ id: string }>(pool, 'INSERT INTO teams (name) VALUES ($1) RETURNING id', [t]))!.id;
  for (const [u, t, roles] of MEMBERSHIPS) {
    for (const role of roles) await pool.query('INSERT INTO memberships (team_id, user_id, role) VALUES ($1, $2, $3)', [teams[t], users[u], role]);
  }
  return { users, teams };
}

interface Demo {
  team: (typeof TEAMS)[number];
  title: string;
  description: string;
  kind: string;
  status: string;
  priority: string;
  requester: string;
  assignee?: string;
  dueInHours?: number;
  ageHours?: number;
  resolution?: string;
}

const DEMOS: Demo[] = [
  { team: 'Support', title: 'Customer cannot log in after password reset', description: 'Admin at Sundaram Textiles reports the reset email arrives but the link says expired.', kind: 'customer_issue', status: 'new', priority: 'urgent', requester: 'noor', ageHours: 3 },
  { team: 'Support', title: 'Refund not received for order 4411', description: 'Customer was refunded 9 days ago per our records but the UPI/bank statement shows nothing.', kind: 'customer_issue', status: 'in_progress', priority: 'high', requester: 'liam', assignee: 'noor', dueInHours: -20, ageHours: 100 },
  { team: 'Support', title: 'Update macros for the new returns policy', description: 'Agents are still quoting the 14-day window.', kind: 'task', status: 'triaged', priority: 'medium', requester: 'liam', assignee: 'noor', ageHours: 120 },
  { team: 'Support', title: 'Duplicate charge reported by two customers', description: 'Possibly related to yesterday\'s checkout deploy.', kind: 'incident', status: 'resolved', priority: 'high', requester: 'noor', assignee: 'liam', resolution: 'Rolled back checkout deploy; refunded both customers.', ageHours: 30 },
  { team: 'Support', title: 'Customer asks for data export', description: 'Needs CSV of all tickets from 2025.', kind: 'customer_issue', status: 'new', priority: 'low', requester: 'noor', ageHours: 10 },
  { team: 'Platform', title: 'API latency spike on /v2/search', description: 'p95 doubled since 14:30 IST.', kind: 'incident', status: 'in_progress', priority: 'urgent', requester: 'sam', assignee: 'sam', ageHours: 2 },
  { team: 'Platform', title: 'Rotate the staging database credentials', description: 'Quarterly rotation.', kind: 'task', status: 'new', priority: 'medium', requester: 'ava', ageHours: 50 },
  { team: 'Platform', title: 'Grant read access to analytics bucket for Priya', description: 'Needed for the churn analysis.', kind: 'access_request', status: 'pending_approval', priority: 'medium', requester: 'noor', assignee: 'sam', ageHours: 20 },
  { team: 'Finance', title: 'Vendor payment of ₹12,40,000 stuck in review', description: 'Invoice INV-7731 from Lakshmi Packaging Pvt Ltd; bank flagged the beneficiary account.', kind: 'payment', status: 'pending_approval', priority: 'high', requester: 'mei', assignee: 'mei', ageHours: 6 },
  { team: 'Finance', title: 'Quarterly GST compliance filing', description: 'Collect ledger exports and file on the GST portal.', kind: 'compliance', status: 'in_progress', priority: 'high', requester: 'ava', assignee: 'mei', dueInHours: 72, ageHours: 200 },
  { team: 'Finance', title: 'Chargeback dispute: customer 9921', description: 'Evidence due in 5 days.', kind: 'payment', status: 'new', priority: 'urgent', requester: 'mei', ageHours: 1 },
  { team: 'Legal', title: 'Review updated DPA template', description: 'Outbound template needs the new sub-processor list and DPDP Act wording.', kind: 'compliance', status: 'new', priority: 'medium', requester: 'zoe', ageHours: 5 },
];

async function seedDemo(pool: Pool, users: Ids, teams: Ids): Promise<void> {
  for (const d of DEMOS) {
    const age = d.ageHours ?? 1;
    const it = await one<{ id: string }>(
      pool,
      `INSERT INTO work_items (team_id, title, description, kind, status, priority, requester_id, assignee_id, requires_approval, resolution, due_at, created_at, last_activity_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + ($11::int * interval '1 hour'), now() - ($12::int * interval '1 hour'), now() - ($12::int * interval '1 hour'))
       RETURNING id`,
      [teams[d.team], d.title, d.description, d.kind, d.status, d.priority, users[d.requester], d.assignee ? users[d.assignee] : null, KIND_REQUIRES_APPROVAL[d.kind] ?? false, d.resolution ?? null, d.dueInHours ?? null, age],
    );
    await appendEvent(pool, { itemId: it!.id, teamId: teams[d.team]!, actorId: users[d.requester]!, type: 'created', data: { title: d.title, kind: d.kind, priority: d.priority } });
    if (d.assignee) await appendEvent(pool, { itemId: it!.id, teamId: teams[d.team]!, actorId: users[d.assignee]!, type: 'claimed', data: { to: { id: users[d.assignee], name: d.assignee } } });
  }
  // Pin timestamps back so the "stale" and "overdue" rules fire (BUMP-less direct update is fine for seed data).
  await pool.query(`UPDATE work_items SET last_activity_at = now() - interval '5 days', stale_notified_at = NULL WHERE title = 'Update macros for the new returns policy'`);
  await pool.query(`UPDATE work_items SET last_activity_at = now() - interval '4 days' WHERE title = 'Rotate the staging database credentials'`);
  await pool.query(`UPDATE work_items SET last_activity_at = now() - interval '9 days' WHERE title = 'Quarterly GST compliance filing'`);
}

async function seedLarge(pool: Pool, n = 50_000): Promise<void> {
  console.log(`inserting ${n} items…`);
  await pool.query(
    `WITH tm AS (
       SELECT row_number() OVER (ORDER BY t.name) AS rn, t.id AS team_id,
              array_agg(DISTINCT m.user_id) FILTER (WHERE m.role IN ('member','lead','admin')) AS workers
         FROM teams t JOIN memberships m ON m.team_id = t.id GROUP BY t.id
     ), n AS (SELECT count(*) AS c FROM tm),
     src AS (SELECT g, 1 + (g % (SELECT c FROM n)) AS rn, g % 20 AS b FROM generate_series(1, $1::int) g),
     typed AS (
       SELECT s.*, tm.team_id, tm.workers,
              CASE WHEN s.b IN (12, 13) THEN 'payment' ELSE (ARRAY['customer_issue','incident','payment','compliance','access_request','task'])[1 + (s.g % 6)] END AS kind,
              CASE WHEN s.b <= 5 THEN 'new' WHEN s.b <= 8 THEN 'triaged' WHEN s.b <= 11 THEN 'in_progress' WHEN s.b = 12 THEN 'pending_approval'
                   WHEN s.b = 13 THEN 'approved' WHEN s.b <= 15 THEN 'resolved' WHEN s.b <= 18 THEN 'closed' ELSE 'cancelled' END AS status
         FROM src s JOIN tm USING (rn)
     )
     INSERT INTO work_items (team_id, title, description, kind, status, priority, requester_id, assignee_id, requires_approval, resolution, due_at, created_at, last_activity_at)
     SELECT team_id,
            (ARRAY['Refund','Login','Invoice','Outage','Access','Audit','Chargeback','Latency','Export','Onboarding'])[1 + g % 10] || ' ' ||
              (ARRAY['failing','delayed','missing','duplicated','blocked','unclear','escalated','stuck','wrong','slow'])[1 + (g / 10) % 10] || ' for account ' || g,
            'Seeded description for load testing, item ' || g,
            kind, status, (ARRAY['low','medium','high','urgent'])[1 + g % 4],
            workers[1 + g % array_length(workers, 1)],
            CASE WHEN status IN ('in_progress','pending_approval','approved','resolved','closed') THEN workers[1 + (g + 1) % array_length(workers, 1)] END,
            kind IN ('payment','compliance','access_request'),
            CASE WHEN status IN ('resolved','closed') THEN 'Seeded resolution' END,
            CASE WHEN g % 7 = 0 THEN now() + ((g % 200) - 100) * interval '1 hour' END,
            now() - g * interval '10 minutes', now() - g * interval '10 minutes'
       FROM typed`,
    [n],
  );
  console.log('inserting events…');
  await pool.query(
    `INSERT INTO work_item_events (item_id, team_id, actor_id, type, body, created_at)
     SELECT i.id, i.team_id, i.requester_id, CASE WHEN k = 0 THEN 'created' ELSE 'comment' END,
            CASE WHEN k = 0 THEN NULL ELSE 'Seeded comment ' || k END, i.created_at + k * interval '1 minute'
       FROM work_items i CROSS JOIN generate_series(0, 9) k WHERE i.description LIKE 'Seeded description%'`,
  );
  await pool.query('ANALYZE');
  const counts = await one<{ items: number; events: number }>(pool, 'SELECT (SELECT count(*) FROM work_items)::int AS items, (SELECT count(*) FROM work_item_events)::int AS events');
  console.log(`now: ${counts?.items} items, ${counts?.events} events`);
  await explain(pool);
}

async function explain(pool: Pool): Promise<void> {
  const team = (await one<{ id: string }>(pool, `SELECT id FROM teams WHERE name = 'Support'`))!.id;
  const all = (await rows<{ id: string }>(pool, 'SELECT id FROM teams')).map((r) => r.id);
  const active = `('new','triaged','in_progress','pending_approval','approved')`;
  const cases: Array<[string, string, unknown[]]> = [
    ['default list (all my teams, active, newest activity, first page)', `SELECT i.id FROM work_items i WHERE i.team_id = ANY($1::uuid[]) AND i.status IN ${active} ORDER BY i.last_activity_at DESC, i.id DESC LIMIT 26`, [all]],
    ['single-team list (first page)', `SELECT i.id FROM work_items i WHERE i.team_id = ANY($1::uuid[]) AND i.status IN ${active} ORDER BY i.last_activity_at DESC, i.id DESC LIMIT 26`, [[team]]],
    ['deep keyset page (cursor 30 days back)', `SELECT i.id FROM work_items i WHERE i.team_id = ANY($1::uuid[]) AND i.status IN ${active} AND (i.last_activity_at, i.id) < (now() - interval '30 days', 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid) ORDER BY i.last_activity_at DESC, i.id DESC LIMIT 26`, [all]],
    ['full-text search', `SELECT i.id FROM work_items i WHERE i.team_id = ANY($1::uuid[]) AND i.status IN ${active} AND i.search @@ to_tsquery('simple', 'refund:* & failing:*') ORDER BY i.last_activity_at DESC, i.id DESC LIMIT 26`, [all]],
    ['attention: unassigned urgent', `SELECT i.id FROM work_items i WHERE i.priority = 'urgent' AND i.assignee_id IS NULL AND i.status IN ('new','triaged') AND i.team_id = ANY($1::uuid[]) ORDER BY i.created_at ASC, i.id LIMIT 5`, [all]],
    ['duplicate check (trigram)', `SELECT id, similarity(title, 'Refund failing for account 7') AS sim FROM work_items WHERE team_id = $1 AND status IN ${active} AND title % 'Refund failing for account 7' ORDER BY sim DESC LIMIT 5`, [team]],
  ];
  for (const [name, sql, params] of cases) {
    const plan = await rows<{ 'QUERY PLAN': string }>(pool, `EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
    console.log(`\n### ${name}\n${plan.map((r) => r['QUERY PLAN']).join('\n')}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, 4);
  try {
    if (args.has('--reset')) await reset(pool);
    const existing = await one<{ n: number }>(pool, 'SELECT count(*)::int AS n FROM users');
    if ((existing?.n ?? 0) > 0) {
      console.log('Database already has users; skipping demo seed (use --reset to wipe and re-seed).');
    } else {
      const { users, teams } = await seedPeople(pool);
      await seedDemo(pool, users, teams);
      console.log(`Seeded ${USERS.length} users, ${TEAMS.length} teams and ${DEMOS.length} demo items. Password for all demo users: ${DEMO_PASSWORD}`);
    }
    if (args.has('--large')) await seedLarge(pool);
  } finally {
    await pool.end();
  }
}

await main();
