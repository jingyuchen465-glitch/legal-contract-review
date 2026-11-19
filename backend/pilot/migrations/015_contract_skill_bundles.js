exports.up = async db => {
  await db.schema.alterTable('la_skill_versions', t => {
    t.uuid('origin_contract_id').references('id').inTable('la_contracts');
    t.jsonb('file_bundle');
    t.jsonb('legacy_replacements').notNullable().defaultTo('[]');
  });
  await db.raw("CREATE UNIQUE INDEX la_contract_skill_working ON la_skill_versions(origin_contract_id) WHERE origin_contract_id IS NOT NULL AND state IN ('draft','pending')");
  await db.schema.createTable('la_skill_entry_versions', t => {
    t.uuid('id').primary(); t.string('entry_key').notNullable(); t.integer('version_no').notNullable();
    t.string('name').notNullable(); t.text('description').notNullable(); t.text('body').notNullable();
    t.string('state').notNullable().defaultTo('draft'); t.uuid('base_version_id');
    t.uuid('created_by').references('id').inTable('la_users'); t.uuid('published_by').references('id').inTable('la_users');
    t.timestamp('published_at'); t.integer('revision').notNullable().defaultTo(1); t.timestamps(true, true);
    t.unique(['entry_key', 'version_no']);
  });
  await db.raw("CREATE UNIQUE INDEX la_skill_entry_published ON la_skill_entry_versions(entry_key) WHERE state = 'published'");
};
exports.down = async () => { throw new Error('综合技能及文件版本须保留；回退应用，不删除业务记录。'); };
