// routes/zonasEnvioRoutes.js — Zonas de cobertura y tarifas de envío a domicilio
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');
const { registrarAuditoria } = require('../utils/auditoria');

// Para la bitácora: cuántas colonias quedaron en la zona según la base
async function contarColonias(client, zonaId) {
  const r = await client.query('SELECT COUNT(*)::int AS total FROM core.tblzonas_colonias WHERE zona_id = $1', [zonaId]);
  return r.rows[0].total;
}
const textoColonias = n => `${n} colonia${n === 1 ? '' : 's'}`;

// Colonias del cuerpo: solo textos, sin vacías y sin repetir (sin distinguir
// mayúsculas, igual que el índice único de la tabla)
function coloniasLimpias(colonias) {
  const vistas = new Map();
  for (const colonia of colonias) {
    const limpia = typeof colonia === 'string' ? colonia.trim() : '';
    if (limpia && !vistas.has(limpia.toLowerCase())) vistas.set(limpia.toLowerCase(), limpia);
  }
  return [...vistas.values()];
}

// Si alguna colonia ya está en otra zona, el mensaje dice en cuál (null si no)
async function coloniaEnOtraZona(db, colonias, zonaId) {
  if (colonias.length === 0) return null;
  const { rows } = await db.query(`
    SELECT zc.colonia, z.nombre AS zona
    FROM core.tblzonas_colonias zc
    JOIN core.tblzonas_envio z ON z.id = zc.zona_id
    WHERE LOWER(zc.colonia) = ANY($1::text[]) AND zc.zona_id IS DISTINCT FROM $2::int
    ORDER BY zc.colonia LIMIT 1
  `, [colonias.map(c => c.toLowerCase()), zonaId]);
  return rows[0] ? `La colonia "${rows[0].colonia}" ya pertenece a la zona "${rows[0].zona}"` : null;
}
const MSG_COLONIA_REPETIDA = 'Una de las colonias o comunidades ya pertenece a otra zona';

// ── Cotizar envío por colonia (público: se usa en el checkout) ──
router.get('/cotizar', async (req, res) => {
  try {
    const { colonia } = req.query;
    if (!colonia) return res.status(400).json({ success: false, message: 'La colonia es requerida' });
    const result = await pool.query(`
      SELECT z.id AS zona_id, z.nombre AS zona_nombre, z.tarifa
      FROM core.tblzonas_colonias zc
      JOIN core.tblzonas_envio z ON z.id = zc.zona_id
      WHERE LOWER(zc.colonia) = LOWER($1) AND z.activa = TRUE
    `, [String(colonia).trim()]);
    if (result.rows.length === 0) {
      return res.json({ success: true, cobertura: false, message: 'Sin cobertura en esa colonia o comunidad. Puedes recoger en sucursal.' });
    }
    const zona = result.rows[0];
    res.json({ success: true, cobertura: true, zona_id: zona.zona_id, zona: zona.zona_nombre, tarifa: parseFloat(zona.tarifa) });
  } catch (error) {
    console.error('Error GET /zonas-envio/cotizar:', error.message);
    res.status(500).json({ success: false, message: 'Error al cotizar envío' });
  }
});

// ── Listar colonias con cobertura (público: datalist del checkout) ──
router.get('/colonias', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT zc.colonia, z.nombre AS zona, z.tarifa
      FROM core.tblzonas_colonias zc
      JOIN core.tblzonas_envio z ON z.id = zc.zona_id
      WHERE z.activa = TRUE
      ORDER BY zc.colonia
    `);
    res.json({ success: true, colonias: result.rows });
  } catch (error) {
    console.error('Error GET /zonas-envio/colonias:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener colonias' });
  }
});

// ── Listar zonas con sus colonias (gerencia+) ──
router.get('/', verifyToken, verifyRole('gerencia', 'direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT z.id, z.nombre, z.tarifa, z.activa, z.created_at,
             COALESCE(json_agg(zc.colonia ORDER BY zc.colonia) FILTER (WHERE zc.id IS NOT NULL), '[]') AS colonias
      FROM core.tblzonas_envio z
      LEFT JOIN core.tblzonas_colonias zc ON zc.zona_id = z.id
      GROUP BY z.id
      ORDER BY z.tarifa
    `);
    res.json({ success: true, zonas: result.rows });
  } catch (error) {
    console.error('Error GET /zonas-envio:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener zonas' });
  }
});

