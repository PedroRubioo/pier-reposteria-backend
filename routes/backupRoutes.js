const express = require('express');
const router = express.Router();
const axios = require('axios');
const { accesoVigente } = require('../middleware/usuarioVigente');
const { pool } = require('../config/database');
const { registrarAuditoria, recortar } = require('../utils/auditoria');
const { revisarRestauracion } = require('../utils/restauracionSQL');

const GITHUB_REPO = 'PedroRubioo/pier-reposteria';
const WORKFLOW_FILE = 'backup-neon.yml';

// Solo Dirección General, con el rol leído de la base (no el del JWT)
const SOLO_DIRECCION = accesoVigente(['direccion_general']);

function getGitHubHeaders() {
  return {
    'Authorization': `token ${process.env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json'
  };
}

router.get('/list', SOLO_DIRECCION, async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/artifacts?per_page=100`,
      { headers: getGitHubHeaders() }
    );
    const backups = response.data.artifacts
      .filter(a => a.name.startsWith('neon-backup') && !a.expired)
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

router.get('/download/:id', SOLO_DIRECCION, async (req, res) => {
  try {
    const response = await axios({
      method: 'get',
      url: `https://api.github.com/repos/${GITHUB_REPO}/actions/artifacts/${req.params.id}/zip`,
      headers: getGitHubHeaders(),
      responseType: 'stream'
    });
    // Los ids de artefactos de GitHub no caben en integer: van en detalles
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Descargó respaldo', entidad: 'backup', entidad_id: null, detalles: `artefacto ${req.params.id}`, ip: req.ip });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=backup-${req.params.id}.zip`);
    response.data.pipe(res);
  } catch (error) {
    console.error('Error en /download:', error.message);
    res.status(500).json({ success: false, message: 'Error al descargar' });
  }
});

router.delete('/delete/:id', SOLO_DIRECCION, async (req, res) => {
  try {
    await axios.delete(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/artifacts/${req.params.id}`,
      { headers: getGitHubHeaders() }
    );
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Eliminó respaldo', entidad: 'backup', entidad_id: null, detalles: `artefacto ${req.params.id}`, ip: req.ip });
    res.json({ success: true, message: 'Backup eliminado' });
  } catch (error) {
    console.error('Error en /delete:', error.message);
    res.status(error.response?.status === 404 ? 404 : 500).json({
      success: false,
      message: error.response?.status === 404 ? 'Backup no encontrado' : 'Error al eliminar'
    });
  }
});

router.post('/generar', SOLO_DIRECCION, async (req, res) => {
  try {
    await axios.post(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      { ref: 'main' },
      { headers: getGitHubHeaders() }
    );
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Generó respaldo', entidad: 'backup', entidad_id: null, detalles: 'manual', ip: req.ip });
    res.json({ success: true, message: 'Respaldo iniciado. Aparecerá en la lista en ~30 segundos.' });
  } catch (error) {
    console.error('Error en /generar:', error.message);
    res.status(500).json({ success: false, message: 'Error al generar respaldo' });
  }
});

router.get('/tablas', SOLO_DIRECCION, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'core' ORDER BY table_name
    `);
    const tablas = [];
    for (const row of result.rows) {
      try {
        const countResult = await pool.query(`SELECT COUNT(*) as total FROM core.${row.table_name}`);
        tablas.push({ nombre: row.table_name, registros: parseInt(countResult.rows[0].total) });
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

router.post('/backup-selectivo', SOLO_DIRECCION, async (req, res) => {
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
          const val = row[col]; // eslint-disable-line security/detect-object-injection
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
    // La lista sale de information_schema, no del body
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Descargó respaldo selectivo', entidad: 'backup', entidad_id: null, detalles: `${tablasValidas.length} tablas: ${tablasValidas.join(', ').slice(0, 150)}`, ip: req.ip });
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename=backup-selectivo-${Date.now()}.sql`);
    res.send(sql);
  } catch (error) {
    console.error('Error en /backup-selectivo:', error.message);
    res.status(500).json({ success: false, message: 'Error al generar backup selectivo' });
  }
});

router.post('/restaurar', SOLO_DIRECCION, async (req, res) => {
  try {
    const { sql } = req.body;
    if (!sql || typeof sql !== 'string' || sql.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'El contenido SQL es requerido' });
    }
    // Solo INSERT INTO core.<tabla> (más BEGIN, COMMIT y SET, que no se ejecutan)
    const revision = revisarRestauracion(sql);
    if (revision.error) return res.status(400).json({ success: false, message: revision.error });
    const tablasCore = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'core' AND table_type = 'BASE TABLE'`
    );
    const existentes = new Set(tablasCore.rows.map(r => r.table_name));
    const desconocida = revision.inserciones.find(s => !existentes.has(s.tabla));
    if (desconocida) return res.status(400).json({ success: false, message: `La tabla core.${desconocida.tabla} no existe` });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Las comillas se leen como en la revisión: la barra invertida es texto
      await client.query('SET LOCAL standard_conforming_strings = on');
      const resultado = await client.query(revision.inserciones.map(s => s.texto).join(';\n'));
      await client.query('COMMIT');
      const filas = (Array.isArray(resultado) ? resultado : [resultado]).reduce((suma, r) => suma + (r.rowCount || 0), 0);
      // Solo el tamaño: el SQL completo jamás va a la bitácora
      registrarAuditoria({ usuario_id: req.user.userId, accion: 'Restauró respaldo', entidad: 'backup', entidad_id: null, detalles: `${sql.length} caracteres de SQL · ${revision.inserciones.length} sentencias INSERT · ${filas} registros`, ip: req.ip });
      res.json({ success: true, message: `Respaldo restaurado: ${filas} registro${filas === 1 ? '' : 's'} insertado${filas === 1 ? '' : 's'}` });
    } catch (queryError) {
      await client.query('ROLLBACK');
      registrarAuditoria({ usuario_id: req.user.userId, accion: 'Falló restauración de respaldo', entidad: 'backup', entidad_id: null, detalles: `${sql.length} caracteres de SQL · ${recortar(queryError.message, 80)}`, ip: req.ip });
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