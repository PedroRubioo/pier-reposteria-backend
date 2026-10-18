// routes/productosRoutes.js — Productos y Categorías (corregido al schema real)
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');
const { accesoVigente } = require('../middleware/usuarioVigente');
const { registrarAuditoria } = require('../utils/auditoria');

// ══════════════════════════════════════
// PÚBLICOS (sin auth)
// ══════════════════════════════════════

// Listar categorías activas
router.get('/categorias', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, nombre, descripcion, imagen_url, imagen_public_id, orden, activo, created_at, updated_at
      FROM core.tblcategorias
      ORDER BY orden ASC, nombre ASC
    `);
    res.json({ success: true, categorias: result.rows });
  } catch (error) {
    console.error('Error GET /categorias:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener categorías' });
  }
});

// Listar productos con filtros
// Auto-actualizar populares (máximo 1 vez por hora)
let ultimaActualizacionPopulares = 0;
const actualizarPopularesAuto = async () => {
  const ahora = Date.now();
  if (ahora - ultimaActualizacionPopulares < 3600000) return; // 1 hora
  ultimaActualizacionPopulares = ahora;
  try {
    const fecha = new Date();
    const diaSemana = fecha.getDay();
    const inicioSemana = new Date(fecha);
    inicioSemana.setDate(fecha.getDate() - diaSemana);
    inicioSemana.setHours(0, 0, 0, 0);
    const topResult = await pool.query(`
      SELECT pi.producto_id FROM core.tblpedido_items pi
      JOIN core.tblpedidos p ON pi.pedido_id = p.id
      WHERE p.created_at >= $1 AND p.estado NOT IN ('cancelado')
      GROUP BY pi.producto_id
      ORDER BY SUM(pi.cantidad) DESC
      LIMIT 5
    `, [inicioSemana.toISOString()]);
    const topIds = topResult.rows.map(r => r.producto_id);
    await pool.query('UPDATE core.tblproductos SET popular = false, updated_at = NOW() WHERE popular = true');
    if (topIds.length > 0) {
      await pool.query('UPDATE core.tblproductos SET popular = true, updated_at = NOW() WHERE id = ANY($1)', [topIds]);
    }
  } catch (err) { console.error('Error auto-popular:', err.message); }
};

router.get('/productos', async (req, res) => {
  try {
    // Auto-actualizar populares en segundo plano
    actualizarPopularesAuto();
    const { categoria, busqueda, sabor, tamano, tipo, precio_min, precio_max, ordenar, popular, limite, offset, incluir_inactivos } = req.query;

    let query = `
      SELECT
        p.id, p.nombre, p.descripcion, p.precio_chico, p.precio_grande,
        p.imagen_url, p.imagen_public_id, p.imagenes, p.ingredientes,
        p.sabor, p.tamano, p.tipo, p.popular, p.es_nuevo,
        p.stock_online, p.activo, p.created_at,
        c.id AS categoria_id, c.nombre AS categoria,
        COALESCE(AVG(r.rating), 0)::NUMERIC(2,1) AS rating,
        COUNT(DISTINCT r.id)::INTEGER AS reviews
      FROM core.tblproductos p
      JOIN core.tblcategorias c ON p.categoria_id = c.id
      LEFT JOIN core.tblresenas r ON r.producto_id = p.id AND r.estado = 'aprobada'
      WHERE c.activo = true ${incluir_inactivos === 'true' ? '' : 'AND p.activo = true'}
    `;
    const params = [];
    let pi = 1;

    if (categoria && categoria !== 'Todos') {
      query += ` AND c.nombre = $${pi}`;
      params.push(categoria); pi++;
    }
    if (busqueda) {
      query += ` AND (p.nombre ILIKE $${pi} OR p.descripcion ILIKE $${pi})`;
      params.push(`%${busqueda}%`); pi++;
    }
    if (sabor && sabor !== 'Todos') {
      query += ` AND p.sabor = $${pi}`;
      params.push(sabor); pi++;
    }
    if (tamano && tamano !== 'Todos') {
      query += ` AND p.tamano = $${pi}`;
      params.push(tamano); pi++;
    }
    if (tipo && tipo !== 'Todos') {
      query += ` AND p.tipo = $${pi}`;
      params.push(tipo); pi++;
    }
    if (precio_min) {
      query += ` AND p.precio_chico >= $${pi}`;
      params.push(parseFloat(precio_min)); pi++;
    }
    if (precio_max) {
      query += ` AND p.precio_chico <= $${pi}`;
      params.push(parseFloat(precio_max)); pi++;
    }
    if (popular === 'true') {
      query += ` AND p.popular = true`;
    }

    query += ` GROUP BY p.id, c.id, c.nombre`;

    switch (ordenar) {
      case 'precio-asc': query += ` ORDER BY p.precio_chico ASC`; break;
      case 'precio-desc': query += ` ORDER BY p.precio_chico DESC`; break;
      case 'nombre': query += ` ORDER BY p.nombre ASC`; break;
      case 'rating': query += ` ORDER BY rating DESC, reviews DESC`; break;
      case 'recientes': query += ` ORDER BY p.created_at DESC`; break;
      default: query += ` ORDER BY p.popular DESC, reviews DESC, p.nombre ASC`; break;
    }

    if (limite) {
      const lim = parseInt(limite);
      const off = parseInt(offset) || 0;
      query += ` LIMIT $${pi} OFFSET $${pi + 1}`;
      params.push(lim, off);
    }

    const result = await pool.query(query, params);
    res.json({ success: true, productos: result.rows, total: result.rowCount });
  } catch (error) {
    console.error('Error GET /productos:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener productos' });
  }
});

// Detalle de producto
router.get('/productos/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT p.*, c.nombre AS categoria, c.id AS categoria_id,
        COALESCE(AVG(r.rating), 0)::NUMERIC(2,1) AS rating_promedio,
        COUNT(DISTINCT r.id)::INTEGER AS reviews
      FROM core.tblproductos p
      JOIN core.tblcategorias c ON p.categoria_id = c.id
      LEFT JOIN core.tblresenas r ON r.producto_id = p.id AND r.estado = 'aprobada'
      WHERE p.id = $1
      GROUP BY p.id, c.nombre, c.id
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    }

    const producto = result.rows[0];

    // Reseñas aprobadas
    const resenas = await pool.query(`
      SELECT r.id, r.usuario_id, r.rating, r.titulo, r.comentario, r.fotos, r.util_count, r.verificada, r.respuesta_negocio, r.created_at,
        u.nombre AS autor_nombre, u.apellido AS autor_apellido
      FROM core.tblresenas r
      JOIN core.tblusuarios u ON r.usuario_id = u.id
      WHERE r.producto_id = $1 AND r.estado = 'aprobada'
      ORDER BY r.created_at DESC LIMIT 10
    `, [id]);

    // Productos relacionados
    const relacionados = await pool.query(`
      SELECT p.id, p.nombre, p.precio_chico, p.precio_grande, p.imagen_url, p.popular,
        c.nombre AS categoria,
        COALESCE(AVG(r.rating), 0)::NUMERIC(2,1) AS rating,
        COUNT(DISTINCT r.id)::INTEGER AS reviews
      FROM core.tblproductos p
      JOIN core.tblcategorias c ON p.categoria_id = c.id
      LEFT JOIN core.tblresenas r ON r.producto_id = p.id AND r.estado = 'aprobada'
      WHERE p.categoria_id = $1 AND p.id != $2 AND p.activo = true
      GROUP BY p.id, c.nombre
      ORDER BY RANDOM() LIMIT 4
    `, [producto.categoria_id, id]);

    res.json({ success: true, producto, resenas: resenas.rows, relacionados: relacionados.rows });
  } catch (error) {
    console.error('Error GET /productos/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener producto' });
  }
});

// Productos destacados (inicio)
router.get('/productos-destacados', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.nombre, p.descripcion, p.precio_chico, p.precio_grande,
        p.imagen_url, p.sabor, p.tipo, p.popular,
        c.nombre AS categoria,
        COALESCE(AVG(r.rating), 0)::NUMERIC(2,1) AS rating,
        COUNT(DISTINCT r.id)::INTEGER AS reviews
      FROM core.tblproductos p
      JOIN core.tblcategorias c ON p.categoria_id = c.id
      LEFT JOIN core.tblresenas r ON r.producto_id = p.id AND r.estado = 'aprobada'
      WHERE p.activo = true AND p.popular = true
      GROUP BY p.id, c.nombre
      ORDER BY reviews DESC LIMIT 8
    `);
    res.json({ success: true, productos: result.rows });
  } catch (error) {
    console.error('Error GET /productos-destacados:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener destacados' });
  }
});

