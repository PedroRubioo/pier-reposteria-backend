// utils/comandas.js — Reglas del módulo de comandas
//
// Validación y normalización de lo que manda el formulario, snapshot de
// lo que hornos y decoración necesitan saber, diff legible entre
// versiones, semáforo, resumen de renglones (Diseno_Modulo_Comandas.md
// §4.5 a §4.7) y qué dinero ve cada rol (ocultarDinero). Todo es puro
// salvo validarComanda, que recibe la conexión (pool o el cliente de la
// transacción) para leer opciones y catálogo.

const TIPOS_OPCION = ['tamano', 'sabor', 'forma', 'decoracion'];
const TIPO_LEGIBLE = new Map([['tamano', 'tamaño'], ['sabor', 'sabor'], ['forma', 'forma'], ['decoracion', 'decoración']]);
const AREA_LEGIBLE = new Map([['hornos', 'Hornos'], ['decoracion', 'Decoración']]);

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MS_DIA = 86400000;

// Tope de NUMERIC(10,2) expresado en centavos: un total mayor no cabe en la tabla
const MAX_CENTAVOS = 9999999999;

// Solo se aceptan imágenes subidas por POST /api/comandas/imagenes
const PREFIJO_URL_IMAGEN = process.env.CLOUDINARY_CLOUD_NAME
  ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/`
  : null;
const PREFIJO_PUBLIC_ID = 'pier-reposteria/comandas/';

const CONTROL = /\p{Cc}/u;

// ══════════════════════════════════════
// NÚMEROS, FECHAS Y DINERO
// ══════════════════════════════════════

const esObjeto = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const esEntero = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
/** Id de base de datos: entero positivo que cabe en INTEGER */
const esId = (n) => esEntero(n, 1, 2147483647);

/** Número desde el JSON; acepta también texto numérico ("120") */
function aNumero(valor) {
  if (typeof valor === 'number') return valor;
  if (typeof valor === 'string' && valor.trim() !== '') return Number(valor);
  return NaN;
}

const FORMATO_MONEDA = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Los montos se suman en centavos enteros: con decimales flotantes 0.1 + 0.2 no da 0.3 */
const aCentavos = (monto) => Math.round(Number(monto) * 100);
/** '$1,234.50' */
const moneda = (centavos) => `$${FORMATO_MONEDA.format(centavos / 100)}`;
/** '1234.50', listo para una columna NUMERIC(10,2) */
const decimal = (centavos) => (centavos / 100).toFixed(2);

/** 'YYYY-MM-DD' que existe en el calendario (rechaza 2026-02-30) */
function esFechaValida(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10) === iso;
}

/** Días de calendario entre dos fechas 'YYYY-MM-DD' (negativo si hasta < desde) */
function diasEntre(desdeIso, hastaIso) {
  return Math.round((Date.parse(`${hastaIso}T00:00:00Z`) - Date.parse(`${desdeIso}T00:00:00Z`)) / MS_DIA);
}

/** '16/08/2026' */
function fechaCorta(iso) {
  const [anio, mes, dia] = iso.split('-');
  return `${dia}/${mes}/${anio}`;
}

/** 'sábado 16 de agosto' (el día de la semana se calcula en UTC: la fecha no tiene zona) */
function fechaLarga(iso) {
  const [anio, mes, dia] = iso.split('-').map(Number);
  const diaSemana = DIAS.at(new Date(Date.UTC(anio, mes - 1, dia)).getUTCDay());
  return `${diaSemana} ${dia} de ${MESES.at(mes - 1)}`;
}

/** '11:00 a. m.' a partir de 'HH:MM' */
function horaLegible(hhmm) {
  const [hora, minuto] = hhmm.split(':');
  const h = Number(hora);
  return `${h % 12 === 0 ? 12 : h % 12}:${minuto} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

/** Texto en una sola línea y con tope, para avisos de la campana */
function recortar(texto, max) {
  const linea = texto.replace(/\s+/g, ' ');
  return linea.length > max ? `${linea.slice(0, max - 1)}…` : linea;
}

// ══════════════════════════════════════
// AJUSTES Y SEMÁFORO
// ══════════════════════════════════════

const numeroGuardado = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/**
 * Ajustes desde core.tblconfiguracion_sistema (sección 'comandas', valores
 * jsonb). Sin valores de respaldo en el código: si falta una clave se
 * avisa con error en lugar de cobrar un anticipo inventado.
 */
