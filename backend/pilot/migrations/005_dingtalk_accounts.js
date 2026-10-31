exports.up = async db => {
  await db.schema.createTable('la_dingtalk_accounts', t => {
    t.uuid('user_id').primary().references('id').inTable('la_users');
    t.string('client_id', 200).notNullable();
    t.string('ding_user_id', 200).notNullable();
    t.string('display_name', 200).notNullable();
    t.unique(['client_id', 'ding_user_id']);
    t.timestamps(true, true);
  });
  await db.schema.createTable('la_dingtalk_binding_requests', t => {
    t.string('state_hash', 64).primary();
    t.uuid('user_id').notNullable().references('id').inTable('la_users');
    t.string('connection_hash', 64).notNullable();
    t.timestamp('expires_at').notNullable();
  });
  await db.schema.alterTable('la_integration_events', t => {
    t.jsonb('summary').notNullable().defaultTo('{}');
    t.string('client_id', 200).index();
  });
};
exports.down = async () => { throw new Error('请从已验证备份恢复，禁止自动删除业务表'); };
