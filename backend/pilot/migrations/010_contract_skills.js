exports.up = async db => {
  await db.schema.createTable('la_learning_tasks', t => {
    t.uuid('id').primary(); t.uuid('decision_id').notNullable().unique().references('id').inTable('la_decisions');
    t.uuid('contract_id').notNullable().references('id').inTable('la_contracts');
    t.uuid('review_id').notNullable().references('id').inTable('la_reviews');
    t.uuid('version_id').notNullable().references('id').inTable('la_versions');
    t.uuid('created_by').references('id').inTable('la_users');
    t.string('status').notNullable().defaultTo('queued'); t.jsonb('snapshot').notNullable().defaultTo('{}');
    t.jsonb('source'); t.jsonb('proposals').notNullable().defaultTo('[]'); t.jsonb('calls').notNullable().defaultTo('[]');
    t.string('error_code'); t.text('error_message'); t.integer('revision').notNullable().defaultTo(1); t.timestamps(true, true);
    t.index(['contract_id', 'created_at']); t.index(['status', 'created_at']);
  });
  await db.schema.createTable('la_skill_versions', t => {
    t.uuid('id').primary(); t.string('pack_id').notNullable(); t.integer('version_no').notNullable(); t.string('name').notNullable();
    t.string('state').notNullable().defaultTo('draft'); t.jsonb('scope').notNullable(); t.jsonb('skills').notNullable();
    t.jsonb('sources').notNullable().defaultTo('[]'); t.jsonb('required_rule_versions').notNullable().defaultTo('[]');
    t.uuid('base_version_id').references('id').inTable('la_skill_versions');
    t.uuid('created_by').references('id').inTable('la_users'); t.uuid('published_by').references('id').inTable('la_users');
    t.timestamp('published_at'); t.integer('revision').notNullable().defaultTo(1); t.timestamps(true, true);
    t.unique(['pack_id', 'version_no']);
  });
  await db.raw("CREATE UNIQUE INDEX la_skill_one_published ON la_skill_versions(pack_id) WHERE state = 'published'");
};
exports.down = async () => { throw new Error('经验及技能版本须保留；回退应用时关闭自动提炼，禁止删除业务表。'); };
