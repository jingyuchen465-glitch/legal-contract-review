exports.up = async db => {
  await db.schema.alterTable('la_outbox', t => { t.timestamp('retired_at'); t.string('retired_reason'); });
  await db.schema.createTable('la_agent_sessions', t => {
    t.uuid('id').primary(); t.uuid('contract_id').notNullable().references('id').inTable('la_contracts');
    t.uuid('version_id').notNullable().references('id').inTable('la_versions');
    t.uuid('created_by').notNullable().references('id').inTable('la_users');
    t.string('harness_id'); t.string('status').notNullable().defaultTo('queued');
    t.uuid('current_review_id'); t.jsonb('manifest').notNullable();
    t.jsonb('notes').notNullable().defaultTo('{}'); t.jsonb('read_ranges').notNullable().defaultTo('{}');
    t.timestamps(true, true); t.index(['contract_id', 'created_at']);
  });
  await db.schema.alterTable('la_reviews', t => {
    t.string('engine').notNullable().defaultTo('legacy');
    t.uuid('agent_session_id').references('id').inTable('la_agent_sessions');
    t.jsonb('agent_result');
  });
  await db.schema.alterTable('la_findings', t => { t.string('rule_id').nullable().alter(); });
  await db.schema.createTable('la_agent_messages', t => {
    t.uuid('id').primary(); t.uuid('session_id').notNullable().references('id').inTable('la_agent_sessions');
    t.uuid('review_id').notNullable().references('id').inTable('la_reviews');
    t.uuid('created_by').references('id').inTable('la_users');
    t.string('role').notNullable(); t.string('kind').notNullable().defaultTo('message');
    t.text('content').notNullable(); t.string('client_key'); t.jsonb('data').notNullable().defaultTo('{}');
    t.timestamps(true, true); t.unique(['session_id', 'client_key']); t.index(['session_id', 'created_at']);
  });
  await db.schema.createTable('la_agent_events', t => {
    t.bigIncrements('id'); t.uuid('session_id').notNullable().references('id').inTable('la_agent_sessions');
    t.uuid('review_id').notNullable().references('id').inTable('la_reviews');
    t.string('type').notNullable(); t.jsonb('data').notNullable().defaultTo('{}');
    t.timestamp('created_at').notNullable().defaultTo(db.fn.now()); t.index(['session_id', 'id']);
  });
  await db.schema.createTable('la_agent_tool_calls', t => {
    t.uuid('id').primary(); t.uuid('review_id').notNullable().references('id').inTable('la_reviews');
    t.string('call_id').notNullable(); t.string('name').notNullable(); t.string('args_hash').notNullable();
    t.string('status').notNullable(); t.jsonb('result'); t.timestamps(true, true);
    t.unique(['review_id', 'call_id']);
  });
  await db.schema.createTable('la_agent_legal_events', t => {
    t.uuid('id').primary(); t.string('event_key').notNullable().unique();
    t.uuid('contract_id').notNullable().references('id').inTable('la_contracts');
    t.uuid('review_id').references('id').inTable('la_reviews'); t.uuid('actor_id').notNullable().references('id').inTable('la_users');
    t.string('kind').notNullable(); t.jsonb('source').notNullable();
    t.string('status').notNullable().defaultTo('queued'); t.text('error'); t.timestamp('revoked_at');
    t.timestamps(true, true);
  });
  await db.schema.createTable('la_agent_memories', t => {
    t.uuid('id').primary(); t.uuid('source_id').notNullable().references('id').inTable('la_agent_legal_events');
    t.string('department').notNullable().defaultTo(''); t.string('fingerprint').notNullable();
    t.string('kind').notNullable(); t.string('title').notNullable(); t.text('description').notNullable();
    t.text('content').notNullable(); t.jsonb('conditions').notNullable().defaultTo('[]');
    t.string('state').notNullable().defaultTo('active'); t.integer('version').notNullable().defaultTo(1);
    t.timestamps(true, true); t.unique(['source_id', 'fingerprint']); t.index(['department', 'state']);
  });
  await db.schema.createTable('la_agent_sources', t => {
    t.uuid('id').primary(); t.uuid('review_id').notNullable().references('id').inTable('la_reviews');
    t.string('kind').notNullable(); t.text('url'); t.string('title').notNullable(); t.text('content').notNullable();
    t.string('sha256').notNullable(); t.string('effective_date'); t.string('validity').notNullable().defaultTo('unverified');
    t.timestamp('fetched_at').notNullable().defaultTo(db.fn.now());
    t.unique(['review_id', 'sha256']);
  });
};
exports.down = async () => { throw new Error('审查会话、法务处理和经验来源必须保留；请从备份恢复。'); };
