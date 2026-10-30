// Saves an imported file's tables into the datasets table.
const { pool } = require('../db/pool');
const importer = require('./importer');

// Reads the file and replaces everything previously imported from a file of the same name:
// tables are updated in place, and tables that no longer exist in the file are removed.
async function importFile(buffer, filename, userId) {
  const tables = await importer.readUpload(buffer, filename);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const imported = [];
    for (const t of tables) {
      const { rows } = await c.query(`
        INSERT INTO datasets (name, source_file, columns, rows, row_count, imported_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT ((lower(name))) DO UPDATE SET name = EXCLUDED.name, source_file = EXCLUDED.source_file,
          columns = EXCLUDED.columns, rows = EXCLUDED.rows, row_count = EXCLUDED.row_count,
          imported_by = EXCLUDED.imported_by, imported_at = now()
        RETURNING id, name, row_count AS "rowCount"`,
        [t.name, filename, JSON.stringify(t.columns), JSON.stringify(t.rows), t.rows.length, userId || null]);
      imported.push(rows[0]);
    }
    const { rowCount: removed } = await c.query(
      'DELETE FROM datasets WHERE lower(source_file) = lower($1) AND NOT (id = ANY($2::int[]))',
      [filename, imported.map((t) => t.id)]);
    await c.query('COMMIT');
    return { imported, removed };
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally { c.release(); }
}

module.exports = { importFile, ImportError: importer.ImportError };
