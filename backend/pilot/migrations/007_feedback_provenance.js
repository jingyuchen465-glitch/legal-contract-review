exports.up = async db => {
  await db.schema.alterTable('la_rule_versions', t => {
    t.uuid('base_version_id').references('id').inTable('la_rule_versions');
    t.uuid('source_feedback_id').references('id').inTable('la_feedback');
  });
  await db.schema.alterTable('la_classification_guidance_versions', t => {
    t.uuid('base_version_id').references('id').inTable('la_classification_guidance_versions');
    t.uuid('source_feedback_id').references('id').inTable('la_feedback');
  });
  await db.schema.alterTable('la_feedback', t => {
    t.integer('revision').notNullable().defaultTo(1);
    t.uuid('classification_version_id').references('id').inTable('la_classification_guidance_versions');
  });
  await db.schema.alterTable('la_evaluation_cases', t => {
    t.uuid('source_feedback_id').unique().references('id').inTable('la_feedback');
  });
  // Older feedback drafts keep their source link when upgraded.
  for (const f of await db('la_feedback').whereNotNull('draft_rule_version_id')) {
    await db('la_rule_versions').where({ id: f.draft_rule_version_id }).update({ source_feedback_id: f.id });
  }
  for (const p of await db('la_rule_versions').whereIn('state', ['draft', 'pending'])) {
    const current = await db('la_rule_versions').where({ pack_id: p.pack_id, state: 'published' }).first();
    if (current) await db('la_rule_versions').where({ id: p.id }).update({ base_version_id: current.id });
  }
};
exports.down = async db => {
  await db.schema.alterTable('la_evaluation_cases', t => t.dropColumn('source_feedback_id'));
  await db.schema.alterTable('la_feedback', t => { t.dropColumn('revision'); t.dropColumn('classification_version_id'); });
  for (const name of ['la_rule_versions', 'la_classification_guidance_versions']) await db.schema.alterTable(name, t => { t.dropColumn('base_version_id'); t.dropColumn('source_feedback_id'); });
};
