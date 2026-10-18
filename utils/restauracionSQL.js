// utils/restauracionSQL.js — Qué acepta "Restaurar" en Respaldos
// (Diseno_Panel_Direccion.md §3)
//
// Solo sentencias INSERT INTO core.<tabla> [(columnas)] VALUES (...), como
// las que arma el respaldo selectivo. BEGIN, COMMIT y SET se aceptan pero no
// se ejecutan: la restauración corre en su propia transacción y con la
// configuración normal (un SET se quedaría pegado a la conexión del pool).
// Todo lo demás se rechaza.
//
// Para partir el texto en sentencias se lee como lo lee PostgreSQL: un ";"
// dentro de un texto '...' o de un nombre "..." no corta. Los textos E'...'
// (barras invertidas) y los de dólares ($$...$$) se leen distinto y se
// rechazan: así, lo que aquí es un texto también lo es para la base.

// Piezas: texto, nombre entre comillas, comentario de línea o de bloque,
// punto y coma, tramo de código y, al final, un carácter suelto
const PIEZA = /'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\/|;|[^'";\-/]+|[\s\S]/g;

const CONTROL = /^(BEGIN( (WORK|TRANSACTION))?|START TRANSACTION|(COMMIT|END)( (WORK|TRANSACTION))?)$/i;
const AJUSTE = /^SET\b/i;
const INSERCION = /^INSERT INTO core ?\. ?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*) ?(\([^()]*\) ?)?VALUES\b(.*)$/is;
// Después de VALUES solo van valores: ni consultas, ni funciones, ni cláusulas
const PALABRAS_PROHIBIDAS = /\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|COPY|EXECUTE|CALL|WITH|ON|RETURNING|TABLE)\b/i;
const LLAMADA_A_FUNCION = /[A-Za-z_][A-Za-z0-9_]*\s*\(/;

const recorte = (texto) => (texto.length > 80 ? `${texto.slice(0, 80)}…` : texto);

/** Nombre de la tabla como lo resuelve PostgreSQL: con comillas tal cual, sin ellas en minúsculas */
const nombreTabla = (crudo) => (crudo.startsWith('"') ? crudo.slice(1, -1).replace(/""/g, '"') : crudo.toLowerCase());

/** Parte el SQL en sentencias. Cada una trae su texto (sin comentarios) y su código (textos vaciados) */
function partirSentencias(sql) {
  const sentencias = [];
  let texto = '';
  let codigo = '';
  const cerrar = () => {
    if (texto.trim()) sentencias.push({ texto: texto.trim(), codigo: codigo.replace(/\s+/g, ' ').trim() });
    texto = '';
    codigo = '';
  };
  for (const [pieza] of sql.matchAll(PIEZA)) {
    if (pieza[0] === "'" || pieza[0] === '"') {
      if (pieza.length < 2) return { error: 'Hay una comilla sin cerrar' };
      if (pieza[0] === "'" && /(^|[^\w$])[Ee]$/.test(codigo)) return { error: "No se aceptan textos con barras invertidas (E'...')" };
      texto += pieza;
      codigo += pieza[0] === "'" ? "''" : pieza;
    } else if (pieza.startsWith('--') || (pieza.startsWith('/*') && pieza.length >= 4)) {
      texto += ' ';
      codigo += ' ';
    } else if (pieza === ';') {
      cerrar();
    } else {
      texto += pieza;
      codigo += pieza;
    }
  }
  cerrar();
  return { sentencias };
}

/**
 * Revisa el SQL de una restauración.
 * @returns {{ error: string } | { inserciones: { texto: string, tabla: string }[] }}
 *          error en español para responder 400; si no, las INSERT a ejecutar
 */
function revisarRestauracion(sql) {
  const { error, sentencias } = partirSentencias(sql);
  if (error) return { error };
  const inserciones = [];
  for (const [i, sentencia] of sentencias.entries()) {
    const { texto, codigo } = sentencia;
    if (CONTROL.test(codigo) || AJUSTE.test(codigo)) continue;
    const partes = INSERCION.exec(codigo);
    const valores = partes ? partes[3] : '';
    if (!partes || codigo.includes('$') || PALABRAS_PROHIBIDAS.test(valores) || LLAMADA_A_FUNCION.test(valores)) {
      return { error: `Solo se aceptan sentencias INSERT INTO core.<tabla> ... VALUES (...), además de BEGIN, COMMIT y SET. La sentencia ${i + 1} no lo es: "${recorte(texto)}"` };
    }
    inserciones.push({ texto, tabla: nombreTabla(partes[1]) });
  }
  if (inserciones.length === 0) return { error: 'El archivo no trae sentencias INSERT INTO core.<tabla> para restaurar' };
  return { inserciones };
}

module.exports = { revisarRestauracion };
