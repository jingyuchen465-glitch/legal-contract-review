exports.up = async function (db) {
  await db.schema.createTable('la_users', t => {
    t.uuid('id').primary(); t.string('username').notNullable().unique(); t.string('password_hash').notNullable();
    t.string('display_name').notNullable(); t.string('department').notNullable().defaultTo('');
    t.jsonb('roles').notNullable(); t.boolean('active').notNullable().defaultTo(true); t.integer('revision').notNullable().defaultTo(1); t.timestamps(true, true);
  });
  await db.schema.createTable('la_contracts', t => {
    t.uuid('id').primary(); t.string('number').notNullable().unique(); t.string('title').notNullable();
    t.uuid('submitter_id').references('id').inTable('la_users'); t.uuid('reviewer_id').references('id').inTable('la_users');
    t.string('department').notNullable().defaultTo(''); t.string('source').notNullable().defaultTo('manual');
    t.jsonb('source_data').notNullable().defaultTo('{}'); t.jsonb('background').notNullable().defaultTo('{}');
    t.uuid('current_version_id'); t.uuid('current_review_id'); t.jsonb('classification');
    t.string('legal_status').notNullable().defaultTo('pending_review'); t.integer('revision').notNullable().defaultTo(1); t.timestamps(true, true);
    t.index(['submitter_id', 'created_at']);
  });
  await db.schema.createTable('la_versions', t => {
    t.uuid('id').primary(); t.uuid('contract_id').notNullable().references('id').inTable('la_contracts');
    t.integer('version_no').notNullable(); t.uuid('parent_id').references('id').inTable('la_versions');
    t.string('kind').notNullable().defaultTo('contract'); t.string('filename').notNullable(); t.string('sha256', 64).notNullable();
    t.string('storage_key').notNullable(); t.string('media_type').notNullable(); t.bigInteger('size').notNullable();
    t.string('source_action').notNullable(); t.uuid('created_by').references('id').inTable('la_users');
    t.jsonb('parsed'); t.timestamps(true, true); t.unique(['contract_id', 'version_no']);
  });
  await db.schema.createTable('la_rule_versions', t => {
    t.uuid('id').primary(); t.string('pack_id').notNullable(); t.integer('version_no').notNullable(); t.string('name').notNullable();
    t.string('state').notNullable().defaultTo('draft'); t.jsonb('scope').notNullable(); t.jsonb('rules').notNullable(); t.jsonb('knowledge').notNullable().defaultTo('[]');
    t.uuid('created_by').references('id').inTable('la_users'); t.uuid('published_by').references('id').inTable('la_users'); t.timestamp('published_at');
    t.integer('revision').notNullable().defaultTo(1); t.timestamps(true, true); t.unique(['pack_id', 'version_no']);
  });
  await db.schema.createTable('la_reviews', t => {
    t.uuid('id').primary(); t.uuid('contract_id').notNullable().references('id').inTable('la_contracts');
    t.uuid('version_id').notNullable().references('id').inTable('la_versions'); t.uuid('created_by').references('id').inTable('la_users');
    t.string('status').notNullable().defaultTo('queued'); t.string('stage').notNullable().defaultTo('queued');
    t.integer('progress').notNullable().defaultTo(0); t.jsonb('snapshot').notNullable().defaultTo('{}');
    t.jsonb('coverage').notNullable().defaultTo('{}'); t.string('error_code'); t.text('error_message');
    t.integer('revision').notNullable().defaultTo(1); t.timestamps(true, true); t.index(['status', 'created_at']);
  });
  await db.schema.createTable('la_findings', t => {
    t.uuid('id').primary(); t.uuid('review_id').notNullable().references('id').inTable('la_reviews');
    t.string('rule_id').notNullable(); t.string('title').notNullable(); t.string('check_status').notNullable();
    t.string('severity').notNullable(); t.string('kind').notNullable(); t.jsonb('evidence').notNullable().defaultTo('[]');
    t.text('reason').notNullable(); t.text('suggestion').notNullable().defaultTo(''); t.jsonb('legal_refs').notNullable().defaultTo('[]');
    t.jsonb('disposition'); t.integer('revision').notNullable().defaultTo(1); t.timestamps(true, true); t.unique(['review_id', 'rule_id']);
  });
  await db.schema.createTable('la_decisions', t => {
    t.uuid('id').primary(); t.uuid('review_id').notNullable().unique().references('id').inTable('la_reviews');
    t.uuid('version_id').notNullable().references('id').inTable('la_versions'); t.uuid('decided_by').notNullable().references('id').inTable('la_users');
    t.string('outcome').notNullable(); t.text('reason').notNullable().defaultTo(''); t.text('conditions').notNullable().defaultTo(''); t.timestamps(true, true);
  });
  await db.schema.createTable('la_feedback', t => {
    t.uuid('id').primary(); t.uuid('review_id').references('id').inTable('la_reviews'); t.uuid('finding_id').references('id').inTable('la_findings');
    t.uuid('created_by').references('id').inTable('la_users'); t.string('kind').notNullable(); t.text('content').notNullable();
    t.string('state').notNullable().defaultTo('candidate'); t.uuid('rule_version_id').references('id').inTable('la_rule_versions'); t.timestamps(true, true);
  });
  await db.schema.createTable('la_archives', t => {
    t.uuid('id').primary(); t.uuid('contract_id').notNullable().references('id').inTable('la_contracts');
    t.uuid('decision_id').notNullable().references('id').inTable('la_decisions'); t.uuid('signed_version_id').references('id').inTable('la_versions');
    t.uuid('created_by').references('id').inTable('la_users'); t.boolean('manually_returned').notNullable(); t.text('note').notNullable().defaultTo(''); t.timestamps(true, true);
  });
  await db.schema.createTable('la_job_steps', t => {
    t.bigIncrements('id'); t.uuid('review_id').references('id').inTable('la_reviews'); t.string('stage').notNullable();
    t.string('status').notNullable(); t.jsonb('details').notNullable().defaultTo('{}'); t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  });
  await db.schema.createTable('la_outbox', t => {
    t.uuid('id').primary(); t.string('queue').notNullable(); t.jsonb('payload').notNullable(); t.timestamp('sent_at'); t.timestamp('created_at').defaultTo(db.fn.now());
  });
  await db.schema.createTable('la_integration_events', t => {
    t.uuid('id').primary(); t.string('dedup_key').notNullable().unique(); t.string('event_type').notNullable();
    t.jsonb('payload').notNullable(); t.string('status').notNullable().defaultTo('received'); t.text('error'); t.timestamps(true, true);
  });
  await db.schema.createTable('la_attachments', t => {
    t.string('source_key').primary(); t.uuid('contract_id').notNullable().references('id').inTable('la_contracts');
  });
  await db.schema.createTable('la_settings', t => { t.string('key').primary(); t.jsonb('value').notNullable(); t.integer('revision').defaultTo(1); t.timestamps(true, true); });
  await db.schema.createTable('la_editor_sessions', t => {
    t.string('key').primary(); t.uuid('contract_id').notNullable().references('id').inTable('la_contracts');
    t.uuid('version_id').notNullable().references('id').inTable('la_versions'); t.uuid('user_id').notNullable().references('id').inTable('la_users'); t.timestamp('expires_at').notNullable();
  });
  await db.schema.createTable('la_evaluation_cases', t => {
    t.uuid('id').primary(); t.string('name').notNullable(); t.string('split').notNullable(); t.jsonb('document').notNullable();
    t.jsonb('expected').notNullable(); t.uuid('created_by').references('id').inTable('la_users'); t.timestamps(true, true);
  });
  await db.schema.createTable('la_evaluations', t => {
    t.uuid('id').primary(); t.string('status').notNullable().defaultTo('queued'); t.jsonb('config').notNullable(); t.jsonb('result');
    t.uuid('created_by').references('id').inTable('la_users'); t.timestamps(true, true);
  });
  await db.schema.createTable('la_audit', t => {
    t.bigIncrements('id'); t.uuid('actor_id').references('id').inTable('la_users'); t.string('action').notNullable();
    t.string('entity_id'); t.jsonb('details').notNullable().defaultTo('{}'); t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  });
};
exports.down = async () => { throw new Error('禁止自动回滚业务表；请从已验证备份恢复。'); };
