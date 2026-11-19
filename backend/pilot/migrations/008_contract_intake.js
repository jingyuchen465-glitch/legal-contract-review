exports.up = async db => {
  await db.schema.alterTable('la_contracts', t => {
    t.string('intake_mode').notNullable().defaultTo('manual');
    t.string('intake_review_status').notNullable().defaultTo('confirmed');
    t.uuid('intake_reviewed_by').references('id').inTable('la_users');
    t.timestamp('intake_reviewed_at');
    t.text('intake_review_note').notNullable().defaultTo('');
  });

  await db('la_contracts').where({ source: 'manual' }).update({
    intake_mode: 'manual',
    intake_review_status: 'confirmed',
  });
  // Existing DingTalk rows do not carry enough provenance to distinguish a
  // live event from an old reconciliation. Preserve them for review instead
  // of silently putting them back into the legal work queue.
  await db('la_contracts').where({ source: 'dingtalk' }).update({
    intake_mode: 'reconciliation',
    intake_review_status: 'pending',
  });

  await db.schema.alterTable('la_contracts', t => {
    t.index(['intake_mode', 'intake_review_status'], 'la_contracts_intake_idx');
  });
};

exports.down = async () => {
  throw new Error('请从已验证备份恢复，禁止自动删除业务表。');
};
