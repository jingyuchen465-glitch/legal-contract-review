exports.up = async db => {
  await db.schema.alterTable('la_findings', t => { t.jsonb('document_suggestions').notNullable().defaultTo('[]'); });
  await db.schema.alterTable('la_decisions', t => { t.jsonb('materials_snapshot'); });
  await db.schema.createTable('la_dingtalk_intake_modes', t => {
    t.string('client_id').notNullable(); t.string('instance_id').notNullable(); t.uuid('recipient_id').notNullable().references('id').inTable('la_users');
    t.string('mode').notNullable(); t.timestamp('created_at').notNullable().defaultTo(db.fn.now()); t.primary(['client_id', 'instance_id', 'recipient_id']);
  });
  await db.schema.createTable('la_dingtalk_intakes', t => {
    t.uuid('id').primary(); t.string('client_id').notNullable(); t.string('instance_id').notNullable();
    t.uuid('recipient_id').notNullable().references('id').inTable('la_users');
    t.uuid('container_id').notNullable().references('id').inTable('la_contracts');
    t.string('status').notNullable().defaultTo('collecting'); t.integer('revision').notNullable().defaultTo(1);
    t.uuid('analysis_token'); t.jsonb('analysis'); t.jsonb('draft'); t.jsonb('confirmed_selection'); t.text('error');
    t.timestamps(true, true); t.unique(['client_id', 'instance_id', 'recipient_id']);
  });
  await db.schema.createTable('la_intake_documents', t => {
    t.uuid('id').primary(); t.uuid('intake_id').notNullable().references('id').inTable('la_dingtalk_intakes');
    t.string('file_id').notNullable(); t.text('filename').notNullable(); t.text('field').notNullable();
    t.uuid('contract_id').references('id').inTable('la_contracts'); t.string('remote_sha256', 64);
    t.string('status').notNullable(); t.boolean('present').notNullable().defaultTo(true); t.text('error');
    t.timestamps(true, true); t.unique(['intake_id', 'file_id']);
  });
  await db.schema.createTable('la_review_groups', t => {
    t.uuid('id').primary(); t.uuid('intake_id').notNullable().references('id').inTable('la_dingtalk_intakes');
    t.uuid('main_document_id').notNullable().references('id').inTable('la_intake_documents');
    t.text('name').notNullable(); t.boolean('active').notNullable().defaultTo(true);
    t.integer('revision').notNullable().defaultTo(1); t.jsonb('confirmed_manifest'); t.timestamps(true, true);
  });
  await db.schema.createTable('la_review_group_documents', t => {
    t.uuid('group_id').notNullable().references('id').inTable('la_review_groups');
    t.uuid('document_id').notNullable().references('id').inTable('la_intake_documents');
    t.string('role').notNullable(); t.primary(['group_id', 'document_id']);
  });
};
exports.down = async () => { throw new Error('禁止删除审批附件与联合审查业务数据；请切回兼容版本。'); };
