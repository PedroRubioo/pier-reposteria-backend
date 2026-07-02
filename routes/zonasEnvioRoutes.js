// routes/zonasEnvioRoutes.js — Zonas de cobertura y tarifas de envío a domicilio
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');

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
  const client = await pool.connect();
  try {
    const { nombre, tarifa, colonias } = req.body;
    if (!nombre || tarifa === undefined || isNaN(parseFloat(tarifa)) || parseFloat(tarifa) < 0) {
      return res.status(400).json({ success: false, message: 'Nombre y tarifa válida son requeridos' });
    }
    await client.query('BEGIN');
    const zonaResult = await client.query(
      'INSERT INTO core.tblzonas_envio (nombre, tarifa, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING *',
      [nombre.trim(), parseFloat(tarifa)]
    );
    const zona = zonaResult.rows[0];
    if (Array.isArray(colonias)) {
      for (const colonia of colonias) {
        if (colonia && colonia.trim()) {
          await client.query('INSERT INTO core.tblzonas_colonias (zona_id, colonia) VALUES ($1, $2)', [zona.id, colonia.trim()]);
        }
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, zona, message: `Zona "${zona.nombre}" creada` });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(400).json({ success: false, message: 'Una de las colonias o comunidades ya pertenece a otra zona' });
    }
    console.error('Error POST /zonas-envio:', error.message);
    res.status(500).json({ success: false, message: 'Error al crear zona' });
  } finally { client.release(); }
});

// ── Actualizar zona: nombre/tarifa/activa y reemplazo de colonias (dirección) ──
router.put('/:id', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { nombre, tarifa, activa, colonias } = req.body;
    await client.query('BEGIN');
    const result = await client.query(`
      UPDATE core.tblzonas_envio
      SET nombre = COALESCE($1, nombre),
          tarifa = COALESCE($2, tarifa),
          activa = COALESCE($3, activa),
          updated_at = NOW()
      WHERE id = $4 RETURNING *
    `, [nombre, tarifa !== undefined ? parseFloat(tarifa) : null, activa, req.params.id]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Zona no encontrada' });
    }
    if (Array.isArray(colonias)) {
      await client.query('DELETE FROM core.tblzonas_colonias WHERE zona_id = $1', [req.params.id]);
      for (const colonia of colonias) {
        if (colonia && colonia.trim()) {
          await client.query('INSERT INTO core.tblzonas_colonias (zona_id, colonia) VALUES ($1, $2)', [req.params.id, colonia.trim()]);
        }
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, zona: result.rows[0], message: 'Zona actualizada' });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(400).json({ success: false, message: 'Una de las colonias o comunidades ya pertenece a otra zona' });
    }
    console.error('Error PUT /zonas-envio/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar zona' });
  } finally { client.release(); }
});

// ── Eliminar zona (dirección; las colonias caen en cascada) ──
router.delete('/:id', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM core.tblzonas_envio WHERE id = $1 RETURNING id, nombre', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Zona no encontrada' });
    res.json({ success: true, message: `Zona "${result.rows[0].nombre}" eliminada` });
  } catch (error) {
    console.error('Error DELETE /zonas-envio/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al eliminar zona' });
  }
});

module.exports = router;
