exports.up = async db => {
  await db.schema.createTable('la_annotated_versions', t => {
    t.uuid('id').primary();
    t.uuid('review_id').notNullable().references('id').inTable('la_reviews');
    t.uuid('source_version_id').notNullable().references('id').inTable('la_versions');
    t.uuid('generated_version_id').notNullable().references('id').inTable('la_versions');
    t.string('mode').notNullable().defaultTo('comments');
    t.string('finding_digest', 64).notNullable();
    t.uuid('created_by').notNullable().references('id').inTable('la_users');
    t.integer('located_count').notNullable().defaultTo(0);
    t.integer('unlocated_count').notNullable().defaultTo(0);
    t.timestamps(true, true);
    t.unique(['review_id', 'source_version_id', 'mode', 'finding_digest']);
    t.index(['generated_version_id']);
  });
};

exports.down = async db => {
  await db.schema.dropTableIfExists('la_annotated_versions');
};