// ── Crear zona (dirección) ──
router.post('/', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  const { nombre, tarifa, colonias } = req.body;
  const lista = Array.isArray(colonias) ? coloniasLimpias(colonias) : [];
  let client;
  try {
    if (!nombre || typeof nombre !== 'string' || tarifa === undefined || isNaN(parseFloat(tarifa)) || parseFloat(tarifa) < 0) {
      return res.status(400).json({ success: false, message: 'Nombre y tarifa válida son requeridos' });
    }
    client = await pool.connect();
    await client.query('BEGIN');
    const choque = await coloniaEnOtraZona(client, lista, null);
    if (choque) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: choque });
    }
    const zonaResult = await client.query(
      'INSERT INTO core.tblzonas_envio (nombre, tarifa, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING *',
      [nombre.trim(), parseFloat(tarifa)]
    );
    const zona = zonaResult.rows[0];
    for (const colonia of lista) {
      await client.query('INSERT INTO core.tblzonas_colonias (zona_id, colonia) VALUES ($1, $2)', [zona.id, colonia]);
    }
    const totalColonias = await contarColonias(client, zona.id);
    await client.query('COMMIT');
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Creó zona de envío', entidad: 'zona_envio', entidad_id: zona.id, detalles: `"${zona.nombre}" · $${zona.tarifa} · ${textoColonias(totalColonias)}`, ip: req.ip });
    res.status(201).json({ success: true, zona, message: `Zona "${zona.nombre}" creada` });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      // Otra zona tomó la colonia mientras tanto
      const choque = await coloniaEnOtraZona(pool, lista, null).catch(() => null);
      return res.status(400).json({ success: false, message: choque || MSG_COLONIA_REPETIDA });
    }
    console.error('Error POST /zonas-envio:', error.message);
    res.status(500).json({ success: false, message: 'Error al crear zona' });
  } finally { if (client) client.release(); }
});

// ── Actualizar zona: nombre/tarifa/activa y reemplazo de colonias (dirección) ──
router.put('/:id', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  const { nombre, tarifa, activa, colonias } = req.body;
  const lista = Array.isArray(colonias) ? coloniasLimpias(colonias) : [];
  if (!/^\d{1,9}$/.test(req.params.id)) return res.status(404).json({ success: false, message: 'Zona no encontrada' });
  const zonaId = Number(req.params.id);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Tarifa anterior para la bitácora, con la fila bloqueada hasta el COMMIT
    const anterior = await client.query('SELECT tarifa FROM core.tblzonas_envio WHERE id = $1 FOR UPDATE', [zonaId]);
    const result = await client.query(`
      UPDATE core.tblzonas_envio
      SET nombre = COALESCE($1, nombre),
          tarifa = COALESCE($2, tarifa),
          activa = COALESCE($3, activa),
          updated_at = NOW()
      WHERE id = $4 RETURNING *
    `, [nombre, tarifa !== undefined ? parseFloat(tarifa) : null, activa, zonaId]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Zona no encontrada' });
    }
    let totalColonias = null;
    if (Array.isArray(colonias)) {
      const choque = await coloniaEnOtraZona(client, lista, zonaId);
      if (choque) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: choque });
      }
      await client.query('DELETE FROM core.tblzonas_colonias WHERE zona_id = $1', [zonaId]);
      for (const colonia of lista) {
        await client.query('INSERT INTO core.tblzonas_colonias (zona_id, colonia) VALUES ($1, $2)', [zonaId, colonia]);
      }
      totalColonias = await contarColonias(client, zonaId);
    }
    await client.query('COMMIT');

    const zona = result.rows[0];
    const tarifaAnterior = anterior.rows[0].tarifa;
    let detalles = `"${zona.nombre}"`;
    if (tarifaAnterior !== zona.tarifa) detalles += ` · tarifa $${tarifaAnterior} → $${zona.tarifa}`;
    if (!zona.activa) detalles += ' · inactiva';
    if (totalColonias !== null) detalles += ` · ${textoColonias(totalColonias)}`;
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Actualizó zona de envío', entidad: 'zona_envio', entidad_id: zona.id, detalles, ip: req.ip });
    res.json({ success: true, zona, message: 'Zona actualizada' });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      // Otra zona tomó la colonia mientras tanto
      const choque = await coloniaEnOtraZona(pool, lista, zonaId).catch(() => null);
      return res.status(400).json({ success: false, message: choque || MSG_COLONIA_REPETIDA });
    }
    console.error('Error PUT /zonas-envio/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar zona' });
  } finally { if (client) client.release(); }
});

// ── Eliminar zona (dirección; las colonias caen en cascada) ──
router.delete('/:id', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM core.tblzonas_envio WHERE id = $1 RETURNING id, nombre', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Zona no encontrada' });
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Eliminó zona de envío', entidad: 'zona_envio', entidad_id: result.rows[0].id, detalles: `"${result.rows[0].nombre}"`, ip: req.ip });
    res.json({ success: true, message: `Zona "${result.rows[0].nombre}" eliminada` });
  } catch (error) {
    console.error('Error DELETE /zonas-envio/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al eliminar zona' });
  }
});

module.exports = router;
