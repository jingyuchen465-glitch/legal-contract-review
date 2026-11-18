exports.up = async db => {
  await db.schema.alterTable('la_agent_memories', t => {
    t.boolean('is_system').notNullable().defaultTo(false);
  });
  await db.raw("ALTER TABLE la_agent_memories ADD CONSTRAINT la_agent_memory_system_skill CHECK (NOT is_system OR kind = 'skill')");
};
exports.down = async () => { throw new Error('系统技能分类及审计记录须保留，请使用兼容版本回退。'); };
