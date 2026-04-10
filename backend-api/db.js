const {Pool} = require('pg')

const pool = new Pool({
  user: process.env.DB_USER || 'nora',
  password: process.env.DB_PASSWORD || 'nora',
  host: process.env.DB_HOST || 'postgres',
  database: process.env.DB_NAME || 'nora',
  port: parseInt(process.env.DB_PORT || '5432'),
})

module.exports = pool
