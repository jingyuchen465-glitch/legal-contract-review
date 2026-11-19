exports.up = async db => {
  await db.schema.alterTable('la_versions', t => { t.jsonb('conversion'); });
};
exports.down = async db => {
  await db.schema.alterTable('la_versions', t => { t.dropColumn('conversion'); });
};
