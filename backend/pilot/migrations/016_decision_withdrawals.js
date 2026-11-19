exports.up = async db => {
  await db.schema.createTable('la_decision_withdrawals', t => {
    t.uuid('decision_id').primary().references('id').inTable('la_decisions');
    t.uuid('created_by').notNullable().references('id').inTable('la_users');
    t.text('reason').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
  });
};
exports.down = async () => { throw new Error('最终结论撤回记录须保留，不删除审计依据。'); };
