// utils/contenidoSitio.js — Catálogo y reglas del Editor del sitio
//
// Lo que Dirección general cambia del sitio público desde el Editor del
// sitio (/direccion/sitio): textos, fotos, equipo, preguntas y datos de
// contacto (Diseno_Editor_Sitio.md §1 y §2). Cada bloque es una fila de
// core.tblconfiguracion_sistema y se nombra "<seccion>.<clave>"; aquí están
// su página, su etiqueta y su esquema, la validación campo por campo y la
// lectura de lo ya guardado (entidades del sanitizador global y la galería
// del local que nunca se pudo leer). Los textos se guardan tal cual: React
// escapa al pintar. Todo es puro: se prueba sin base de datos.
const validator = require('validator');

// ══════════════════════════════════════
// LISTAS CERRADAS (las mismas en el frontend, src/sitio/)
// ══════════════════════════════════════

/**
 * Fotos que ya vienen con el sitio: exactamente los archivos de
 * Fronted-Pier/src/publico/assets/imgStatic/productos/, guardadas como
 * "local:<archivo>". Si se agrega o quita una foto allá, se cambia aquí y en
 * src/sitio/imagenesLocales.ts.
 */
const IMAGENES_LOCALES = Object.freeze([
  'local:producto1-tarjeta.webp', 'local:producto1.jpg', 'local:producto1.webp',
  'local:producto2-tarjeta.webp', 'local:producto2.jpg', 'local:producto2.webp',
  'local:producto3-tarjeta.webp', 'local:producto3.jpg', 'local:producto3.webp',
  'local:producto4-tarjeta.webp', 'local:producto4.jpg', 'local:producto4.webp',
  'local:producto5-tarjeta.webp', 'local:producto5.jpg', 'local:producto5.webp',
  'local:producto6-tarjeta.webp', 'local:producto6.jpg',
]);
const PREFIJO_LOCAL = 'local:';

/** Íconos de lucide-react de "¿Por qué elegirnos?" (nombre del componente): los 4 de hoy y 6 más */
const ICONOS = Object.freeze(['Award', 'Clock', 'Heart', 'Star', 'Sparkles', 'CakeSlice', 'Truck', 'Leaf', 'ShieldCheck', 'Gift']);

/**
 * Juegos de colores de las tarjetas de "Nuestros favoritos" (fondo / texto /
 * acento de hoy): ambar #fffbeb/#92400e/#b45309 (Pays), rosa
 * #fff1f2/#9f1239/#be123c (Panques y Roscas), violeta #f5f3ff/#5b21b6/#7c3aed
 * (Postres Cuchareables), turquesa #f0fdfa/#115e59/#0f766e (Cafetería),
 * caramelo #fef3c7/#78350f/#b45309 (Pasteles Especiales) y vainilla
 * #fefce8/#713f12/#a16207 (Cheesecakes).
 */
const ESTILOS = Object.freeze(['ambar', 'rosa', 'violeta', 'turquesa', 'caramelo', 'vainilla']);

// ══════════════════════════════════════
// LÍMITES
// ══════════════════════════════════════

const MAX_BLOQUES = 30; // por publicación
const MAX_ERRORES = 100; // los que se devuelven en un 400
const MAX_ENLACE = 80;
const MAX_MAPA = 1000;
const MAX_URL_IMAGEN = 500;
const MAX_URL_RED = 300;
const MAX_CORREO = 120;
const ANIO_MIN = 1900;
const ANIO_MAX = 2100;

const CONTROL = /\p{Cc}/u;
// Medio emoji (sustituto UTF-16 sin pareja): jsonb rechazaría la fila entera
const SUSTITUTO_SUELTO = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// Ruta interna del sitio; "//algo" se rechaza aparte: React Router lo trata como enlace externo
const RE_ENLACE = /^\/[a-z0-9/_-]*$/;
const RE_MAPA = /^https:\/\/www\.google\.com\/maps\/embed\?/;
// Lo que nunca va en una URL que se pinta en src o href
const RARO_EN_URL = /[\s"'<>\\`]/;

// ══════════════════════════════════════
// BÁSICOS
// ══════════════════════════════════════

const esObjeto = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const ausente = (v) => v === undefined || v === null;
/** Caracteres como los cuenta PostgreSQL (un emoji es uno, no dos unidades UTF-16) */
const largo = (s) => Array.from(s).length;
/** Texto recortado; '' si no es texto */
const recortado = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Foto subida desde el editor: de la cuenta de Cloudinary configurada, en
 * forma canónica y sin "..", "%2e", "\" ni espacios (mismo criterio que el
 * feed y comandas). Se lee el entorno en cada llamada: dotenv ya corrió.
 */
