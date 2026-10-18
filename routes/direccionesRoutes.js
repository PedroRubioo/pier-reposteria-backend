// routes/direccionesRoutes.js — Libreta de direcciones de entrega del cliente
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { textoLibre, enteroPositivo, telefono10, coloniaNormalizadaSql } = require('../utils/validacionCliente');

// Zona de envío de la dirección `d`, sin acentos ni mayúsculas: "Tahuizan"
// cobra la tarifa de "Tahuizán" (Diseno_Panel_Cliente.md §5.13). El LIMIT 1
// evita direcciones repetidas si dos colonias coincidieran al normalizar
const ZONA_DE_DIRECCION = `LEFT JOIN LATERAL (
        SELECT z.id AS zona_id, z.nombre AS zona_nombre, z.tarifa
          FROM core.tblzonas_colonias zc
          JOIN core.tblzonas_envio z ON z.id = zc.zona_id AND z.activa = TRUE
         WHERE ${coloniaNormalizadaSql('zc.colonia')} = ${coloniaNormalizadaSql('d.colonia')}
         ORDER BY (zc.colonia = d.colonia) DESC, zc.id
         LIMIT 1) zona ON TRUE`;

const MSG_REQUERIDOS = 'Alias, calle y número, y colonia son requeridos';
const MSG_NUMERO = 'Incluye el número de la casa en "Calle y número"';

// Campos de texto con el largo de su columna (regla de §5.0: solo se rechaza
// lo que no cabe o se guarda inservible)
const CAMPOS_TEXTO = [
  ['alias', 50, 'El alias puede tener hasta 50 caracteres'],
  ['calle_numero', 150, 'La calle y número pueden tener hasta 150 caracteres'],
  ['colonia', 120, 'La colonia puede tener hasta 120 caracteres'],
];

/** Coordenada opcional en rango; undefined si no es válida */
function coordenada(valor, limite) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = typeof valor === 'number' ? valor : (typeof valor === 'string' ? Number(valor) : NaN);
  return Number.isFinite(n) && Math.abs(n) <= limite ? n : undefined;
}

/**
 * Valida los campos que vienen. En el alta los tres de texto son obligatorios;
 * al editar, lo que no viene (o viene null) se conserva.
 * @returns {{ error: string } | { valores: object }}
 */
function validarDireccion(body, { alta, telefonoGuardado = null }) {
  const valores = {};
  for (const [campo, max, mensajeLargo] of CAMPOS_TEXTO) {
    const valor = body[campo]; // eslint-disable-line security/detect-object-injection
    if (valor === undefined || valor === null) {
      if (alta) return { error: MSG_REQUERIDOS };
      valores[campo] = null; // eslint-disable-line security/detect-object-injection
      continue;
    }
    const limpio = textoLibre(valor, { min: 1 });
    if (!limpio.ok) return { error: MSG_REQUERIDOS };
    if (Array.from(limpio.valor).length > max) return { error: mensajeLargo };
    valores[campo] = limpio.valor; // eslint-disable-line security/detect-object-injection
  }
  if (valores.calle_numero !== null && !/\d/.test(valores.calle_numero)) return { error: MSG_NUMERO };

  // Referencias: texto sin tope nuevo (columna text); vacío las borra
  valores.cambiaReferencias = body.referencias !== undefined && body.referencias !== null;
  valores.referencias = null;
  if (valores.cambiaReferencias) {
    const referencias = textoLibre(body.referencias, { opcional: true });
    if (!referencias.ok) return { error: 'Las referencias deben ser texto' };
    valores.referencias = referencias.valor;
  }

  // Teléfono: 10 dígitos; vacío lo borra. Igual al guardado, se conserva sin validar
  const telefono = body.telefono_contacto;
  valores.cambiaTelefono = telefono !== undefined && telefono !== null
    && !(!alta && String(telefono).trim() === String(telefonoGuardado ?? '').trim());
  valores.telefono_contacto = null;
  if (valores.cambiaTelefono) {
    const tel = telefono10(telefono);
    if (!tel.ok) return { error: 'El teléfono debe tener 10 dígitos' };
    valores.telefono_contacto = tel.valor;
  }

  valores.lat = coordenada(body.lat, 90);
  valores.lng = coordenada(body.lng, 180);
  if (valores.lat === undefined || valores.lng === undefined) return { error: 'La ubicación del mapa no es válida' };
  return { valores };
}

