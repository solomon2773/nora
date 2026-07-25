// @ts-nocheck
const { Pool } = require("pg");
const { buildPostgresConfig } = require("./lib/connectionConfig");

const pool = new Pool(buildPostgresConfig(process.env));

module.exports = pool;