function esUrlDeCloudinary(url) {
  const nube = process.env.CLOUDINARY_CLOUD_NAME;
  const prefijo = nube ? `https://res.cloudinary.com/${nube}/image/upload/` : null;
  if (!prefijo || typeof url !== 'string' || !url.startsWith(prefijo) || url.length > MAX_URL_IMAGEN
    || RARO_EN_URL.test(url) || CONTROL.test(url) || url.includes('..') || /%2e/i.test(url)) {
    return false;
  }
  try {
    return new URL(url).href === url;
  } catch {
    return false;
  }
}

/** JSON con las llaves en orden: jsonb no conserva el orden en que llegaron */
const jsonOrdenado = (valor) => JSON.stringify(valor, (_clave, v) => (esObjeto(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
  : v));

// ══════════════════════════════════════
// TIPOS DE CAMPO
// ══════════════════════════════════════
// Cada limpiador recibe la definición del campo y lo que llegó, y devuelve
// { valor } ya limpio o { error } con el problema en español. Los campos
// opcionales aceptan ausente, null o cadena vacía y se guardan como ''.

const OPCIONAL = { opcional: true };
const VACIO_OBLIGATORIO = { error: 'es obligatorio' };

const LIMPIADORES = {
  texto(def, valor) {
    if (ausente(valor) || valor === '') return def.opcional ? { valor: '' } : VACIO_OBLIGATORIO;
    if (typeof valor !== 'string' && !Number.isFinite(valor)) return { error: 'debe ser texto' };
    const limpio = String(valor).replace(/\r\n?/g, '\n').normalize('NFC').trim();
    if (limpio === '') return def.opcional ? { valor: '' } : VACIO_OBLIGATORIO;
    if (CONTROL.test(limpio.replace(/[\t\n]/g, '')) || SUSTITUTO_SUELTO.test(limpio)) {
      return { error: 'tiene caracteres no permitidos' };
    }
    const n = largo(limpio);
    return n > def.max ? { error: `máximo ${def.max} caracteres (tiene ${n})` } : { valor: limpio };
  },

  entero(def, valor) {
    const n = typeof valor === 'string' && /^\s*\d+\s*$/.test(valor) ? Number(valor) : valor;
    return Number.isInteger(n) && n >= def.min && n <= def.max
      ? { valor: n }
      : { error: def.mensaje ?? `debe ser un número entero de ${def.min} a ${def.max}` };
  },

  booleano(_def, valor) {
    return typeof valor === 'boolean' ? { valor } : { error: 'debe ser sí o no' };
  },

  imagen(def, valor) {
    const v = recortado(valor);
    if (v === '') return def.opcional && (ausente(valor) || typeof valor === 'string') ? { valor: '' } : { error: 'elige una foto' };
    if (v.startsWith(PREFIJO_LOCAL)) {
      return IMAGENES_LOCALES.includes(v) ? { valor: v } : { error: 'esa foto no está entre las fotos del sitio' };
    }
    return esUrlDeCloudinary(v) ? { valor: v } : { error: 'usa una foto del sitio o una subida desde el editor' };
  },

  enlace(_def, valor) {
    const v = recortado(valor);
    if (v === '') return VACIO_OBLIGATORIO;
    return v.length <= MAX_ENLACE && RE_ENLACE.test(v) && !v.includes('//')
      ? { valor: v }
      : { error: 'usa una ruta del sitio que empiece con "/", por ejemplo /productos' };
  },

  mapa(def, valor) {
    const v = recortado(valor);
    if (v === '') return def.opcional && (ausente(valor) || typeof valor === 'string') ? { valor: '' } : VACIO_OBLIGATORIO;
    return v.length <= MAX_MAPA && RE_MAPA.test(v) && !RARO_EN_URL.test(v) && !CONTROL.test(v)
      ? { valor: v }
      : { error: 'pega el enlace para insertar de Google Maps (empieza con https://www.google.com/maps/embed?)' };
  },

  urlHttps(def, valor) {
    const v = recortado(valor);
    if (v === '') return def.opcional && (ausente(valor) || typeof valor === 'string') ? { valor: '' } : VACIO_OBLIGATORIO;
    let url = null;
    try {
      url = new URL(v);
    } catch {
      url = null;
    }
    return url && url.protocol === 'https:' && url.hostname.includes('.') && v.length <= MAX_URL_RED
      && !RARO_EN_URL.test(v) && !CONTROL.test(v)
      ? { valor: v }
      : { error: 'debe ser un enlace que empiece con https://' };
  },

  telefono(_def, valor) {
    // Se aceptan espacios, guiones, puntos y paréntesis; se guardan solo los dígitos
    const v = typeof valor === 'string' || Number.isInteger(valor) ? String(valor).replace(/[\s().-]/g, '') : '';
    return /^\d{10}$/.test(v) ? { valor: v } : { error: 'escribe 10 dígitos' };
  },

  correo(_def, valor) {
    const v = recortado(valor);
    return v.length <= MAX_CORREO && validator.isEmail(v) ? { valor: v } : { error: 'escribe un correo válido' };
  },

  opcion(def, valor) {
    return def.opciones.includes(valor) ? { valor } : { error: 'elige una opción de la lista' };
  },
};

// Constructores del esquema: la etiqueta es como Dirección conoce el campo
const texto = (etiqueta, max, opciones = {}) => ({ tipo: 'texto', etiqueta, max, ...opciones });
const entero = (etiqueta, min, max) => ({ tipo: 'entero', etiqueta, min, max });
const anio = (etiqueta) => ({ tipo: 'entero', etiqueta, min: ANIO_MIN, max: ANIO_MAX, mensaje: `escribe un año de 4 cifras entre ${ANIO_MIN} y ${ANIO_MAX}` });
const booleano = (etiqueta) => ({ tipo: 'booleano', etiqueta });
const imagen = (etiqueta, opciones = {}) => ({ tipo: 'imagen', etiqueta, ...opciones });
const enlace = (etiqueta) => ({ tipo: 'enlace', etiqueta });
const mapa = (etiqueta, opciones = {}) => ({ tipo: 'mapa', etiqueta, ...opciones });
const urlHttps = (etiqueta, opciones = {}) => ({ tipo: 'urlHttps', etiqueta, ...opciones });
const telefono = (etiqueta) => ({ tipo: 'telefono', etiqueta });
const correo = (etiqueta) => ({ tipo: 'correo', etiqueta });
const opcion = (etiqueta, opciones) => ({ tipo: 'opcion', etiqueta, opciones });
const objeto = (etiqueta, campos) => ({ tipo: 'objeto', etiqueta, campos });
const lista = (etiqueta, min, max, elemento) => ({ tipo: 'lista', etiqueta, min, max, elemento });
/** Botón de los llamados finales: { texto (30), enlace } */
const boton = (nombre) => objeto(`Botón ${nombre}`, {
  texto: texto(`Texto del botón ${nombre}`, 30),
  enlace: enlace(`Enlace del botón ${nombre}`),
});
/** Llamado final de Inicio y de Nosotros (misma forma) */
const llamado = () => objeto('Llamado final', {
  titulo: texto('Título', 80),
  texto: texto('Texto', 200),
  boton_1: boton('1'),
  boton_2: boton('2'),
});

function rangoLista(def) {
  if (def.min === def.max) return `deben ser exactamente ${def.min}`;
  return def.min === 0 ? `máximo ${def.max}` : `agrega de ${def.min} a ${def.max}`;
}

/**
 * Valida `valor` contra su definición. Devuelve el valor limpio (solo los
 * campos del esquema: los desconocidos se descartan) o undefined si hubo
 * errores, que quedan en `errores` como { campo, mensaje }. `campo` es la
 * ruta separada por puntos con los índices de lista como números
 * ("tarjetas.2.titulo", "0.imagen"); '' es el bloque entero.
 */
function validarValor(def, valor, ruta, errores) {
  const fallo = (mensaje) => {
    errores.push({ campo: ruta.join('.'), mensaje: `${def.etiqueta}: ${mensaje}` });
    return undefined;
  };
  if (def.tipo === 'objeto') {
    if (!esObjeto(valor)) return fallo('formato no válido');
    const limpio = {};
    let completo = true;
    for (const [clave, sub] of Object.entries(def.campos)) {
      const v = validarValor(sub, Object.hasOwn(valor, clave) ? valor[clave] : undefined, [...ruta, clave], errores);
      if (v === undefined) completo = false;
      else limpio[clave] = v;
    }
    return completo ? limpio : undefined;
  }
  if (def.tipo === 'lista') {
    if (!Array.isArray(valor)) return fallo('formato no válido');
    if (valor.length < def.min || valor.length > def.max) return fallo(rangoLista(def));
    const limpia = valor.map((elemento, i) => validarValor(def.elemento, elemento, [...ruta, i], errores));
    return limpia.includes(undefined) ? undefined : limpia;
  }
  const resultado = LIMPIADORES[def.tipo](def, valor);
  return 'error' in resultado ? fallo(resultado.error) : resultado.valor;
}

// ══════════════════════════════════════
// CATÁLOGO DE BLOQUES (§1.1)
// ══════════════════════════════════════
// En los bloques que ya existían (la app lee /api/configuracion/{contacto,
// nosotros, faq, legales}) se conservan sección, clave y nombres de campo;
// solo se agregan campos opcionales.

const CATALOGO = [
  // ── Inicio (/) ──
  {
    id: 'inicio.carrusel', pagina: 'Inicio', etiqueta: 'Carrusel principal',
    esquema: lista('Diapositivas', 1, 8, objeto('Diapositiva', {
      imagen: imagen('Imagen'),
      titulo: texto('Título', 60),
      subtitulo: texto('Subtítulo', 120, OPCIONAL),
      boton_texto: texto('Texto del botón', 30),
      boton_enlace: enlace('Enlace del botón'),
    })),
  },
  {
    id: 'inicio.por_que', pagina: 'Inicio', etiqueta: '¿Por qué elegirnos?',
    esquema: objeto('¿Por qué elegirnos?', {
      titulo: texto('Título', 60),
      subtitulo: texto('Subtítulo', 200),
      tarjetas: lista('Tarjetas', 1, 6, objeto('Tarjeta', {
        icono: opcion('Ícono', ICONOS),
        titulo: texto('Título', 40),
        descripcion: texto('Descripción', 160),
      })),
    }),
  },
  {
    id: 'inicio.favoritos', pagina: 'Inicio', etiqueta: 'Nuestros favoritos',
    esquema: objeto('Nuestros favoritos', {
      titulo: texto('Título', 60),
      subtitulo: texto('Subtítulo', 200),
      tarjetas: lista('Tarjetas', 1, 8, objeto('Tarjeta', {
        imagen: imagen('Imagen'),
        titulo: texto('Título', 50),
        eslogan: texto('Eslogan', 60),
        descripcion: texto('Descripción', 240),
        precio_texto: texto('Precio', 30, OPCIONAL),
        estilo: opcion('Estilo de color', ESTILOS),
      })),
    }),
  },
  {
    id: 'inicio.promo', pagina: 'Inicio', etiqueta: 'Promoción',
    esquema: objeto('Promoción', {
      visible: booleano('Mostrar la promoción'),
      etiqueta: texto('Etiqueta', 40),
      titulo: texto('Título', 50),
      texto_1: texto('Primer texto', 80),
      texto_2: texto('Segundo texto', 80),
      boton_texto: texto('Texto del botón', 30),
      boton_enlace: enlace('Enlace del botón'),
    }),
  },
  {
    id: 'inicio.testimonios', pagina: 'Inicio', etiqueta: 'Testimonios',
    esquema: objeto('Testimonios', {
      titulo: texto('Título', 60),
      subtitulo: texto('Subtítulo', 200),
      cantidad: entero('Cantidad de reseñas', 1, 6),
      min_estrellas: entero('Estrellas mínimas', 1, 5),
    }),
  },
  { id: 'inicio.llamado', pagina: 'Inicio', etiqueta: 'Llamado final', esquema: llamado() },

  // ── Nosotros (/nosotros) ──
  {
    id: 'nosotros.historia', pagina: 'Nosotros', etiqueta: 'Historia',
    esquema: objeto('Historia', {
      titulo: texto('Título', 60),
      contenido: texto('Historia', 1500),
      fundacion: anio('Año de fundación'),
    }),
  },
  {
    id: 'nosotros.estadisticas', pagina: 'Nosotros', etiqueta: 'Estadísticas',
    esquema: lista('Estadísticas', 1, 6, objeto('Estadística', {
      numero: texto('Número', 12),
      label: texto('Descripción', 40),
    })),
  },
  { id: 'nosotros.mision', pagina: 'Nosotros', etiqueta: 'Misión', esquema: texto('Misión', 600) },
  {
    id: 'nosotros.mision_detalle', pagina: 'Nosotros', etiqueta: 'Título y foto de la misión',
    esquema: objeto('Título y foto de la misión', {
      titulo: texto('Título', 80),
      imagen: imagen('Foto'),
      leyenda_titulo: texto('Título de la leyenda', 40),
      leyenda_texto: texto('Texto de la leyenda', 60),
    }),
  },
  { id: 'nosotros.valores', pagina: 'Nosotros', etiqueta: 'Valores', esquema: lista('Valores', 1, 8, texto('Valor', 40)) },
  {
    id: 'nosotros.timeline', pagina: 'Nosotros', etiqueta: 'Nuestro recorrido',
    esquema: lista('Etapas', 1, 10, objeto('Etapa', {
      year: texto('Año', 10),
      title: texto('Título', 60),
      description: texto('Descripción', 300),
      image: imagen('Foto', OPCIONAL),
    })),
  },
  {
    id: 'nosotros.equipo', pagina: 'Nosotros', etiqueta: 'Equipo',
    esquema: lista('Personas', 0, 12, objeto('Persona', {
      name: texto('Nombre', 60),
      role: texto('Puesto', 60),
      description: texto('Descripción', 240),
      emoji: texto('Emoji', 8, OPCIONAL),
      photo: imagen('Foto', OPCIONAL),
    })),
  },
  { id: 'nosotros.cta', pagina: 'Nosotros', etiqueta: 'Llamado final', esquema: llamado() },

  // ── Nuestro local (/conocenos) ──
  {
    id: 'conocenos.galeria', pagina: 'Nuestro local', etiqueta: 'Galería en espiral',
    esquema: lista('Fotos', 0, 24, objeto('Foto', {
      imagen: imagen('Imagen'),
      alt: texto('Descripción de la foto', 120, OPCIONAL),
    })),
  },
  {
    id: 'conocenos.perspectivas', pagina: 'Nuestro local', etiqueta: 'Textos del recorrido',
    esquema: lista('Textos', 5, 5, objeto('Texto', {
      titulo: texto('Título', 40),
      descripcion: texto('Descripción', 140),
    })),
  },
  {
    id: 'conocenos.visita', pagina: 'Nuestro local', etiqueta: 'Visita nuestro local',
    esquema: objeto('Visita nuestro local', {
      titulo: texto('Título', 60),
      subtitulo: texto('Subtítulo', 120),
      nombre: texto('Nombre del local', 60),
      ciudad: texto('Ciudad', 60),
      descripcion: texto('Descripción', 300),
      horario: texto('Horario', 60),
      fondo: imagen('Foto de fondo', OPCIONAL),
    }),
  },

  // ── Preguntas frecuentes (/preguntas-frecuentes) ──
  {
    id: 'faq.preguntas', pagina: 'Preguntas frecuentes', etiqueta: 'Preguntas',
    esquema: lista('Preguntas', 1, 40, objeto('Pregunta', {
      categoria: texto('Categoría', 40),
      pregunta: texto('Pregunta', 200),
      respuesta: texto('Respuesta', 1500),
    })),
  },

  // ── Contacto (/contacto), sucursales de Inicio y pie ──
  { id: 'contacto.telefono', pagina: 'Contacto', etiqueta: 'Teléfono', esquema: telefono('Teléfono') },
  { id: 'contacto.whatsapp', pagina: 'Contacto', etiqueta: 'WhatsApp', esquema: telefono('WhatsApp') },
  { id: 'contacto.email', pagina: 'Contacto', etiqueta: 'Correo', esquema: correo('Correo') },
  {
    id: 'contacto.direccion', pagina: 'Contacto', etiqueta: 'Dirección',
    esquema: objeto('Dirección', {
      calle: texto('Calle y colonia', 100),
      ciudad: texto('Ciudad', 60),
    }),
  },
  {
    id: 'contacto.horarios', pagina: 'Contacto', etiqueta: 'Sucursales y horarios',
    esquema: lista('Sucursales', 1, 4, objeto('Sucursal', {
      sucursal: texto('Nombre de la sucursal', 60),
      horario: texto('Horario', 60),
      descripcion: texto('Descripción', 120, OPCIONAL),
      direccion: texto('Dirección', 100, OPCIONAL),
      mapa: mapa('Mapa', OPCIONAL),
    })),
    // La app sigue recibiendo `es_tarjeta` y `color` (§1: no se quitan campos).
    // Ya no se editan: se guardan como los pinta el sitio, las dos primeras
    // son tarjetas (la 1 arena, la 2 verde) y las demás solo van en el pie
    alGuardar: (sucursales) => sucursales.map((s, i) => ({ ...s, es_tarjeta: i < 2, color: i === 1 ? 'verde' : 'arena' })),
  },
  {
    id: 'contacto.redes_sociales', pagina: 'Contacto', etiqueta: 'Redes sociales',
    esquema: objeto('Redes sociales', {
      facebook: urlHttps('Facebook', OPCIONAL),
      instagram: urlHttps('Instagram', OPCIONAL),
    }),
  },

  // ── Legales (/legales) ──
  { id: 'legales.privacidad', pagina: 'Legales', etiqueta: 'Aviso de privacidad', esquema: texto('Aviso de privacidad', 20000) },
  { id: 'legales.terminos', pagina: 'Legales', etiqueta: 'Términos y condiciones', esquema: texto('Términos y condiciones', 20000) },
  { id: 'legales.reembolsos', pagina: 'Legales', etiqueta: 'Política de reembolsos', esquema: texto('Política de reembolsos', 20000) },

  // ── Pie de página (todas las públicas) ──
  { id: 'pie.marca', pagina: 'Pie de página', etiqueta: 'Descripción de la marca', esquema: objeto('Pie de página', { descripcion: texto('Descripción', 240) }) },
];

/** id → { id, seccion, clave, pagina, etiqueta, esquema } */
const BLOQUES = new Map(CATALOGO.map((b) => {
  const [seccion, clave] = b.id.split('.');
  return [b.id, { ...b, seccion, clave }];
}));

// Valores que guardaban los editores viejos y que ahora solo sirven de valor
// inicial (§1.1). GET los devuelve ya legibles y PUT no los acepta:
// - inicio.testimonios_config → cantidad y estrellas de inicio.testimonios
// - nosotros.fondo_conocenos  → fondo de conocenos.visita
// - nosotros.galeria_local    → conocenos.galeria (con su misma forma)
const FUENTES_ANTERIORES = new Map([
  ['inicio.testimonios_config', objeto('Testimonios', {
    cantidad: entero('Cantidad de reseñas', 1, 6),
    min_estrellas: entero('Estrellas mínimas', 1, 5),
  })],
  ['nosotros.fondo_conocenos', imagen('Foto de fondo')],
]);
const GALERIA_LOCAL = 'nosotros.galeria_local';

/** Filas que lee GET: los bloques del catálogo y las fuentes anteriores */
const IDS_LECTURA = Object.freeze([...BLOQUES.keys(), ...FUENTES_ANTERIORES.keys(), GALERIA_LOCAL]);

// ══════════════════════════════════════
// LECTURA DE LO GUARDADO (GET)
// ══════════════════════════════════════

// Lo que el sanitizador global (validator.escape) dejó en los textos
const ENTIDADES = new Map([
  ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#x27;', "'"],
  ['&#39;', "'"], ['&#x2F;', '/'], ['&#x5C;', '\\'], ['&#96;', '`'],
]);
const RE_ENTIDAD = /&(?:amp|lt|gt|quot|#x27|#39|#x2F|#x5C|#96);/g;

/** Una sola pasada ("&amp;lt;" queda "&lt;"), recursiva en listas y objetos; solo toca textos */
function decodificarEntidades(valor) {
  if (typeof valor === 'string') return valor.replace(RE_ENTIDAD, (entidad) => ENTIDADES.get(entidad));
  if (Array.isArray(valor)) return valor.map((v) => decodificarEntidades(v));
  if (esObjeto(valor)) return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, decodificarEntidades(v)]));
  return valor;
}

