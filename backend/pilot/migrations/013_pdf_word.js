exports.up = async db => {
  await db.schema.createTable('la_pdf_extractions', t => {
    t.uuid('id').primary(); t.uuid('version_id').notNullable().references('id').inTable('la_versions').index();
    t.string('cache_key', 64).notNullable().unique(); t.string('source_hash', 64).notNullable();
    t.jsonb('model').notNullable(); t.string('engine').notNullable(); t.integer('page_count');
    t.jsonb('document'); t.timestamps(true, true);
  });
  await db.schema.createTable('la_pdf_pages', t => {
    t.uuid('extraction_id').notNullable().references('id').inTable('la_pdf_extractions');
    t.integer('page').notNullable(); t.jsonb('layout').notNullable(); t.primary(['extraction_id', 'page']);
  });
  await db.schema.createTable('la_word_conversions', t => {
    t.uuid('id').primary(); t.uuid('version_id').notNullable().references('id').inTable('la_versions');
    t.uuid('extraction_id').notNullable().unique().references('id').inTable('la_pdf_extractions');
    t.uuid('created_by').notNullable().references('id').inTable('la_users');
    t.string('status').notNullable().defaultTo('queued').index(); t.integer('completed_pages').notNullable().defaultTo(0);
    t.jsonb('artifacts'); t.jsonb('quality'); t.string('error_code'); t.text('error_message');
    t.uuid('created_version_id').references('id').inTable('la_versions'); t.timestamps(true, true);
  });
};
exports.down = async () => { throw new Error('保留 PDF 解析、转换及其追溯记录；请使用功能开关回退。'); };