// ── Listar mis direcciones (con zona y tarifa si hay cobertura) ──
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.id, d.alias, d.calle_numero, d.colonia, d.referencias, d.telefono_contacto, d.lat, d.lng, d.created_at,
             zona.zona_id, zona.zona_nombre, zona.tarifa
      FROM core.tbldirecciones d
      ${ZONA_DE_DIRECCION}
      WHERE d.usuario_id = $1 AND d.activa = TRUE
      ORDER BY d.created_at DESC
    `, [req.user.userId]);
    res.json({ success: true, direcciones: result.rows });
  } catch (error) {
    console.error('Error GET /direcciones:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener direcciones' });
  }
});

// ── Crear dirección ──
router.post('/', verifyToken, async (req, res) => {
  try {
    const validacion = validarDireccion(req.body || {}, { alta: true });
    if (validacion.error) return res.status(400).json({ success: false, message: validacion.error });
    const v = validacion.valores;
    const result = await pool.query(`
      INSERT INTO core.tbldirecciones (usuario_id, alias, calle_numero, colonia, referencias, telefono_contacto, lat, lng, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      RETURNING id, alias, calle_numero, colonia, referencias, telefono_contacto, lat, lng, created_at
    `, [req.user.userId, v.alias, v.calle_numero, v.colonia, v.referencias, v.telefono_contacto, v.lat, v.lng]);
    res.status(201).json({ success: true, direccion: result.rows[0], message: 'Dirección guardada' });
  } catch (error) {
    console.error('Error POST /direcciones:', error.message);
    res.status(500).json({ success: false, message: 'Error al guardar dirección' });
  }
});

// ── Actualizar dirección propia (lo que no viene se conserva) ──
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const id = enteroPositivo(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: 'Dirección no encontrada' });
    const actual = await pool.query(
      'SELECT telefono_contacto FROM core.tbldirecciones WHERE id = $1 AND usuario_id = $2 AND activa = TRUE',
      [id, req.user.userId]
    );
    if (actual.rows.length === 0) return res.status(404).json({ success: false, message: 'Dirección no encontrada' });
    const validacion = validarDireccion(req.body || {}, { alta: false, telefonoGuardado: actual.rows[0].telefono_contacto });
    if (validacion.error) return res.status(400).json({ success: false, message: validacion.error });
    const v = validacion.valores;
    const result = await pool.query(`
      UPDATE core.tbldirecciones
      SET alias = COALESCE($1, alias),
          calle_numero = COALESCE($2, calle_numero),
          colonia = COALESCE($3, colonia),
          referencias = CASE WHEN $4::boolean THEN $5::text ELSE referencias END,
          telefono_contacto = CASE WHEN $6::boolean THEN $7::varchar ELSE telefono_contacto END,
          lat = COALESCE($8, lat),
          lng = COALESCE($9, lng),
          updated_at = NOW()
      WHERE id = $10 AND usuario_id = $11 AND activa = TRUE
      RETURNING id, alias, calle_numero, colonia, referencias, telefono_contacto, lat, lng
    `, [v.alias, v.calle_numero, v.colonia, v.cambiaReferencias, v.referencias, v.cambiaTelefono, v.telefono_contacto, v.lat, v.lng, id, req.user.userId]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Dirección no encontrada' });
    res.json({ success: true, direccion: result.rows[0], message: 'Dirección actualizada' });
  } catch (error) {
    console.error('Error PUT /direcciones/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar dirección' });
  }
});

// ── Eliminar dirección propia (borrado lógico: los pedidos guardan snapshot) ──
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const id = enteroPositivo(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: 'Dirección no encontrada' });
    const result = await pool.query(
      'UPDATE core.tbldirecciones SET activa = FALSE, updated_at = NOW() WHERE id = $1 AND usuario_id = $2 AND activa = TRUE RETURNING id',
      [id, req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Dirección no encontrada' });
    res.json({ success: true, message: 'Dirección eliminada' });
  } catch (error) {
    console.error('Error DELETE /direcciones/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al eliminar dirección' });
  }
});

module.exports = router;
