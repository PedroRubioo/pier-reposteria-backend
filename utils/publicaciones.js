// utils/publicaciones.js — Reglas del feed del inicio del cliente
//
// Validación y normalización de lo que manda el personal (publicaciones
// con fotos y videos) y de los comentarios, nombre corto de quien comenta,
// precio real de una promoción y la regla de los videos que el navegador
// sube directo a Cloudinary (Diseno_Feed_Inicio.md §2). Todo es puro: se
// prueba sin base de datos ni Cloudinary.

const MARCA = 'Pier Repostería';
const CARPETA_FEED = 'pier-reposteria/feed';
const PREFIJO_PUBLIC_ID = `${CARPETA_FEED}/`;

const MAX_TEXTO_PUBLICACION = 3000;
const MAX_TEXTO_COMENTARIO = 1000;
const MAX_MEDIOS = 10;
const MAX_VIDEOS = 3;
const MAX_BYTES_VIDEO = 100 * 1024 * 1024;
const MAX_SEGUNDOS_VIDEO = 180;
// Tope generoso para ancho y alto en píxeles: solo descarta valores absurdos
const MAX_LADO = 100000;

// Solo se aceptan archivos de la cuenta de Cloudinary de Pier, como en comandas
const PREFIJO_CUENTA = process.env.CLOUDINARY_CLOUD_NAME
  ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`
  : null;

const ETIQUETAS = new Map([['mas_vendido', 'Más vendido'], ['popular', 'Popular'], ['favorito', 'Favorito'], ['premium', 'Premium']]);

const CONTROL = /\p{Cc}/u;

// ══════════════════════════════════════
// BÁSICOS
// ══════════════════════════════════════

const esObjeto = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const esEntero = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
/** Id de base de datos: entero positivo que cabe en INTEGER */
const esId = (n) => esEntero(n, 1, 2147483647);
/** Caracteres como los cuenta PostgreSQL (un emoji es uno, no dos unidades UTF-16) */
const largo = (s) => Array.from(s).length;
const ausente = (v) => v === undefined || v === null;

/** Número desde el JSON; acepta también texto numérico ("120") */
function aNumero(valor) {
  if (typeof valor === 'number') return valor;
  if (typeof valor === 'string' && valor.trim() !== '') return Number(valor);
  return NaN;
}

/** Texto en una sola línea y con tope, para la bitácora */
function recortar(texto, max) {
  const linea = texto.replace(/\s+/g, ' ').trim();
  return largo(linea) > max ? `${Array.from(linea).slice(0, max - 1).join('')}…` : linea;
}

/**
 * Texto libre: une los saltos de línea en "\n", normaliza (NFC), recorta y
 * rechaza caracteres de control salvo tabulador y salto de línea. Con
 * `colapsar` quita los espacios al final de cada línea y deja como mucho
 * una línea en blanco seguida (más de 2 saltos se vuelven 2). Vacío → null;
 * con min > 0 es obligatorio. Si no es válido deja el error en la lista y
 * devuelve undefined.
 */
function limpiarTexto(valor, campo, max, errores, { min = 0, colapsar = false } = {}) {
  if (!ausente(valor) && typeof valor !== 'string') {
    errores.push(`${campo}: no es un texto válido`);
    return undefined;
  }
  let limpio = (valor ?? '').replace(/\r\n?/g, '\n').normalize('NFC');
  if (colapsar) limpio = limpio.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  limpio = limpio.trim();
  if (limpio === '') {
    if (min === 0) return null;
    errores.push(`${campo}: no puede ir vacío`);
    return undefined;
  }
  if (CONTROL.test(limpio.replace(/[\t\n]/g, ''))) {
    errores.push(`${campo}: contiene caracteres no permitidos`);
    return undefined;
  }
  const n = largo(limpio);
  if (n < min || n > max) {
    errores.push(min > 1 ? `${campo}: escribe de ${min} a ${max} caracteres` : `${campo}: máximo ${max} caracteres`);
    return undefined;
  }
  return limpio;
}

/** "Carla C.": primer nombre e inicial del apellido (así ven los demás a quien comenta) */
function nombreCorto(nombre, apellido) {
  const primero = (nombre ?? '').normalize('NFC').trim().split(/\s+/)[0] || 'Cliente';
  const inicial = Array.from((apellido ?? '').normalize('NFC').trim())[0];
  return inicial ? `${primero} ${inicial.toLocaleUpperCase('es-MX')}.` : primero;
}

// ══════════════════════════════════════
// FOTOS Y VIDEOS DE CLOUDINARY
// ══════════════════════════════════════

/**
 * URL de la cuenta de Pier, del tipo indicado ('image' o 'video') y en forma
 * canónica, como la devuelve Cloudinary: así lo que se valida es exactamente
 * lo que se guarda. "../", "./", "%2e%2e" o "\" se rechazan aunque al
 * resolverse la URL quede dentro de la cuenta (mismo criterio que comandas).
 */
function esUrlDeCloudinary(url, recurso) {
  const prefijo = PREFIJO_CUENTA ? `${PREFIJO_CUENTA}${recurso}/upload/` : null;
  if (!prefijo || typeof url !== 'string' || !url.startsWith(prefijo) || url.length > 500 || /\s/.test(url) || CONTROL.test(url)) {
    return false;
  }
  try {
    return new URL(url).href === url;
  } catch {
    return false;
  }
}

/**
 * public_id dentro de la carpeta del feed, como lo genera Cloudinary
 * ('pier-reposteria/feed/<id>'). El prefijo no basta: se rechazan segmentos
 * vacíos, "." o "..", la "\" y el "%" (mismo criterio que comandas).
 */
function esPublicIdDelFeed(publicId) {
  if (typeof publicId !== 'string' || !publicId.startsWith(PREFIJO_PUBLIC_ID) || publicId.length > 255
    || /[\s\\%]/.test(publicId) || CONTROL.test(publicId)) {
    return false;
  }
  return publicId.slice(PREFIJO_PUBLIC_ID.length).split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Ancho o alto en píxeles: entero positivo o null */
function dimension(valor, campo, errores) {
  if (ausente(valor)) return null;
  const n = aNumero(valor);
  if (!esEntero(n, 1, MAX_LADO)) errores.push(`${campo}: debe ser un entero positivo`);
  return n;
}

/**
 * Un medio de la publicación (MedioEntrada). Al editar, el que ya tenía la
 * publicación (misma URL y tipo) conserva el public_id guardado: la lista
 * del personal muestra los medios por URL. Devuelve null si no es válido.
 */
function validarMedio(m, etiqueta, guardados, errores) {
  const erroresPrevios = errores.length;
  const url = typeof m.url === 'string' ? m.url.trim() : '';
  if (!esUrlDeCloudinary(url, m.tipo === 'imagen' ? 'image' : 'video')) {
    errores.push(`${etiqueta}: no es un archivo subido desde el feed`);
    return null;
  }
  const previo = guardados.find((g) => g.tipo === m.tipo && g.url === url);
  const publicId = previo ? previo.public_id : (typeof m.public_id === 'string' ? m.public_id.trim() : '');
  if (!esPublicIdDelFeed(publicId)) {
    errores.push(`${etiqueta}: no es un archivo subido desde el feed`);
    return null;
  }
  const ancho = dimension(m.ancho, `${etiqueta} · Ancho`, errores);
  const alto = dimension(m.alto, `${etiqueta} · Alto`, errores);
  let duracion = null;
  let posterUrl = null;
  if (m.tipo === 'video') {
    if (!ausente(m.duracion)) {
      const segundos = aNumero(m.duracion);
      if (segundos >= 0 && segundos <= MAX_SEGUNDOS_VIDEO) duracion = Math.round(segundos * 100) / 100;
      else errores.push(`${etiqueta} · Duración: debe ser de 0 a ${MAX_SEGUNDOS_VIDEO} segundos`);
    }
    if (!ausente(m.poster_url) && m.poster_url !== '') {
      if (esUrlDeCloudinary(m.poster_url, 'video')) posterUrl = m.poster_url;
      else errores.push(`${etiqueta}: la portada no es del video subido`);
    }
  } else {
    if (!ausente(m.duracion)) errores.push(`${etiqueta}: una foto no lleva duración`);
    if (!ausente(m.poster_url) && m.poster_url !== '') errores.push(`${etiqueta}: una foto no lleva portada`);
  }
  if (errores.length > erroresPrevios) return null;
  return { tipo: m.tipo, url, public_id: publicId, ancho, alto, duracion, poster_url: posterUrl };
}

/**
 * Valida y normaliza una PublicacionEntrada { texto, medios }: texto o al
 * menos un medio, como mucho 10 medios y 3 videos. `guardados` son los
 * medios que ya tiene la publicación (al editar) o [] (alta).
 *
 * @returns {{ errores: string[], publicacion: { texto: string|null, medios: object[] }|null }}
 */
function validarPublicacion(entrada, guardados) {
  const errores = [];
  const e = esObjeto(entrada) ? entrada : {};
  const texto = limpiarTexto(e.texto, 'Texto', MAX_TEXTO_PUBLICACION, errores);
  const lista = ausente(e.medios) ? [] : e.medios;
  let medios = [];
  if (!Array.isArray(lista)) {
    errores.push('Fotos y videos: formato no válido');
  } else if (lista.length > MAX_MEDIOS) {
    errores.push(`Una publicación lleva como máximo ${MAX_MEDIOS} fotos y videos`);
  } else {
    let fotos = 0;
    let videos = 0;
    medios = lista.map((m, i) => {
      if (!esObjeto(m) || (m.tipo !== 'imagen' && m.tipo !== 'video')) {
        errores.push(`Archivo ${i + 1}: indica si es una foto o un video`);
        return null;
      }
      if (m.tipo === 'imagen') fotos += 1;
      else videos += 1;
      return validarMedio(m, m.tipo === 'imagen' ? `Foto ${fotos}` : `Video ${videos}`, guardados, errores);
    });
    if (videos > MAX_VIDEOS) errores.push(`Una publicación lleva como máximo ${MAX_VIDEOS} videos`);
  }
  if (errores.length === 0 && texto === null && medios.length === 0) {
    errores.push('Escribe un texto o agrega al menos una foto o un video');
  }
  if (errores.length > 0) return { errores, publicacion: null };
  return { errores, publicacion: { texto, medios } };
}

/** ¿Los mismos medios en el mismo orden? La duración guardada llega como texto (NUMERIC) */
function mismosMedios(guardados, nuevos) {
  const clave = (m) => JSON.stringify([
    m.tipo, m.url, m.public_id, m.ancho, m.alto, ausente(m.duracion) ? null : Number(m.duracion), m.poster_url,
  ]);
  return guardados.length === nuevos.length && guardados.every((m, i) => clave(m) === clave(nuevos.at(i)));
}

/** Detalle de la bitácora: 'texto recortado · 2 fotos · 1 video' */
function resumenPublicacion(texto, medios) {
  const fotos = medios.filter((m) => m.tipo === 'imagen').length;
  const videos = medios.length - fotos;
  const partes = [texto ? recortar(texto, 80) : 'Sin texto'];
  if (fotos > 0) partes.push(`${fotos} ${fotos === 1 ? 'foto' : 'fotos'}`);
  if (videos > 0) partes.push(`${videos} ${videos === 1 ? 'video' : 'videos'}`);
  return partes.join(' · ');
}

/** Duración en segundos que reporta Cloudinary (arriba o en los metadatos del archivo); NaN si no viene */
function duracionDe(recurso) {
  const valor = recurso.duration ?? (esObjeto(recurso.video_metadata) && esObjeto(recurso.video_metadata.format)
    ? recurso.video_metadata.format.duration
    : undefined);
  return ausente(valor) || valor === '' ? NaN : Number(valor);
}

/**
 * Regla del video que el navegador ya subió a Cloudinary (§2): carpeta del
 * feed, ≤ 100 MB y ≤ 180 s. Recibe la respuesta de cloudinary.api.resource
 * y es pura para probarla sin Cloudinary real. Devuelve los problemas
 * (vacío si cumple) y, si cumple, sus medidas.
 */
function revisarVideo(recurso) {
  const r = esObjeto(recurso) ? recurso : {};
  const errores = [];
  // asset_folder solo viene en cuentas con carpetas dinámicas
  const carpeta = typeof r.asset_folder === 'string' && r.asset_folder !== '' ? r.asset_folder : null;
  if (!esPublicIdDelFeed(r.public_id) || (carpeta !== null && carpeta !== CARPETA_FEED && !carpeta.startsWith(PREFIJO_PUBLIC_ID))) {
    errores.push('El video no está en la carpeta del feed');
  }
  const bytes = Number(r.bytes);
  if (!(bytes > 0)) errores.push('No se pudo comprobar el peso del video');
  else if (bytes > MAX_BYTES_VIDEO) errores.push('El video pesa más de 100 MB');
  const duracion = duracionDe(r);
  if (!(duracion > 0)) errores.push('No se pudo comprobar la duración del video');
  else if (duracion > MAX_SEGUNDOS_VIDEO) errores.push('El video dura más de 3 minutos');
  const ancho = Number(r.width);
  const alto = Number(r.height);
  if (!esEntero(ancho, 1, MAX_LADO) || !esEntero(alto, 1, MAX_LADO)) errores.push('El archivo no es un video');
  if (errores.length > 0) return { errores, video: null };
  return { errores, video: { ancho, alto, duracion: Math.round(duracion * 100) / 100 } };
}

// ══════════════════════════════════════
// PROMOCIONES
// ══════════════════════════════════════

/** Insignia legible de un destacado ("Más vendido"...); null en los demás tipos */
const etiquetaPromocion = (tipo, badge) => (tipo === 'destacado' ? ETIQUETAS.get(badge) ?? null : null);

/**
 * Precio con descuento tal como lo cobran el carrito y el pago
 * (carritoRoutes y pagosRoutes): el precio chico con el porcentaje
 * aplicado, redondeado a pesos con Math.round. Sin descuento, el normal.
 */
function precioPromocion(precioChico, descuento) {
  const base = parseFloat(precioChico);
  const final = ausente(descuento) ? base : Math.round(base * (1 - parseFloat(descuento) / 100));
  return final.toFixed(2);
}

module.exports = {
  MARCA,
  CARPETA_FEED,
  MAX_TEXTO_COMENTARIO,
  esId,
  recortar,
  limpiarTexto,
  nombreCorto,
  esPublicIdDelFeed,
  validarPublicacion,
  mismosMedios,
  resumenPublicacion,
  revisarVideo,
  etiquetaPromocion,
  precioPromocion,
};
