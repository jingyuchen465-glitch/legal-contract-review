exports.up = async db => {
  await db.schema.createTable('la_agent_workspaces', t => {
    t.uuid('id').primary();
    t.uuid('session_id').notNullable().references('id').inTable('la_agent_sessions').onDelete('CASCADE');
    t.uuid('review_id').notNullable().references('id').inTable('la_reviews').onDelete('CASCADE');
    t.string('runtime_profile').notNullable();
    t.string('status').notNullable().defaultTo('running');
    t.string('container_id');
    t.text('root_path').notNullable();
    t.jsonb('metadata').notNullable().defaultTo('{}');
    t.timestamp('finished_at');
    t.timestamps(true, true);
    t.index(['session_id', 'created_at']);
    t.unique(['session_id', 'review_id']);
  });
  await db.schema.createTable('la_agent_artifacts', t => {
    t.uuid('id').primary();
    t.uuid('workspace_id').notNullable().references('id').inTable('la_agent_workspaces').onDelete('CASCADE');
    t.uuid('session_id').notNullable().references('id').inTable('la_agent_sessions').onDelete('CASCADE');
    t.uuid('review_id').notNullable().references('id').inTable('la_reviews').onDelete('CASCADE');
    t.string('relative_path').notNullable();
    t.string('filename').notNullable();
    t.string('media_type').notNullable();
    t.bigInteger('size').notNullable();
    t.string('sha256').notNullable();
    t.text('storage_path').notNullable();
    t.timestamps(true, true);
    t.unique(['workspace_id', 'relative_path']);
    t.index(['session_id', 'created_at']);
  });
};

exports.down = async () => { throw new Error('Agent 工作区和产物必须保留；请从备份恢复。'); };
