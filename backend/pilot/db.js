const knex = require('knex');
const { config } = require('./config');
function createDb(url = config.databaseUrl) { return knex({ client: 'pg', connection: url, pool: { min: 0, max: 10 } }); }
module.exports = { createDb };
