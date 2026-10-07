// Creates the tables in db/schema.sql. Run with: npm run db:setup
const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

(async () => {
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    console.log('Database is ready.');
  } catch (err) {
    console.error('Could not set up the database:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