/**
 * nosotros.galeria_local: la página vieja "Galería del Local" guardaba
 * JSON.stringify([{ url, public_id }]) y el sanitizador lo escapaba y le
 * quitaba [ ] { } $, así que nunca se pudo volver a leer. Se rescatan, en
 * orden, las URLs de Cloudinary de la cuenta (entre comillas, sola o en una
 * lista real) con la forma de conocenos.galeria; undefined si no queda ninguna.
 */
function recuperarGaleriaLocal(guardado) {
  const datos = decodificarEntidades(guardado);
  let urls = [];
  if (Array.isArray(datos)) {
    urls = datos.map((x) => (esObjeto(x) ? x.url : x));
  } else if (typeof datos === 'string') {
    urls = esUrlDeCloudinary(datos.trim())
      ? [datos.trim()]
      : Array.from(datos.matchAll(/"(https:\/\/res\.cloudinary\.com\/[^"]+)"/g), (m) => m[1]);
  }
  const fotos = urls
    .filter((url) => esUrlDeCloudinary(url))
    .slice(0, BLOQUES.get('conocenos.galeria').esquema.max)
    .map((url) => ({ imagen: url, alt: '' }));
  return fotos.length > 0 ? fotos : undefined;
}

/** Valor guardado ya legible y limpio; undefined si no cumple su esquema (el frontend usa su defecto) */
function leerGuardado(id, guardado) {
  if (id === GALERIA_LOCAL) return recuperarGaleriaLocal(guardado);
  const esquema = BLOQUES.get(id)?.esquema ?? FUENTES_ANTERIORES.get(id);
  if (!esquema) return undefined;
  const errores = [];
  const valor = validarValor(esquema, decodificarEntidades(guardado), [], errores);
  return errores.length === 0 ? valor : undefined;
}