function normalizarAjustes(valores) {
  const v = esObjeto(valores) ? valores : {};
  const ajustes = {
    anticipo_minimo_pct: numeroGuardado(v.anticipo_minimo_pct),
    dias_anticipacion_minima: numeroGuardado(v.dias_anticipacion_minima),
    semaforo_rojo_dias: numeroGuardado(v.semaforo_rojo_dias),
    semaforo_naranja_dias: numeroGuardado(v.semaforo_naranja_dias),
    semaforo_amarillo_dias: numeroGuardado(v.semaforo_amarillo_dias),
  };
  const faltan = Object.entries(ajustes).filter(([, n]) => !Number.isFinite(n)).map(([clave]) => clave);
  if (faltan.length > 0) throw new Error(`Faltan ajustes de comandas: ${faltan.join(', ')}`);
  return ajustes;
}

/** Valida el cuerpo de PUT /ajustes (todos enteros) */
function validarAjustes(entrada) {
  const e = esObjeto(entrada) ? entrada : {};
  const ajustes = {
    anticipo_minimo_pct: aNumero(e.anticipo_minimo_pct),
    dias_anticipacion_minima: aNumero(e.dias_anticipacion_minima),
    semaforo_rojo_dias: aNumero(e.semaforo_rojo_dias),
    semaforo_naranja_dias: aNumero(e.semaforo_naranja_dias),
    semaforo_amarillo_dias: aNumero(e.semaforo_amarillo_dias),
  };
  const errores = [];
  if (!esEntero(ajustes.anticipo_minimo_pct, 0, 100)) errores.push('Anticipo mínimo: debe ser un entero de 0 a 100 %');
  if (!esEntero(ajustes.dias_anticipacion_minima, 0, 60)) errores.push('Días de anticipación mínima: debe ser un entero de 0 a 60');
  const rojo = ajustes.semaforo_rojo_dias;
  const naranja = ajustes.semaforo_naranja_dias;
  const amarillo = ajustes.semaforo_amarillo_dias;
  if (![rojo, naranja, amarillo].every((n) => esEntero(n, 0, 90))) {
    errores.push('Semáforo: los umbrales deben ser enteros de 0 a 90 días');
  } else if (!(rojo < naranja && naranja < amarillo)) {
    errores.push('Semáforo: debe cumplirse rojo < naranja < amarillo');
  }
  return { errores, ajustes };
}

/** Semáforo por proximidad de la entrega (§4.7); null si ya no está activa */
function semaforo(estado, diasRestantes, ajustes) {
  if (estado !== 'activa') return null;
  if (diasRestantes < 0) return 'vencida';
  if (diasRestantes <= ajustes.semaforo_rojo_dias) return 'rojo';
  if (diasRestantes <= ajustes.semaforo_naranja_dias) return 'naranja';
  if (diasRestantes <= ajustes.semaforo_amarillo_dias) return 'amarillo';
  return 'verde';
}

// ══════════════════════════════════════
// RENGLONES: RESUMEN Y FILAS DE LA BASE
// ══════════════════════════════════════

/** 'Pastel Doble chocolate · 25 personas', '2 × Tart Bites 24 piezas' */
function describirRenglon(r) {
  const cantidad = r.cantidad > 1 ? `${r.cantidad} × ` : '';
  if (r.tipo === 'pastel') return `${cantidad}${r.nombre} · ${r.tamano}`;
  return `${cantidad}${r.nombre}${r.tamano_catalogo === 'grande' ? ' (grande)' : ''}`;
}

const resumenRenglones = (renglones) => renglones.map(describirRenglon).join(' + ');

/** Renglón guardado con la misma forma que deja validarComanda */
function renglonDeFila(f) {
  return {
    tipo: f.tipo, nombre: f.nombre, cantidad: f.cantidad, precio_centavos: aCentavos(f.precio_unitario),
    producto_id: f.producto_id, tamano_catalogo: f.tamano_catalogo, indicaciones: f.indicaciones,
    sabor: f.sabor, tamano: f.tamano, forma: f.forma, num_pisos: f.num_pisos, decoracion: f.decoracion,
    color_fondo: f.color_fondo, leyenda: f.leyenda, descripcion: f.descripcion, insumos: f.insumos,
  };
}

/** Comanda guardada (cabecera, renglones e imágenes) con la forma de validarComanda */
function comandaDeFilas(cabecera, renglones, imagenes) {
  return {
    cliente_nombre: cabecera.cliente_nombre,
    cliente_telefono: cabecera.cliente_telefono,
    fecha_entrega: cabecera.fecha_entrega,
    hora_entrega: cabecera.hora_entrega,
    notas: cabecera.notas,
    mesa_color_capacillos: cabecera.mesa_color_capacillos,
    mesa_color_betun: cabecera.mesa_color_betun,
    mesa_color_grageas: cabecera.mesa_color_grageas,
    descuento_centavos: aCentavos(cabecera.descuento),
    anticipo_centavos: aCentavos(cabecera.anticipo),
    items: renglones.map(renglonDeFila),
    imagenes: imagenes.map((im) => ({ url: im.url, public_id: im.public_id })),
  };
}

