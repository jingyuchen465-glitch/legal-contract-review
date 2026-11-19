exports.up=async db=>{
  await db.schema.createTable('la_source_files',t=>{t.string('source_key').primary();t.uuid('contract_id').notNullable().references('id').inTable('la_contracts');t.uuid('version_id').notNullable().references('id').inTable('la_versions');t.string('role').notNullable();t.timestamps(true,true);});
  await db.schema.createTable('la_embedding_cache',t=>{t.string('hash',64).primary();t.string('model').notNullable();t.jsonb('vector').notNullable();t.timestamp('created_at').defaultTo(db.fn.now());});
};
exports.down=async()=>{throw new Error('请从已验证备份恢复，禁止自动删除业务表');};
