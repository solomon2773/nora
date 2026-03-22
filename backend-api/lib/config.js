// Centralized environment configuration validation

const REQUIRED = [
  'JWT_SECRET',
  'DB_HOST',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME'
];

function validateEnv() {
  const missing = [];

  for (const key of REQUIRED) {
    if (!process.env[key] || process.env[key].trim() === '') {
      missing.push(key);
    }
  }

  if (missing.length) {
    console.error('\n❌ Configuration error\n');
    console.error('Missing required environment variables:');
    missing.forEach(v => console.error(` - ${v}`));
    console.error('\nFix your .env file before starting Nora.\n');
    process.exit(1);
  }

  return {
    port: parseInt(process.env.PORT || '4000'),
    db: {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: parseInt(process.env.DB_PORT || '5432')
    }
  };
}

module.exports = { validateEnv };