// ══════════════════════════════════════
// VALIDACIÓN DE LA COMANDA (§4.5)
// ══════════════════════════════════════

/**
 * Texto libre: recorta, une los saltos de línea en "\n" y rechaza
 * caracteres de control salvo tabulador y salto de línea. Vacío → null.
 * Con min > 0 es obligatorio. Si no es válido deja el error en la lista
 * y devuelve undefined.
 */
function texto(valor, campo, max, errores, { min = 0, unaLinea = false } = {}) {
  if (valor !== undefined && valor !== null && typeof valor !== 'string') {
    errores.push(`${campo}: no es un texto válido`);
    return undefined;
  }
  const limpio = (valor ?? '').replace(/\r\n?/g, '\n').normalize('NFC').trim();
  if (limpio === '' && min === 0) return null;
  const sinSaltos = unaLinea ? limpio : limpio.replace(/[\t\n]/g, '');
  if (CONTROL.test(sinSaltos)) {
    errores.push(`${campo}: contiene caracteres no permitidos`);
    return undefined;
  }
  if (limpio.length < min || limpio.length > max) {
    errores.push(min > 0 ? `${campo}: escribe de ${min} a ${max} caracteres` : `${campo}: máximo ${max} caracteres`);
    return undefined;
  }
  return limpio;
}

/** Quita espacios, guiones, puntos y paréntesis; deben quedar 10 dígitos */
function telefono(valor) {
  if (typeof valor !== 'string' && typeof valor !== 'number') return null;
  const digitos = String(valor).replace(/[\s\-.()]/g, '');
  return /^\d{10}$/.test(digitos) ? digitos : null;
}

/**
 * Clave de un nombre de opción para compararlo sin distinguir mayúsculas
 * (§4.3 y §4.5), también Ñ y vocales acentuadas. Se pliega aquí y no con
 * LOWER() de PostgreSQL, que depende del locale de la base: con 'C' deja
 * 'PEQUEÑO' como 'pequeÑo'. Captura y alta de opciones usan esta misma clave.
 */
const claveOpcion = (nombre) => nombre.normalize('NFC').toLowerCase();

/** Opciones activas por tipo: clave (claveOpcion) → texto canónico */
async function opcionesActivas(db) {
  const { rows } = await db.query('SELECT tipo, nombre FROM core.tblcomanda_opciones WHERE activo');
  const porTipo = new Map(TIPOS_OPCION.map((t) => [t, new Map()]));
  for (const o of rows) porTipo.get(o.tipo).set(claveOpcion(o.nombre), o.nombre);
  return porTipo;
}

