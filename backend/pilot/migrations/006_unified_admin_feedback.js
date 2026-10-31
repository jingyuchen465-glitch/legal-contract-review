exports.up = async function (db) {
  const hasGuidance = await db.schema.hasTable('la_classification_guidance_versions');
  if (!hasGuidance) {
    await db.schema.createTable('la_classification_guidance_versions', table => {
      table.uuid('id').primary();
      table.string('type_id').notNullable();
      table.integer('version_no').notNullable();
      table.string('state').notNullable().defaultTo('draft');
      table.jsonb('guidance').notNullable().defaultTo('{}');
      table.uuid('created_by').references('id').inTable('la_users');
      table.uuid('published_by').references('id').inTable('la_users');
      table.timestamp('published_at');
      table.integer('revision').notNullable().defaultTo(1);
      table.timestamps(true, true);
      table.unique(['type_id', 'version_no']);
    });
  }

  const hasDraftLink = await db.schema.hasColumn('la_feedback', 'draft_rule_version_id');
  if (!hasDraftLink) {
    await db.schema.alterTable('la_feedback', table => {
      table.uuid('draft_rule_version_id').references('id').inTable('la_rule_versions');
      table.uuid('draft_classification_version_id').references('id').inTable('la_classification_guidance_versions');
    });
  } else if (!(await db.schema.hasColumn('la_feedback', 'draft_classification_version_id'))) {
    await db.schema.alterTable('la_feedback', table => table.uuid('draft_classification_version_id').references('id').inTable('la_classification_guidance_versions'));
  }

  // Keep the JSON shape for compatibility while making every existing account
  // a unified administrator. Audit history still identifies the original user.
  await db('la_users').update({ roles: JSON.stringify(['admin']), updated_at: db.fn.now() });
};

exports.down = async function (db) {
  if (await db.schema.hasColumn('la_feedback', 'draft_rule_version_id')) {
    await db.schema.alterTable('la_feedback', table => table.dropColumn('draft_rule_version_id').dropColumn('draft_classification_version_id'));
  }
  if (await db.schema.hasTable('la_classification_guidance_versions')) {
    await db.schema.dropTable('la_classification_guidance_versions');
  }
};