/**
 * Respuesta de GET (y de PUT): { contenido: { [bloque]: valor }, actualizado:
 * { [bloque]: ISO } } con los bloques que existen en la base y cumplen su
 * esquema, en el orden del catálogo. `filas`: { seccion, clave, valor, updated_at }.
 */
function armarContenido(filas) {
  const porId = new Map(filas.map((f) => [`${f.seccion}.${f.clave}`, f]));
  const contenido = {};
  const actualizado = {};
  for (const id of IDS_LECTURA) {
    const fila = porId.get(id);
    const valor = fila ? leerGuardado(id, fila.valor) : undefined;
    if (valor === undefined) continue;
    contenido[id] = valor;
    actualizado[id] = new Date(fila.updated_at).toISOString();
  }
  return { contenido, actualizado };
}

// ══════════════════════════════════════
// PUBLICACIÓN (PUT)
// ══════════════════════════════════════

/**
 * Valida TODOS los bloques de una publicación antes de escribir. Devuelve
 * los válidos ya limpios ({ id, seccion, clave, pagina, etiqueta, valor },
 * con lo que su `alGuardar` agrega para la app) y los errores como
 * { bloque, campo, mensaje }; con uno solo no se guarda nada.
 */
function validarBloques(bloques) {
  const validos = [];
  const errores = [];
  for (const [id, valor] of Object.entries(bloques)) {
    const bloque = BLOQUES.get(id);
    if (!bloque) {
      errores.push({ bloque: id.slice(0, 80), campo: '', mensaje: 'Este bloque no se edita desde el Editor del sitio' });
      continue;
    }
    const propios = [];
    const limpio = validarValor(bloque.esquema, valor, [], propios);
    if (propios.length > 0) {
      errores.push(...propios.map((e) => ({ bloque: id, ...e })));
    } else {
      const aGuardar = bloque.alGuardar ? bloque.alGuardar(limpio) : limpio;
      validos.push({ id, seccion: bloque.seccion, clave: bloque.clave, pagina: bloque.pagina, etiqueta: bloque.etiqueta, valor: aGuardar });
    }
  }
  return { validos, errores: errores.slice(0, MAX_ERRORES) };
}

/** Mensaje general del 400: el error con su página si es uno solo, la cuenta si son varios */
function resumenErrores(errores) {
  if (errores.length !== 1) return `No se publicó nada: hay ${errores.length} campos por corregir`;
  const [error] = errores;
  const bloque = BLOQUES.get(error.bloque);
  return bloque
    ? `No se publicó nada: ${bloque.pagina} · ${bloque.etiqueta} — ${error.mensaje}`
    : `No se publicó nada: ${error.mensaje}`;
}

module.exports = {
  IMAGENES_LOCALES, ICONOS, ESTILOS, MAX_BLOQUES, BLOQUES, IDS_LECTURA,
  esObjeto, esUrlDeCloudinary, jsonOrdenado, decodificarEntidades, recuperarGaleriaLocal,
  armarContenido, validarBloques, resumenErrores,
};