/** Productos del catálogo que piden los renglones (estén o no disponibles) */
async function productosPedidos(db, entrada) {
  const ids = [...new Set(entrada
    .filter((r) => esObjeto(r) && r.tipo === 'producto')
    .map((r) => aNumero(r.producto_id))
    .filter(esId))];
  if (ids.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT p.id, p.nombre, p.precio_chico, p.precio_grande, (p.activo AND c.activo) AS disponible
     FROM core.tblproductos p JOIN core.tblcategorias c ON c.id = p.categoria_id
     WHERE p.id = ANY($1::int[])`,
    [ids]
  );
  return new Map(rows.map((p) => [p.id, p]));
}

/**
 * Texto canónico de una opción activa (sin distinguir mayúsculas). Al
 * editar, el renglón puede conservar el valor que ya tenía aunque la
 * opción se haya desactivado o renombrado: la comanda guarda el texto.
 */
function elegirOpcion(valor, activas, previo, campo, errores) {
  const escrito = typeof valor === 'string' ? valor.normalize('NFC').trim() : '';
  if (!escrito) {
    errores.push(`${campo}: elige una opción`);
    return null;
  }
  const clave = claveOpcion(escrito);
  if (previo && claveOpcion(previo) === clave) return previo;
  const canonica = activas.get(clave);
  if (!canonica) errores.push(`${campo}: "${recortar(escrito, 40)}" no está entre las opciones activas`);
  return canonica ?? null;
}

function validarPastel(r, etiqueta, previo, opciones, errores) {
  const cantidad = aNumero(r.cantidad);
  if (!esEntero(cantidad, 1, 20)) errores.push(`${etiqueta} · Cantidad: debe ser un entero de 1 a 20`);
  const sabor = elegirOpcion(r.sabor, opciones.get('sabor'), previo?.sabor, `${etiqueta} · Sabor`, errores);
  const tamano = elegirOpcion(r.tamano, opciones.get('tamano'), previo?.tamano, `${etiqueta} · Tamaño`, errores);
  const forma = elegirOpcion(r.forma, opciones.get('forma'), previo?.forma, `${etiqueta} · Forma`, errores);
  const decoracion = elegirOpcion(r.decoracion, opciones.get('decoracion'), previo?.decoracion, `${etiqueta} · Decoración`, errores);
  const num_pisos = aNumero(r.num_pisos);
  if (!esEntero(num_pisos, 1, 6)) errores.push(`${etiqueta} · Pisos: debe ser un entero de 1 a 6`);
  const color_fondo = texto(r.color_fondo, `${etiqueta} · Pared o fondo`, 120, errores);
  const leyenda = texto(r.leyenda, `${etiqueta} · Leyenda`, 200, errores);
  const descripcion = texto(r.descripcion, `${etiqueta} · Descripción`, 2000, errores);
  const insumos = texto(r.insumos, `${etiqueta} · Insumos`, 500, errores);
  // El pastel es a la medida: su precio lo captura quien toma el pedido
  const precio = aNumero(r.precio_unitario);
  if (!(precio >= 0 && precio <= 100000)) errores.push(`${etiqueta} · Precio: debe estar entre $0.00 y $100,000.00`);
  return {
    tipo: 'pastel', nombre: `Pastel ${sabor}`, cantidad, precio_centavos: aCentavos(precio),
    producto_id: null, tamano_catalogo: null, indicaciones: null,
    sabor, tamano, forma, num_pisos, decoracion, color_fondo, leyenda, descripcion, insumos,
  };
}

function validarProducto(r, posicion, previo, anteriores, productos, errores) {
  const id = aNumero(r.producto_id);
  const producto = productos.get(id);
  if (!producto) {
    errores.push(esId(id)
      ? `Renglón ${posicion}: el producto ya no existe en el catálogo`
      : `Renglón ${posicion}: elige un producto del catálogo`);
    return null;
  }
  const etiqueta = producto.nombre;
  const esMismo = (x) => x?.tipo === 'producto' && x.producto_id === producto.id;
  // Al editar se puede conservar un producto que ya estaba aunque se haya desactivado
  if (!producto.disponible && !anteriores.some(esMismo)) errores.push(`${etiqueta}: ya no está disponible en el catálogo`);
  const tamano_catalogo = r.tamano_catalogo;
  if (tamano_catalogo !== 'chico' && tamano_catalogo !== 'grande') {
    errores.push(`${etiqueta} · Tamaño: elige chico o grande`);
  } else if (tamano_catalogo === 'grande' && producto.precio_grande === null) {
    errores.push(`${etiqueta} · Tamaño: este producto no se vende en tamaño grande`);
  }
  const cantidad = aNumero(r.cantidad);
  if (!esEntero(cantidad, 1, 999)) errores.push(`${etiqueta} · Cantidad: debe ser un entero de 1 a 999`);
  const indicaciones = texto(r.indicaciones, `${etiqueta} · Indicaciones`, 500, errores);
  // El nombre es la foto de cuando se capturó: si el producto ya estaba en la
  // comanda se conserva el guardado, así un cambio de nombre en el catálogo no
  // se lee como un cambio de producción que obligue a volver a confirmar
  const nombre = (esMismo(previo) ? previo : anteriores.find(esMismo))?.nombre ?? producto.nombre;
  return {
    tipo: 'producto', nombre, cantidad,
    // El precio lo pone el servidor, del catálogo según el tamaño; nunca el cliente
    precio_centavos: aCentavos(tamano_catalogo === 'grande' ? producto.precio_grande : producto.precio_chico),
    producto_id: producto.id, tamano_catalogo, indicaciones,
    sabor: null, tamano: null, forma: null, num_pisos: null, decoracion: null,
    color_fondo: null, leyenda: null, descripcion: null, insumos: null,
  };
}

/** Renglones normalizados, o null si alguno no es válido (los errores ya quedaron en la lista) */
async function validarRenglones(db, entrada, anteriores, errores) {
  if (!Array.isArray(entrada) || entrada.length === 0) {
    errores.push('Agrega al menos un producto a la comanda');
    return null;
  }
  if (entrada.length > 30) {
    errores.push('La comanda admite como máximo 30 renglones');
    return null;
  }
  const erroresPrevios = errores.length;
  const opciones = entrada.some((r) => esObjeto(r) && r.tipo === 'pastel') ? await opcionesActivas(db) : new Map();
  const productos = await productosPedidos(db, entrada);
  let pasteles = 0;
  const renglones = entrada.map((r, i) => {
    // Los renglones se emparejan por posición con los que ya tenía la comanda
    const previo = anteriores.at(i);
    if (esObjeto(r) && r.tipo === 'pastel') {
      pasteles += 1;
      return validarPastel(r, `Pastel ${pasteles}`, previo?.tipo === 'pastel' ? previo : null, opciones, errores);
    }
    if (esObjeto(r) && r.tipo === 'producto') return validarProducto(r, i + 1, previo, anteriores, productos, errores);
    errores.push(`Renglón ${i + 1}: indica si es un pastel o un producto del catálogo`);
    return null;
  });
  return errores.length === erroresPrevios ? renglones : null;
}

/**
 * Solo URLs de la cuenta de Cloudinary de Pier y en forma canónica, como las
 * devuelve la subida (secure_url): así lo que se valida es exactamente lo que
 * se guarda. "../", "./", "%2e%2e" o "\" se rechazan aunque al resolverse la
 * URL quede dentro de la cuenta (el navegador las resuelve, otros clientes no).
 */
function esUrlDeComandas(url) {
  if (!PREFIJO_URL_IMAGEN || !url.startsWith(PREFIJO_URL_IMAGEN) || url.length > 500 || /\s/.test(url) || CONTROL.test(url)) {
    return false;
  }
  try {
    return new URL(url).href === url;
  } catch {
    return false;
  }
}

/**
 * public_id dentro de la carpeta de comandas, como lo devuelve la subida
 * (Cloudinary lo genera: 'pier-reposteria/comandas/<id>'). Con el mismo
 * criterio que la URL, el prefijo no basta: 'pier-reposteria/comandas/../x'
 * empieza igual pero sale de la carpeta. Se rechazan segmentos vacíos, "." o
 * "..", la "\" (el navegador la lee como "/") y el "%" ("%2e%2e" es ".."
 * codificado); Cloudinary no admite "\" ni "%" en un public_id.
 */
function esPublicIdDeComandas(publicId) {
  if (!publicId.startsWith(PREFIJO_PUBLIC_ID) || publicId.length > 255 || /[\s\\%]/.test(publicId) || CONTROL.test(publicId)) {
    return false;
  }
  return publicId.slice(PREFIJO_PUBLIC_ID.length).split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function validarImagenes(entrada, errores) {
  const lista = entrada === undefined || entrada === null ? [] : entrada;
  if (!Array.isArray(lista)) {
    errores.push('Imágenes: formato no válido');
    return [];
  }
  if (lista.length > 10) {
    errores.push('Imágenes: máximo 10 por comanda');
    return [];
  }
  return lista.map((im, i) => {
    const url = esObjeto(im) && typeof im.url === 'string' ? im.url.trim() : '';
    const public_id = esObjeto(im) && typeof im.public_id === 'string' ? im.public_id.trim() : '';
    if (!esUrlDeComandas(url) || !esPublicIdDeComandas(public_id)) errores.push(`Imagen ${i + 1}: no es una imagen subida desde comandas`);
    return { url, public_id };
  });
}

/**
 * Valida y normaliza una ComandaEntrada. `actual` es la comanda guardada
 * (al editar) o null (alta): permite conservar una fecha ya pasada si no
 * cambió, opciones desactivadas que el renglón ya tenía y productos que ya
 * estaban aunque se hayan desactivado.
 *
 * @returns {{ errores: string[], comanda: object|null, dias_restantes: number }}
 */
async function validarComanda(db, entrada, { hoy, ajustes, actual }) {
  const errores = [];
  const e = esObjeto(entrada) ? entrada : {};

  const cliente_nombre = texto(e.cliente_nombre, 'Nombre del cliente', 120, errores, { min: 2 });
  const cliente_telefono = telefono(e.cliente_telefono);
  if (!cliente_telefono) errores.push('Teléfono: deben ser exactamente 10 dígitos');

  const fecha_entrega = typeof e.fecha_entrega === 'string' ? e.fecha_entrega.trim() : '';
  let dias_restantes = 0;
  if (esFechaValida(fecha_entrega)) {
    dias_restantes = diasEntre(hoy, fecha_entrega);
    const conservada = actual !== null && actual.fecha_entrega === fecha_entrega;
    if (dias_restantes < 0 && !conservada) errores.push('Fecha de entrega: no puede ser anterior a hoy');
    if (dias_restantes > 400) errores.push('Fecha de entrega: no puede ser a más de 400 días');
  } else {
    errores.push('Fecha de entrega: no es una fecha válida');
  }

  const hora_entrega = typeof e.hora_entrega === 'string' ? e.hora_entrega.trim() : '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora_entrega)) errores.push('Hora de entrega: usa el formato HH:MM (de 00:00 a 23:59)');

  const notas = texto(e.notas, 'Notas', 1000, errores);
  const mesa_color_capacillos = texto(e.mesa_color_capacillos, 'Capacillos (mesa de postres)', 80, errores);
  const mesa_color_betun = texto(e.mesa_color_betun, 'Betún (mesa de postres)', 80, errores);
  const mesa_color_grageas = texto(e.mesa_color_grageas, 'Grageas (mesa de postres)', 80, errores);

  const renglones = await validarRenglones(db, e.items, actual ? actual.items : [], errores);

  const descuentoEntrada = e.descuento === undefined || e.descuento === null || e.descuento === '' ? 0 : aNumero(e.descuento);
  const anticipoEntrada = aNumero(e.anticipo);
  if (!(descuentoEntrada >= 0)) errores.push('Descuento: debe ser un monto de $0.00 o más');
  if (!(anticipoEntrada >= 0)) errores.push('Anticipo: indica el monto del anticipo ($0.00 o más)');
  let subtotal = 0;
  let total = 0;
  const descuento = aCentavos(descuentoEntrada);
  const anticipo = aCentavos(anticipoEntrada);
  // Los topes de cobro solo tienen sentido si todos los renglones tienen precio válido
  if (renglones && descuentoEntrada >= 0 && anticipoEntrada >= 0) {
    subtotal = renglones.reduce((suma, r) => suma + r.cantidad * r.precio_centavos, 0);
    if (subtotal > MAX_CENTAVOS) {
      errores.push(`El subtotal supera el máximo permitido (${moneda(MAX_CENTAVOS)})`);
    } else if (descuento > subtotal) {
      errores.push(`Descuento: no puede ser mayor que el subtotal (${moneda(subtotal)})`);
    } else {
      total = subtotal - descuento;
      const minimo = Math.ceil((total * ajustes.anticipo_minimo_pct) / 100);
      if (anticipo < minimo) {
        errores.push(`El anticipo mínimo es ${moneda(minimo)} (${ajustes.anticipo_minimo_pct} % del total)`);
      } else if (anticipo > total) {
        errores.push(`Anticipo: no puede ser mayor que el total (${moneda(total)})`);
      }
    }
  }

  const imagenes = validarImagenes(e.imagenes, errores);

  if (errores.length > 0) return { errores, comanda: null, dias_restantes };
  return {
    errores,
    dias_restantes,
    comanda: {
      cliente_nombre, cliente_telefono, fecha_entrega, hora_entrega, notas,
      mesa_color_capacillos, mesa_color_betun, mesa_color_grageas,
      items: renglones, imagenes,
      subtotal_centavos: subtotal, descuento_centavos: descuento, total_centavos: total, anticipo_centavos: anticipo,
    },
  };
}

// ══════════════════════════════════════
// SNAPSHOT DE PRODUCCIÓN Y DIFF (§4.6)
// ══════════════════════════════════════

/**
 * Lo que hornos y decoración necesitan saber. Excluye precios, cliente y
 * teléfono: si solo cambia eso, la versión no sube y nadie vuelve a firmar.
 */
function snapshotProduccion(c) {
  return {
    fecha_entrega: c.fecha_entrega,
    hora_entrega: c.hora_entrega,
    notas: c.notas,
    mesa_color_capacillos: c.mesa_color_capacillos,
    mesa_color_betun: c.mesa_color_betun,
    mesa_color_grageas: c.mesa_color_grageas,
    items: c.items.map((r) => (r.tipo === 'pastel'
      ? {
        tipo: r.tipo, nombre: r.nombre, cantidad: r.cantidad, sabor: r.sabor, tamano: r.tamano, forma: r.forma,
        num_pisos: r.num_pisos, decoracion: r.decoracion, color_fondo: r.color_fondo, leyenda: r.leyenda,
        descripcion: r.descripcion, insumos: r.insumos,
      }
      : {
        tipo: r.tipo, nombre: r.nombre, cantidad: r.cantidad, producto_id: r.producto_id,
        tamano_catalogo: r.tamano_catalogo, indicaciones: r.indicaciones,
      })),
    imagenes: c.imagenes.map((im) => im.url),
  };
}

const CAMPOS_GENERALES = [
  ['Fecha de entrega', (s) => fechaCorta(s.fecha_entrega)],
  ['Hora de entrega', (s) => s.hora_entrega],
  ['Notas', (s) => s.notas],
  ['Capacillos (mesa de postres)', (s) => s.mesa_color_capacillos],
  ['Betún (mesa de postres)', (s) => s.mesa_color_betun],
  ['Grageas (mesa de postres)', (s) => s.mesa_color_grageas],
];
const CAMPOS_PASTEL = [
  ['Sabor', (r) => r.sabor],
  ['Tamaño', (r) => r.tamano],
  ['Forma', (r) => r.forma],
  ['Pisos', (r) => r.num_pisos],
  ['Decoración', (r) => r.decoracion],
  ['Pared o fondo', (r) => r.color_fondo],
  ['Leyenda', (r) => r.leyenda],
  ['Descripción', (r) => r.descripcion],
  ['Insumos', (r) => r.insumos],
  ['Cantidad', (r) => r.cantidad],
];
const CAMPOS_PRODUCTO = [
  ['Cantidad', (r) => r.cantidad],
  ['Tamaño', (r) => r.tamano_catalogo],
  ['Indicaciones', (r) => r.indicaciones],
];
const CAMPOS_CLIENTE = [
  ['Cliente', (c) => c.cliente_nombre],
  ['Teléfono', (c) => c.cliente_telefono],
];
const CAMPOS_COBRO = [
  ['Descuento', (c) => moneda(c.descuento_centavos)],
  ['Anticipo', (c) => moneda(c.anticipo_centavos)],
];
/** 'Precio de Pastel 1', 'Precio de Tart Bites': el precio de un renglón cambió */
const PREFIJO_PRECIO = 'Precio de ';
/** Lo que se cobró al entregar (evento 'entregada' del historial) */
const CAMPO_SALDO_COBRADO = 'Saldo cobrado';

const comoTexto = (v) => (v === null || v === undefined ? null : String(v));

function compararCampos(cambios, campos, antes, despues, prefijo) {
  for (const [etiqueta, leer] of campos) {
    const a = comoTexto(leer(antes));
    const d = comoTexto(leer(despues));
    if (a !== d) cambios.push({ campo: prefijo ? `${prefijo} · ${etiqueta}` : etiqueta, antes: a, despues: d });
  }
}

/** El mismo renglón en la misma posición: mismo tipo y, si es producto, el mismo producto */
const mismoRenglon = (a, b) => a.tipo === b.tipo && (a.tipo === 'pastel' || a.producto_id === b.producto_id);

/** 'Pastel 1', 'Pastel 2'… o el nombre del producto, como se lee en la comanda */
function etiquetasRenglones(items) {
  let pasteles = 0;
  return items.map((r) => {
    if (r.tipo !== 'pastel') return r.nombre;
    pasteles += 1;
    return `Pastel ${pasteles}`;
  });
}

/** Qué cambió para producción entre dos snapshots (CambioCampo[]) */
function diffProduccion(antes, despues) {
  const cambios = [];
  compararCampos(cambios, CAMPOS_GENERALES, antes, despues, null);
  const etiquetas = etiquetasRenglones(despues.items);
  const largo = Math.max(antes.items.length, despues.items.length);
  for (let i = 0; i < largo; i += 1) {
    const a = antes.items.at(i);
    const d = despues.items.at(i);
    if (a && d && mismoRenglon(a, d)) {
      compararCampos(cambios, a.tipo === 'pastel' ? CAMPOS_PASTEL : CAMPOS_PRODUCTO, a, d, etiquetas.at(i));
    } else {
      // Otro tipo u otro producto en la misma posición: se quitó uno y se agregó otro
      if (a) cambios.push({ campo: 'Se quitó', antes: describirRenglon(a), despues: null });
      if (d) cambios.push({ campo: 'Se agregó', antes: null, despues: describirRenglon(d) });
    }
  }
  if (JSON.stringify(antes.imagenes) !== JSON.stringify(despues.imagenes)) {
    const n = despues.imagenes.length;
    cambios.push({
      campo: 'Imágenes de referencia',
      antes: String(antes.imagenes.length),
      // Mismo número de imágenes pero otras (u otro orden): que no parezca "2 → 2" sin cambio
      despues: n === antes.imagenes.length ? `${n} (se cambiaron)` : String(n),
    });
  }
  return cambios;
}

/** Cambios que no suben la versión: cliente, teléfono, precios, descuento y anticipo */
function diffAdministrativo(antes, despues) {
  const cambios = [];
  compararCampos(cambios, CAMPOS_CLIENTE, antes, despues, null);
  const etiquetas = etiquetasRenglones(despues.items);
  despues.items.forEach((d, i) => {
    const a = antes.items.at(i);
    if (a && mismoRenglon(a, d) && a.precio_centavos !== d.precio_centavos) {
      cambios.push({ campo: `${PREFIJO_PRECIO}${etiquetas.at(i)}`, antes: moneda(a.precio_centavos), despues: moneda(d.precio_centavos) });
    }
  });
  compararCampos(cambios, CAMPOS_COBRO, antes, despues, null);
  return cambios;
}

/** 'Pastel 1 · Sabor: Tres leches → Zanahoria', recortado para el aviso */
function textoCambio({ campo, antes, despues }) {
  if (campo === 'Se agregó' && antes === null) return `Se agregó: ${recortar(despues, 60)}`;
  if (campo === 'Se quitó' && despues === null) return `Se quitó: ${recortar(antes, 60)}`;
  return `${campo}: ${recortar(antes ?? '—', 60)} → ${recortar(despues ?? '—', 60)}`;
}

// ══════════════════════════════════════
// DINERO: SOLO PARA QUIEN COBRA
// ══════════════════════════════════════

/**
 * Hornos y decoración reciben todo lo escrito que necesitan para producir y
 * ningún monto (decisión del dueño). Va por lista de quien SÍ ve el dinero:
 * un rol que se agregue después al módulo no lo verá hasta sumarlo aquí.
 */
const VEN_DINERO = ['empleado', 'gerencia', 'direccion_general'];

/** Montos del resumen de la agenda, del detalle y de cada renglón */
const CAMPOS_MONTO = ['subtotal', 'descuento', 'total', 'anticipo', 'saldo', 'saldo_cobrado', 'precio_unitario'];

/**
 * Etiquetas fijas de los cambios de dinero: descuento y anticipo
 * (CAMPOS_COBRO) y el saldo cobrado al entregar. El frontend repite la
 * misma lista en esCambioDeDinero (src/comandas/componentes/presentacion.ts).
 */
const CAMPOS_DINERO = [...CAMPOS_COBRO.map(([etiqueta]) => etiqueta), CAMPO_SALDO_COBRADO];

/** Descuento, anticipo, saldo cobrado o el precio de un renglón */
const esCambioDeDinero = ({ campo }) => CAMPOS_DINERO.includes(campo) || campo.startsWith(PREFIJO_PRECIO);

/** El mismo objeto con cada monto en null: la respuesta conserva su forma */
const montosEnNull = (objeto) => Object.fromEntries(
  Object.entries(objeto).map(([campo, valor]) => [campo, CAMPOS_MONTO.includes(campo) ? null : valor])
);

/**
 * Historial (del más reciente al más antiguo) sin cambios de dinero. La
 * edición que solo cambió dinero no subió la versión ni toca a producción:
 * se quita completa en lugar de dejar un "Se modificó" vacío.
 */
function historialSinDinero(historial) {
  return historial.flatMap((evento, i) => {
    const anterior = historial.at(i + 1);
    const subioVersion = anterior !== undefined && evento.version > anterior.version;
    const cambios = evento.cambios.filter((c) => !esCambioDeDinero(c));
    const soloDinero = evento.evento === 'modificada' && !subioVersion && evento.cambios.length > 0 && cambios.length === 0;
    return soloDinero ? [] : [{ ...evento, cambios }];
  });
}

/**
 * La regla única de qué dinero ve cada rol, para el resumen de la agenda y
 * el detalle. Quien cobra recibe la comanda tal cual; hornos y decoración,
 * la misma forma con cada monto en null (también en los renglones) y sin
 * cambios de dinero en el historial ni en los cambios pendientes.
 */
function ocultarDinero(rol, comanda) {
  if (VEN_DINERO.includes(rol)) return comanda;
  const oculta = montosEnNull(comanda);
  if (Array.isArray(comanda.items)) oculta.items = comanda.items.map(montosEnNull);
  if (Array.isArray(comanda.historial)) oculta.historial = historialSinDinero(comanda.historial);
  if (Array.isArray(comanda.cambios_pendientes)) {
    oculta.cambios_pendientes = comanda.cambios_pendientes.filter((c) => !esCambioDeDinero(c));
  }
  return oculta;
}

module.exports = {
  TIPOS_OPCION,
  TIPO_LEGIBLE,
  AREA_LEGIBLE,
  esId,
  aNumero,
  aCentavos,
  moneda,
  decimal,
  fechaLarga,
  horaLegible,
  recortar,
  normalizarAjustes,
  validarAjustes,
  semaforo,
  resumenRenglones,
  comandaDeFilas,
  texto,
  claveOpcion,
  validarComanda,
  snapshotProduccion,
  diffProduccion,
  diffAdministrativo,
  textoCambio,
  CAMPO_SALDO_COBRADO,
  ocultarDinero,
};