// Actualizar populares: productos con 7+ compras desde el lunes de esta semana
// Se reinicia cada semana (lunes a sábado). Solo el personal: reescribe el catálogo
router.post('/actualizar-populares', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    // Calcular inicio de semana (domingo)
    const ahora = new Date();
    const diaSemana = ahora.getDay(); // 0=domingo
    const inicioSemana = new Date(ahora);
    inicioSemana.setDate(ahora.getDate() - diaSemana);
    inicioSemana.setHours(0, 0, 0, 0);

    // Top 5 productos más vendidos de la semana
    const topResult = await pool.query(`
      SELECT pi.producto_id, SUM(pi.cantidad)::INTEGER as total_vendido
      FROM core.tblpedido_items pi
      JOIN core.tblpedidos p ON pi.pedido_id = p.id
      WHERE p.created_at >= $1
        AND p.estado NOT IN ('cancelado')
      GROUP BY pi.producto_id
      ORDER BY total_vendido DESC
      LIMIT 5
    `, [inicioSemana.toISOString()]);

    const topIds = topResult.rows.map(r => r.producto_id);

    // Quitar popular a todos
    await pool.query('UPDATE core.tblproductos SET popular = false, updated_at = NOW() WHERE popular = true');

    // Marcar como populares los que tienen 7+ compras
    let marcados = 0;
    if (topIds.length > 0) {
      const marcado = await pool.query(`UPDATE core.tblproductos SET popular = true, updated_at = NOW() WHERE id = ANY($1)`, [topIds]);
      marcados = marcado.rowCount;
    }

    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Recalculó productos populares', entidad: 'producto', entidad_id: null, detalles: `${marcados} populares`, ip: req.ip });
    res.json({
      success: true,
      message: `${topIds.length} productos populares (7+ compras desde domingo ${inicioSemana.toLocaleDateString('es-MX')})`,
      productos_populares: topIds,
      desde: inicioSemana.toISOString()
    });
  } catch (error) {
    console.error('Error actualizando populares:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar populares' });
  }
});

