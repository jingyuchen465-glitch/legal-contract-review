const { randomUUID } = require('node:crypto');

exports.up = async db => {
  await db.schema.alterTable('la_agent_legal_events', t => { t.integer('revision').notNullable().defaultTo(1); t.jsonb('generated_counts'); });
  await db.schema.alterTable('la_agent_memories', t => {
    t.uuid('source_id').nullable().alter();
    t.integer('revision').notNullable().defaultTo(1);
    t.string('origin').notNullable().defaultTo('generated');
    t.uuid('created_by').references('id').inTable('la_users');
    t.string('draft_status').notNullable().defaultTo('none');
  });
  await db.schema.createTable('la_agent_memory_versions', t => {
    t.uuid('id').primary();
    t.uuid('memory_id').notNullable().references('id').inTable('la_agent_memories').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.string('status').notNullable();
    t.jsonb('body').notNullable();
    t.uuid('created_by').references('id').inTable('la_users');
    t.uuid('reviewed_by').references('id').inTable('la_users');
    t.text('review_note'); t.timestamp('reviewed_at');
    t.timestamps(true, true);
    t.unique(['memory_id', 'version']);
  });
  // One editable/reviewable successor per knowledge item, enforced in PostgreSQL.
  await db.raw("CREATE UNIQUE INDEX la_agent_memory_one_draft ON la_agent_memory_versions(memory_id) WHERE status IN ('draft','pending','rejected')");
  // Early sources may have no per-kind learned audit. Freeze totals before CRUD can delete rows.
  await db.raw(`UPDATE la_agent_legal_events e SET generated_counts = (
    SELECT jsonb_build_object('count', count(*), 'skillCount', count(*) FILTER (WHERE kind = 'skill'), 'experienceCount', count(*) FILTER (WHERE kind = 'experience'))
    FROM la_agent_memories m WHERE m.source_id = e.id
  )`);
  const rows = await db('la_agent_memories');
  for (const row of rows) {
    await db('la_agent_memory_versions').insert({ id: randomUUID(), memory_id: row.id, version: row.version, status: 'published', body: JSON.stringify({ kind: row.kind, title: row.title, description: row.description, content: row.content, conditions: row.conditions }), created_at: row.created_at, updated_at: row.updated_at });
  }
};
exports.down = async () => { throw new Error('知识版本及审核记录须保留，请从备份恢复。'); };
