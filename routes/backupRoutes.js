const express = require('express');
const router = express.Router();
const axios = require('axios');
const { verifyToken, verifyRole } = require('../middleware/auth');
const { pool } = require('../config/database');

const GITHUB_REPO = 'PedroRubioo/pier-reposteria';
const WORKFLOW_FILE = 'backup-neon.yml';

function getGitHubHeaders() {
  return {
    'Authorization': `token ${process.env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json'
  };
}

// ============================================
// LISTAR BACKUPS (GitHub Artifacts)
// ============================================
router.get('/list', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/artifacts`,
      { headers: getGitHubHeaders() }
    );

    const backups = response.data.artifacts
      .filter(a => a.name.startsWith('neon-backup'))
      .map(a => ({
        id: a.id,
        nombre: a.name,
        creado: new Date(a.created_at).toLocaleString('es-MX', {
          timeZone: 'America/Mexico_City',
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit'
        }),
        tamaño: (a.size_in_bytes / 1024).toFixed(2) + ' KB',
        url: a.archive_download_url
      }));

    res.json({ success: true, backups });
  } catch (error) {
    console.error('Error en /list:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener backups' });
  }
});

// ============================================
// DESCARGAR BACKUP
// ============================================
router.get('/download/:id', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const response = await axios({
      method: 'get',
      url: `https://api.github.com/repos/${GITHUB_REPO}/actions/artifacts/${req.params.id}/zip`,
      headers: getGitHubHeaders(),
      responseType: 'stream'
    });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=backup-${req.params.id}.zip`);
    response.data.pipe(res);
  } catch (error) {
    console.error('Error en /download:', error.message);
    res.status(500).json({ success: false, message: 'Error al descargar' });
  }
});

// ============================================
// ELIMINAR BACKUP
// ============================================
router.delete('/delete/:id', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    await axios.delete(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/artifacts/${req.params.id}`,
      { headers: getGitHubHeaders() }
    );
    res.json({ success: true, message: 'Backup eliminado' });
  } catch (error) {
    console.error('Error en /delete:', error.message);
    res.status(error.response?.status === 404 ? 404 : 500).json({
      success: false,
      message: error.response?.status === 404 ? 'Backup no encontrado' : 'Error al eliminar'
    });
  }
});

// ============================================
// GENERAR RESPALDO MANUAL (dispara GitHub Action)
// ============================================
router.post('/generar', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    await axios.post(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      { ref: 'main' },
      { headers: getGitHubHeaders() }
    );
    res.json({ success: true, message: 'Respaldo iniciado. Aparecerá en la lista en ~30 segundos.' });
  } catch (error) {
    console.error('Error en /generar:', error.message);
    res.status(500).json({ success: false, message: 'Error al generar respaldo' });
  }
});

// ============================================
// LISTAR TABLAS (para backup selectivo)
// ============================================
router.get('/tablas', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'core' ORDER BY table_name
    `);

    const tablas = [];
    for (const row of result.rows) {
      try {
        const countResult = await pool.query(`SELECT COUNT(*) as total FROM core.${row.table_name}`);
        tablas.push({
          nombre: row.table_name,
          registros: parseInt(countResult.rows[0].total)
        });
      } catch (e) {
        tablas.push({ nombre: row.table_name, registros: 0 });
      }
    }

    res.json({ success: true, tablas });
  } catch (error) {
    console.error('Error en /tablas:', error.message);
    res.status(500).json({ success: false, message: 'Error al listar tablas' });
  }
});

// ============================================
// BACKUP SELECTIVO (tablas específicas → .sql)
// ============================================
router.post('/backup-selectivo', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const { tablas } = req.body;
    if (!tablas || !Array.isArray(tablas) || tablas.length === 0) {
      return res.status(400).json({ success: false, message: 'Selecciona al menos una tabla' });
    }

    const validTables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'core' AND table_name = ANY($1)`,
      [tablas]
    );
    const tablasValidas = validTables.rows.map(r => r.table_name);
    if (tablasValidas.length === 0) {
      return res.status(400).json({ success: false, message: 'Ninguna tabla válida' });
    }

    let sql = `-- BACKUP SELECTIVO - Pier Repostería\n`;
    sql += `-- Fecha: ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}\n`;
    sql += `-- Tablas: ${tablasValidas.join(', ')}\n\n`;

    for (const tabla of tablasValidas) {
      const columns = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'core' AND table_name = $1 ORDER BY ordinal_position`,
        [tabla]
      );
      const cols = columns.rows.map(c => c.column_name);
      const data = await pool.query(`SELECT * FROM core.${tabla}`);

      sql += `-- core.${tabla} (${data.rows.length} registros)\n`;

      for (const row of data.rows) {
        const values = cols.map(col => {
          const val = row[col];
          if (val === null) return 'NULL';
          if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
          if (typeof val === 'number') return val;
          if (val instanceof Date) return `'${val.toISOString()}'`;
          if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
          return `'${String(val).replace(/'/g, "''")}'`;
        });
        sql += `INSERT INTO core.${tabla} (${cols.join(', ')}) VALUES (${values.join(', ')});\n`;
      }
      sql += `\n`;
    }

    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename=backup-selectivo-${Date.now()}.sql`);
    res.send(sql);
  } catch (error) {
    console.error('Error en /backup-selectivo:', error.message);
    res.status(500).json({ success: false, message: 'Error al generar backup selectivo' });
  }
});

// ============================================
// RESTAURAR BACKUP (ejecutar SQL contra Neon)
// ============================================
router.post('/restaurar', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const { sql } = req.body;
    if (!sql || typeof sql !== 'string' || sql.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'El contenido SQL es requerido' });
    }

    const sqlLower = sql.toLowerCase();
    if (sqlLower.includes('drop database') || sqlLower.includes('drop schema')) {
      return res.status(403).json({ success: false, message: 'No se permite DROP DATABASE ni DROP SCHEMA' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');

      await pool.query(
        `INSERT INTO core.tblauditoria (accion, entidad, detalles, created_at) VALUES ('Restauracion de backup', 'sistema', $1::jsonb, NOW())`,
        [JSON.stringify({ tipo: 'restauracion_manual', tamaño_sql: sql.length, ejecutado_por: req.user.email })]
      );

      res.json({ success: true, message: 'Backup restaurado exitosamente' });
    } catch (queryError) {
      await client.query('ROLLBACK');
      res.status(400).json({ success: false, message: `Error en SQL: ${queryError.message.substring(0, 200)}` });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error en /restaurar:', error.message);
    res.status(500).json({ success: false, message: 'Error al restaurar' });
  }
});

module.exports = router;