// Filtros disponibles
router.get('/filtros', async (req, res) => {
  try {
    const [sabores, tamanos, tipos] = await Promise.all([
      pool.query(`SELECT DISTINCT sabor FROM core.tblproductos WHERE sabor IS NOT NULL AND activo = true ORDER BY sabor`),
      pool.query(`SELECT DISTINCT tamano FROM core.tblproductos WHERE tamano IS NOT NULL AND activo = true ORDER BY tamano`),
      pool.query(`SELECT DISTINCT tipo FROM core.tblproductos WHERE tipo IS NOT NULL AND activo = true ORDER BY tipo`)
    ]);
    res.json({
      success: true,
      filtros: {
        sabores: ['Todos', ...sabores.rows.map(r => r.sabor)],
        tamanos: ['Todos', ...tamanos.rows.map(r => r.tamano)],
        tipos: ['Todos', ...tipos.rows.map(r => r.tipo)]
      }
    });
  } catch (error) {
    console.error('Error GET /filtros:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener filtros' });
  }
});

// ══════════════════════════════════════
// PROTEGIDOS — EMPLEADO+ (CRUD)
// ══════════════════════════════════════

router.post('/productos', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { nombre, descripcion, categoria_id, precio_chico, precio_grande, imagen_url, imagen_public_id, imagenes, ingredientes, sabor, tamano, tipo, popular, es_nuevo, stock_online } = req.body;
    if (!nombre || !categoria_id || !precio_chico) {
      return res.status(400).json({ success: false, message: 'Nombre, categoría y precio son requeridos' });
    }
    const result = await pool.query(`
      INSERT INTO core.tblproductos (nombre, descripcion, categoria_id, precio_chico, precio_grande, imagen_url, imagen_public_id, imagenes, ingredientes, sabor, tamano, tipo, popular, es_nuevo, stock_online, activo, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true,NOW(),NOW()) RETURNING *
    `, [nombre, descripcion, categoria_id, precio_chico, precio_grande || null, imagen_url || null, imagen_public_id || null, imagenes ? JSON.stringify(imagenes) : null, ingredientes || null, sabor || null, tamano || null, tipo || null, popular || false, es_nuevo || false, stock_online || 0]);

    // Notificación masiva: nuevo producto
    const { crearNotificacionMasiva } = require('../services/notificacionHelper');
    await crearNotificacionMasiva({
      tipo: 'producto',
      titulo: `🆕 ¡Nuevo producto: ${nombre}!`,
      mensaje: `${descripcion ? descripcion.substring(0, 120) : 'Conoce nuestro nuevo producto artesanal'}. Desde $${precio_chico} MXN.`,
      enviado_por: req.user.userId
    });

    const producto = result.rows[0];
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Creó producto', entidad: 'producto', entidad_id: producto.id, detalles: `"${producto.nombre}" · $${producto.precio_chico}`, ip: req.ip });
    res.status(201).json({ success: true, producto });
  } catch (error) {
    console.error('Error POST /productos:', error.message);
    res.status(500).json({ success: false, message: 'Error al crear producto' });
  }
});

