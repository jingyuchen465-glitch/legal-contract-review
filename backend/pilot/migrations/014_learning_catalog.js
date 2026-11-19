exports.up = async db => {
  for (const table of ['la_skill_versions', 'la_rule_versions']) await db.schema.alterTable(table, t => {
    t.string('state_reason'); t.uuid('replaced_by_id'); t.jsonb('item_changes').notNullable().defaultTo('{}');
  });
  await db.schema.alterTable('la_learning_tasks', t => { t.jsonb('catalog_overlay');t.jsonb('generation_details'); });
  await db.schema.createTable('la_learning_reorganizations', t => {
    t.uuid('id').primary(); t.uuid('contract_id').notNullable().references('id').inTable('la_contracts');
    t.uuid('version_id').notNullable().references('id').inTable('la_versions');
    t.uuid('created_by').references('id').inTable('la_users'); t.string('status').notNullable().defaultTo('queued');
    t.jsonb('baseline').notNullable(); t.jsonb('result'); t.text('error_message');
    t.integer('revision').notNullable().defaultTo(1); t.timestamps(true, true); t.index(['contract_id','created_at']);
  });
};
exports.down = async () => { throw new Error('分类及经验整理记录须保留；回退时关闭 LEARNING_CATALOG_ENABLED，不删除历史记录。'); };
