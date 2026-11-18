exports.up = async db => {
  await db.schema.alterTable('la_contracts', t => {
    // Existing reports keep their original workflow; new intakes explicitly opt in.
    t.string('review_flow').notNullable().defaultTo('automatic');
    t.uuid('current_preanalysis_id');
  });
  await db.schema.createTable('la_preanalyses', t => {
    t.uuid('id').primary();
    t.uuid('contract_id').notNullable().references('id').inTable('la_contracts');
    t.uuid('version_id').notNullable().references('id').inTable('la_versions');
    t.uuid('created_by').references('id').inTable('la_users');
    t.string('status').notNullable().defaultTo('queued');
    t.string('stage').notNullable().defaultTo('queued');
    t.integer('progress').notNullable().defaultTo(0);
    t.jsonb('snapshot').notNullable();
    t.jsonb('result'); t.jsonb('selection');
    t.uuid('review_id').references('id').inTable('la_reviews');
    t.string('error_code'); t.text('error_message');
    t.integer('revision').notNullable().defaultTo(1);
    t.timestamps(true, true); t.index(['contract_id', 'created_at']);
  });
};
exports.down = async () => { throw new Error('禁止自动回滚业务表'); };