// Ajustar la existencia en línea desde la pestaña Existencias
// (Diseno_Panel_Personal.md §4.6). "anterior" es la existencia que vio la
// pantalla: si ya no coincide (llegó una venta mientras tanto) no se pisa y
// se responde 409 con la actual.
router.put('/productos/:id/existencia', accesoVigente(['empleado', 'gerencia', 'direccion_general']), async (req, res) => {
  try {
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    const id = Number(req.params.id);
    const { existencia, anterior } = req.body;
    // anterior: cualquier entero que quepa en la columna (la pantalla manda el que vio)
    if (!Number.isInteger(existencia) || existencia < 0 || existencia > 9999 || !Number.isInteger(anterior) || Math.abs(anterior) > 2147483647) {
      return res.status(400).json({ success: false, message: 'La existencia debe ser un número entero de 0 a 9999' });
    }
    const result = await pool.query(
      `UPDATE core.tblproductos SET stock_online = $1, updated_at = NOW()
        WHERE id = $2 AND stock_online = $3 RETURNING id, nombre, stock_online`,
      [existencia, id, anterior]
    );
    if (result.rows.length === 0) {
      const actual = await pool.query('SELECT stock_online FROM core.tblproductos WHERE id = $1', [id]);
      if (actual.rows.length === 0) return res.status(404).json({ success: false, message: 'Producto no encontrado' });
      const existenciaActual = actual.rows[0].stock_online;
      return res.status(409).json({
        success: false,
        message: `La existencia cambió mientras la editabas (ahora hay ${existenciaActual}). Revisa y vuelve a guardar.`,
        existencia_actual: existenciaActual,
      });
    }
    const producto = result.rows[0];
    // Guardar el mismo número no es un cambio: la bitácora no registra "5 → 5"
    if (anterior !== producto.stock_online) {
      registrarAuditoria({ usuario_id: req.usuario.id, accion: 'Ajustó existencia', entidad: 'producto', entidad_id: producto.id, detalles: `"${producto.nombre}" · ${anterior} → ${producto.stock_online}`, ip: req.ip });
    }
    res.json({ success: true, producto });
  } catch (error) {
    console.error('Error PUT /productos/:id/existencia:', error.message);
    res.status(500).json({ success: false, message: 'Error al ajustar la existencia' });
  }
});

router.put('/productos/:id', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, descripcion, categoria_id, precio_chico, precio_grande, imagen_url, imagen_public_id, imagenes, ingredientes, sabor, tamano, tipo, popular, es_nuevo, stock_online, activo } = req.body;
    // precio_grande: null explícito lo borra; si no viene, se conserva (COALESCE)
    const borrarPrecioGrande = Object.prototype.hasOwnProperty.call(req.body, 'precio_grande') && req.body.precio_grande === null;
    // Stock previo: la bitácora solo lo menciona si cambió
    // (el formulario de edición manda el stock aunque no se toque)
    const previa = await pool.query('SELECT stock_online FROM core.tblproductos WHERE id = $1', [id]);
    const result = await pool.query(`
      UPDATE core.tblproductos SET
        nombre = COALESCE($1, nombre), descripcion = COALESCE($2, descripcion), categoria_id = COALESCE($3, categoria_id),
        precio_chico = COALESCE($4, precio_chico), precio_grande = CASE WHEN $18::boolean THEN NULL ELSE COALESCE($5, precio_grande) END,
        imagen_url = COALESCE($6, imagen_url), imagen_public_id = COALESCE($7, imagen_public_id), imagenes = COALESCE($8, imagenes),
        ingredientes = COALESCE($9, ingredientes), sabor = COALESCE($10, sabor), tamano = COALESCE($11, tamano), tipo = COALESCE($12, tipo),
        popular = COALESCE($13, popular), es_nuevo = COALESCE($14, es_nuevo), stock_online = COALESCE($15, stock_online), activo = COALESCE($16, activo),
        updated_at = NOW()
      WHERE id = $17 RETURNING *
    `, [nombre, descripcion, categoria_id, precio_chico, precio_grande, imagen_url, imagen_public_id, imagenes ? JSON.stringify(imagenes) : null, ingredientes, sabor, tamano, tipo, popular, es_nuevo, stock_online, activo, id, borrarPrecioGrande]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    const producto = result.rows[0];
    let detalles = `"${producto.nombre}"`;
    if (previa.rows[0]?.stock_online !== producto.stock_online) detalles += ` · stock ${producto.stock_online}`;
    if (!producto.activo) detalles += ' · inactivo';
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Actualizó producto', entidad: 'producto', entidad_id: producto.id, detalles, ip: req.ip });
    res.json({ success: true, producto });
  } catch (error) {
    console.error('Error PUT /productos/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar producto' });
  }
});

