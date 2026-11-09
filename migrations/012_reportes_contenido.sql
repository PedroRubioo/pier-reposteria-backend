-- ============================================================
-- 012 · Reportes de contenido (Google Play)
--
-- Google Play pide que los usuarios puedan reportar lo que publican
-- otros usuarios. Los clientes reportan desde la app una reseña de
-- producto o un comentario de «Novedades»; el personal los atiende en
-- Atención a clientes → Reportes: retira el contenido o lo mantiene.
--
-- Una fila por reporte; cada cliente reporta una sola vez cada
-- contenido. Si el comentario reportado se borra de la base (la baja
-- de la cuenta de su autor), sus reportes se van con él.
--
-- Solo agrega una tabla: no toca datos existentes. Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS core.tblreportes (
  id             SERIAL PRIMARY KEY,
  tipo           VARCHAR(12) NOT NULL CHECK (tipo IN ('resena', 'comentario')),
  resena_id      INTEGER REFERENCES core.tblresenas(id) ON DELETE CASCADE,
  comentario_id  INTEGER REFERENCES core.tblpublicacion_comentarios(id) ON DELETE CASCADE,
  -- Quién reportó
  usuario_id     INTEGER NOT NULL REFERENCES core.tblusuarios(id) ON DELETE CASCADE,
  motivo         VARCHAR(20) NOT NULL
                   CHECK (motivo IN ('ofensivo', 'spam', 'datos_personales', 'fuera_de_tema', 'otro')),
  detalle        VARCHAR(500),
  estado         VARCHAR(12) NOT NULL DEFAULT 'pendiente'
                   CHECK (estado IN ('pendiente', 'atendido', 'descartado')),
  atendido_por   INTEGER REFERENCES core.tblusuarios(id) ON DELETE SET NULL,
  atendido_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Exactamente un contenido: el que dice tipo
  CONSTRAINT chk_reporte_contenido CHECK (
    (tipo = 'resena' AND resena_id IS NOT NULL AND comentario_id IS NULL)
    OR (tipo = 'comentario' AND comentario_id IS NOT NULL AND resena_id IS NULL)),
  CONSTRAINT chk_reporte_atendido CHECK (estado = 'pendiente' OR atendido_at IS NOT NULL)
);

-- Un reporte por cliente y contenido (en las filas del otro tipo la
-- columna va en NULL y no choca)
CREATE UNIQUE INDEX IF NOT EXISTS uq_reportes_resena_usuario
  ON core.tblreportes (resena_id, usuario_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reportes_comentario_usuario
  ON core.tblreportes (comentario_id, usuario_id);

-- La pestaña del personal: por estado, de lo más nuevo a lo más viejo
CREATE INDEX IF NOT EXISTS idx_reportes_estado
  ON core.tblreportes (estado, created_at DESC);
