-- ============================================================
-- 011 · Feed del inicio del cliente
--
-- El inicio del cliente con sesión se vuelve un feed tipo Facebook:
-- publicaciones de la repostería (texto arriba, fotos o videos
-- abajo) con una sola reacción ("Me encanta") y comentarios. Publica
-- el personal desde su panel; los clientes reaccionan y comentan.
--
-- Los contadores (corazones, comentarios) se calculan con COUNT(*)
-- en cada consulta: siempre exactos y de sobra para el volumen del
-- negocio, sin columnas que se desincronicen.
--
-- Solo agrega tablas: no toca datos existentes. Idempotente.
-- ============================================================

-- 1) Publicaciones. Eliminar una publicación la oculta del feed
--    (estado 'eliminada'); no se borra, para conservar su historia.
CREATE TABLE IF NOT EXISTS core.tblpublicaciones (
  id          SERIAL PRIMARY KEY,
  autor_id    INTEGER NOT NULL REFERENCES core.tblusuarios(id),
  texto       TEXT CHECK (texto IS NULL OR char_length(texto) <= 3000),
  estado      VARCHAR(12) NOT NULL DEFAULT 'publicada'
                CHECK (estado IN ('publicada', 'eliminada')),
  editada     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Paginación por llave (created_at, id) de lo más nuevo a lo más viejo
CREATE INDEX IF NOT EXISTS idx_publicaciones_feed
  ON core.tblpublicaciones (created_at DESC, id DESC) WHERE estado = 'publicada';

-- 2) Fotos y videos de cada publicación (Cloudinary, carpeta
--    pier-reposteria/feed). Los videos los sube el navegador directo
--    a Cloudinary con firma del backend; aquí solo queda la referencia.
CREATE TABLE IF NOT EXISTS core.tblpublicacion_medios (
  id              SERIAL PRIMARY KEY,
  publicacion_id  INTEGER NOT NULL REFERENCES core.tblpublicaciones(id) ON DELETE CASCADE,
  tipo            VARCHAR(10) NOT NULL CHECK (tipo IN ('imagen', 'video')),
  url             VARCHAR(500) NOT NULL CHECK (url LIKE 'https://res.cloudinary.com/%'),
  public_id       VARCHAR(255) NOT NULL,
  ancho           INTEGER CHECK (ancho IS NULL OR ancho > 0),
  alto            INTEGER CHECK (alto IS NULL OR alto > 0),
  duracion        NUMERIC(8,2) CHECK (duracion IS NULL OR duracion >= 0),
  poster_url      VARCHAR(500) CHECK (poster_url IS NULL OR poster_url LIKE 'https://res.cloudinary.com/%'),
  orden           SMALLINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_publicacion_medios_publicacion
  ON core.tblpublicacion_medios (publicacion_id, orden);

-- 3) "Me encanta": uno por cliente y publicación. La llave primaria
--    hace que dar corazón dos veces (o con doble toque) cuente uno.
CREATE TABLE IF NOT EXISTS core.tblpublicacion_reacciones (
  publicacion_id  INTEGER NOT NULL REFERENCES core.tblpublicaciones(id) ON DELETE CASCADE,
  usuario_id      INTEGER NOT NULL REFERENCES core.tblusuarios(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (publicacion_id, usuario_id)
);

-- 4) Comentarios. Los del personal salen como respuesta oficial de
--    "Pier Repostería". Ocultar no borra: el autor oculta el suyo
--    ('autor') y el personal modera cualquiera ('moderacion').
CREATE TABLE IF NOT EXISTS core.tblpublicacion_comentarios (
  id              SERIAL PRIMARY KEY,
  publicacion_id  INTEGER NOT NULL REFERENCES core.tblpublicaciones(id) ON DELETE CASCADE,
  usuario_id      INTEGER NOT NULL REFERENCES core.tblusuarios(id) ON DELETE CASCADE,
  texto           VARCHAR(1000) NOT NULL CHECK (btrim(texto) <> ''),
  es_oficial      BOOLEAN NOT NULL DEFAULT false,
  oculto          BOOLEAN NOT NULL DEFAULT false,
  oculto_por      INTEGER REFERENCES core.tblusuarios(id),
  oculto_motivo   VARCHAR(12) CHECK (oculto_motivo IN ('autor', 'moderacion')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_comentario_oculto CHECK (oculto OR (oculto_por IS NULL AND oculto_motivo IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_publicacion_comentarios_publicacion
  ON core.tblpublicacion_comentarios (publicacion_id, created_at, id);

-- Antispam: cuántos comentó cada quien en el último minuto
CREATE INDEX IF NOT EXISTS idx_publicacion_comentarios_usuario
  ON core.tblpublicacion_comentarios (usuario_id, created_at DESC);

-- 5) updated_at automático, igual que el resto de las tablas
DROP TRIGGER IF EXISTS trg_updated_at_publicaciones ON core.tblpublicaciones;
CREATE TRIGGER trg_updated_at_publicaciones
  BEFORE UPDATE ON core.tblpublicaciones
  FOR EACH ROW EXECUTE FUNCTION core.fn_actualizar_updated_at();