router.delete('/productos/:id', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const result = await pool.query('UPDATE core.tblproductos SET activo = false, updated_at = NOW() WHERE id = $1 RETURNING id, nombre', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'No encontrado' });
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Desactivó producto', entidad: 'producto', entidad_id: result.rows[0].id, detalles: `"${result.rows[0].nombre}"`, ip: req.ip });
    res.json({ success: true, message: `"${result.rows[0].nombre}" desactivado` });
  } catch (error) {
    console.error('Error DELETE /productos/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al eliminar producto' });
  }
});

// CRUD Categorías
router.post('/categorias', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { nombre, descripcion, imagen_url, imagen_public_id, orden } = req.body;
    if (!nombre) return res.status(400).json({ success: false, message: 'Nombre es requerido' });
    const result = await pool.query(`
      INSERT INTO core.tblcategorias (nombre, descripcion, imagen_url, imagen_public_id, orden, activo, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,true,NOW(),NOW()) RETURNING *
    `, [nombre, descripcion || null, imagen_url || null, imagen_public_id || null, orden || 0]);
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Creó categoría', entidad: 'categoria', entidad_id: result.rows[0].id, detalles: `"${result.rows[0].nombre}"`, ip: req.ip });
    res.status(201).json({ success: true, categoria: result.rows[0] });
  } catch (error) {
    console.error('Error POST /categorias:', error.message);
    res.status(500).json({ success: false, message: 'Error al crear categoría' });
  }
});

router.put('/categorias/:id', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { nombre, descripcion, imagen_url, imagen_public_id, orden, activo } = req.body;
    // Estado previo: la bitácora distingue activar o desactivar de una edición
    // (el formulario de edición manda "activo" aunque no cambie)
    const previa = await pool.query('SELECT activo FROM core.tblcategorias WHERE id = $1', [req.params.id]);
    const result = await pool.query(`
      UPDATE core.tblcategorias SET
        nombre = COALESCE($1, nombre),
        descripcion = COALESCE($2, descripcion),
        imagen_url = COALESCE($3, imagen_url), 
        imagen_public_id = COALESCE($4, imagen_public_id),
        orden = COALESCE($5, orden), 
        activo = CASE WHEN $6::text IS NOT NULL THEN $6::boolean ELSE activo END, 
        updated_at = NOW()
      WHERE id = $7 RETURNING *
    `, [nombre || null, descripcion || null, imagen_url || null, imagen_public_id || null, orden != null ? orden : null, activo != null ? String(activo) : null, req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'No encontrada' });
    const categoria = result.rows[0];
    let accion = 'Actualizó categoría';
    if (previa.rows[0]?.activo !== categoria.activo) accion = categoria.activo ? 'Reactivó categoría' : 'Desactivó categoría';
    registrarAuditoria({ usuario_id: req.user.userId, accion, entidad: 'categoria', entidad_id: categoria.id, detalles: `"${categoria.nombre}"`, ip: req.ip });
    res.json({ success: true, categoria });
  } catch (error) {
    console.error('Error PUT /categorias/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar categoría' });
  }
});

// "Eliminar" una categoría la desactiva (sus productos y pedidos la siguen
// citando). Mismos permisos que su PUT.
router.delete('/categorias/:id', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(404).json({ success: false, message: 'No encontrada' });
    const result = await pool.query(`
      WITH previa AS (SELECT id, activo FROM core.tblcategorias WHERE id = $1 FOR UPDATE)
      UPDATE core.tblcategorias c SET activo = false, updated_at = NOW()
        FROM previa WHERE c.id = previa.id
      RETURNING c.id, c.nombre, c.activo, previa.activo AS estaba_activa
    `, [Number(req.params.id)]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'No encontrada' });
    const { estaba_activa: estabaActiva, ...categoria } = result.rows[0];
    if (estabaActiva) {
      registrarAuditoria({ usuario_id: req.user.userId, accion: 'Desactivó categoría', entidad: 'categoria', entidad_id: categoria.id, detalles: `"${categoria.nombre}"`, ip: req.ip });
    }
    res.json({ success: true, categoria, message: `"${categoria.nombre}" desactivada` });
  } catch (error) {
    console.error('Error DELETE /categorias/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al desactivar categoría' });
  }
});

