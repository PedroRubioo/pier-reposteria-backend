-- ============================================================
-- 009 · Demanda no atendida
--
-- Petición directa de la dueña: saber qué buscó la gente y no
-- tuvimos. Dos fuentes:
--   · búsquedas del catálogo (las de 0 resultados valen oro)
--   · clics en productos agotados (querían comprarlo y no había)
-- Ambas se registran sin bloquear la operación.
-- ============================================================

CREATE TABLE IF NOT EXISTS core.tblbusquedas (
  id              SERIAL PRIMARY KEY,
  texto           VARCHAR(120) NOT NULL,
  num_resultados  INTEGER NOT NULL DEFAULT 0,
  usuario_id      INTEGER REFERENCES core.tblusuarios(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_busquedas_texto ON core.tblbusquedas (LOWER(texto));
CREATE INDEX IF NOT EXISTS idx_busquedas_sin_resultado ON core.tblbusquedas (num_resultados) WHERE num_resultados = 0;
CREATE INDEX IF NOT EXISTS idx_busquedas_fecha ON core.tblbusquedas (created_at DESC);

CREATE TABLE IF NOT EXISTS core.tblclicks_agotados (
  id           SERIAL PRIMARY KEY,
  producto_id  INTEGER NOT NULL REFERENCES core.tblproductos(id) ON DELETE CASCADE,
  usuario_id   INTEGER REFERENCES core.tblusuarios(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clicks_agotados_producto ON core.tblclicks_agotados (producto_id);
CREATE INDEX IF NOT EXISTS idx_clicks_agotados_fecha ON core.tblclicks_agotados (created_at DESC);