// ── Opciones por categoría (tipos y sabores dinámicos) ──
router.get('/categoria-opciones/:categoriaId', async (req, res) => {
  try {
    const { categoriaId } = req.params;
    const result = await pool.query(
      'SELECT id, tipo_opcion, nombre FROM core.tblcategoria_opciones WHERE categoria_id = $1 ORDER BY nombre',
      [categoriaId]
    );
    const tipos = result.rows.filter(r => r.tipo_opcion === 'tipo').map(r => ({ id: r.id, nombre: r.nombre }));
    const sabores = result.rows.filter(r => r.tipo_opcion === 'sabor').map(r => ({ id: r.id, nombre: r.nombre }));
    res.json({ success: true, tipos, sabores });
  } catch (error) {
    console.error('Error GET /categoria-opciones:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener opciones' });
  }
});

router.post('/categoria-opciones', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { categoria_id, tipo_opcion, nombre } = req.body;
    if (!categoria_id || !tipo_opcion || !nombre) return res.status(400).json({ success: false, message: 'Todos los campos son requeridos' });
    if (!['tipo', 'sabor'].includes(tipo_opcion)) return res.status(400).json({ success: false, message: 'tipo_opcion debe ser "tipo" o "sabor"' });
    const result = await pool.query(
      'INSERT INTO core.tblcategoria_opciones (categoria_id, tipo_opcion, nombre) VALUES ($1, $2, $3) RETURNING id, tipo_opcion, nombre',
      [categoria_id, tipo_opcion, nombre.trim()]
    );
    const opcion = result.rows[0];
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Agregó opción de categoría', entidad: 'categoria_opcion', entidad_id: opcion.id, detalles: `${opcion.tipo_opcion}: "${opcion.nombre}"`, ip: req.ip });
    res.status(201).json({ success: true, opcion: { id: opcion.id, nombre: opcion.nombre } });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, message: 'Esta opción ya existe para esta categoría' });
    console.error('Error POST /categoria-opciones:', error.message);
    res.status(500).json({ success: false, message: 'Error al crear opción' });
  }
});

router.put('/categoria-opciones/:id', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { nombre } = req.body;
    if (!nombre) return res.status(400).json({ success: false, message: 'Nombre es requerido' });
    // Nombre previo para la bitácora ("a" → "b")
    const previa = await pool.query('SELECT tipo_opcion, nombre FROM core.tblcategoria_opciones WHERE id = $1', [req.params.id]);
    const result = await pool.query(
      'UPDATE core.tblcategoria_opciones SET nombre = $1 WHERE id = $2 RETURNING id, nombre',
      [nombre.trim(), req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Opción no encontrada' });
    const antes = previa.rows[0];
    // Guardar el mismo nombre no es un cambio: la bitácora no registra "a" → "a"
    if (antes && antes.nombre !== result.rows[0].nombre) {
      registrarAuditoria({ usuario_id: req.user.userId, accion: 'Renombró opción de categoría', entidad: 'categoria_opcion', entidad_id: result.rows[0].id, detalles: `${antes.tipo_opcion}: "${antes.nombre}" → "${result.rows[0].nombre}"`, ip: req.ip });
    }
    res.json({ success: true, opcion: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, message: 'Ya existe una opción con ese nombre' });
    console.error('Error PUT /categoria-opciones:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar opción' });
  }
});

router.delete('/categoria-opciones/:id', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM core.tblcategoria_opciones WHERE id = $1 RETURNING id, tipo_opcion, nombre', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Opción no encontrada' });
    const opcion = result.rows[0];
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Eliminó opción de categoría', entidad: 'categoria_opcion', entidad_id: opcion.id, detalles: `${opcion.tipo_opcion}: "${opcion.nombre}"`, ip: req.ip });
    res.json({ success: true, message: 'Opción eliminada' });
  } catch (error) {
    console.error('Error DELETE /categoria-opciones:', error.message);
    res.status(500).json({ success: false, message: 'Error al eliminar opción' });
  }
});

module.exports = router;