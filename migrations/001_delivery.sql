-- =====================================================================
-- MIGRACIÓN: Envío a domicilio (rol repartidor)
-- Esquema: core
-- Ejecutar en Neon SQL Editor de forma completa
-- =====================================================================

BEGIN;

-- =====================================================================
-- 1. Zonas de envío y su catálogo de colonias
--    La cobertura en Huejutla se resuelve por lista de colonias, no por
--    geocercas. Dirección General administra zonas, tarifas y colonias.
-- =====================================================================
CREATE TABLE IF NOT EXISTS core.tblzonas_envio (
  id          SERIAL PRIMARY KEY,
  nombre      VARCHAR(100) NOT NULL,
  tarifa      NUMERIC(10,2) NOT NULL CHECK (tarifa >= 0),
  activa      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS core.tblzonas_colonias (
  id       SERIAL PRIMARY KEY,
  zona_id  INTEGER NOT NULL REFERENCES core.tblzonas_envio(id) ON DELETE CASCADE,
  colonia  VARCHAR(120) NOT NULL
);

-- Una colonia solo puede pertenecer a una zona (insensible a mayúsculas)
CREATE UNIQUE INDEX IF NOT EXISTS idx_tblzonas_colonias_unica
  ON core.tblzonas_colonias (LOWER(colonia));

CREATE INDEX IF NOT EXISTS idx_tblzonas_colonias_zona
  ON core.tblzonas_colonias (zona_id);

-- =====================================================================
-- 2. Direcciones de entrega del cliente
--    Libreta de direcciones reutilizable. El pedido guarda un snapshot
--    en JSONB (ver §4), por lo que editar/borrar una dirección no
--    altera pedidos históricos.
-- =====================================================================
CREATE TABLE IF NOT EXISTS core.tbldirecciones (
  id                 SERIAL PRIMARY KEY,
  usuario_id         INTEGER NOT NULL REFERENCES core.tblusuarios(id) ON DELETE CASCADE,
  alias              VARCHAR(50) NOT NULL,
  calle_numero       VARCHAR(150) NOT NULL,
  colonia            VARCHAR(120) NOT NULL,
  referencias        TEXT,
  telefono_contacto  VARCHAR(20),
  activa             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tbldirecciones_usuario
  ON core.tbldirecciones (usuario_id)
  WHERE activa = TRUE;

-- =====================================================================
-- 3. Entregas (asignación pedido → repartidor)
--    Separa la logística de entrega del pedido. Se permite historial:
--    si una entrega falla, puede crearse una nueva asignación, pero solo
--    puede existir UNA entrega activa por pedido (índice parcial).
-- =====================================================================
CREATE TABLE IF NOT EXISTS core.tblentregas (
  id              SERIAL PRIMARY KEY,
  pedido_id       INTEGER NOT NULL REFERENCES core.tblpedidos(id) ON DELETE CASCADE,
  repartidor_id   INTEGER NOT NULL REFERENCES core.tblusuarios(id),
  estado          VARCHAR(20) NOT NULL DEFAULT 'asignada'
                  CHECK (estado IN ('asignada', 'en_camino', 'entregada', 'fallida')),
  asignado_por    INTEGER REFERENCES core.tblusuarios(id),
  asignado_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  salio_at        TIMESTAMP,
  finalizado_at   TIMESTAMP,
  evidencia_url   TEXT,
  recibio_nombre  VARCHAR(100),
  motivo_fallo    TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tblentregas_pedido_activa
  ON core.tblentregas (pedido_id)
  WHERE estado IN ('asignada', 'en_camino');

CREATE INDEX IF NOT EXISTS idx_tblentregas_repartidor
  ON core.tblentregas (repartidor_id, estado);

-- =====================================================================
-- 4. Columnas nuevas en tblpedidos
--    - tipo_entrega: 'pickup' (recoger en sucursal) | 'domicilio'
--    - costo_envio: tarifa cobrada según la zona (0 en pickup)
--    - direccion_entrega: snapshot JSONB de la dirección al momento de
--      comprar (alias, calle_numero, colonia, referencias, telefono)
--    - horario_entrega: ventana acordada para entregas a domicilio
--    Estados nuevos del pedido (validados en la app, rol repartidor):
--    'asignado', 'en_camino', 'entregado', 'entrega_fallida'
-- =====================================================================
ALTER TABLE core.tblpedidos
  ADD COLUMN IF NOT EXISTS tipo_entrega       VARCHAR(20) NOT NULL DEFAULT 'pickup',
  ADD COLUMN IF NOT EXISTS costo_envio        NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS direccion_entrega  JSONB,
  ADD COLUMN IF NOT EXISTS horario_entrega    TIMESTAMP;

ALTER TABLE core.tblpedidos
  DROP CONSTRAINT IF EXISTS chk_tblpedidos_tipo_entrega;
ALTER TABLE core.tblpedidos
  ADD CONSTRAINT chk_tblpedidos_tipo_entrega
  CHECK (tipo_entrega IN ('pickup', 'domicilio'));

CREATE INDEX IF NOT EXISTS idx_tblpedidos_tipo_entrega
  ON core.tblpedidos (tipo_entrega, estado);

-- =====================================================================
-- 5. Disponibilidad del repartidor
--    Toggle que controla el propio repartidor desde su panel.
-- =====================================================================
ALTER TABLE core.tblusuarios
  ADD COLUMN IF NOT EXISTS disponible BOOLEAN NOT NULL DEFAULT TRUE;

-- =====================================================================
-- 6. Catálogo inicial de zonas (editable desde Dirección General)
--    Tarifas y colonias de arranque para Huejutla de Reyes.
-- =====================================================================
INSERT INTO core.tblzonas_envio (nombre, tarifa)
SELECT v.nombre, v.tarifa
FROM (VALUES
  ('Zona 1 - Centro', 25.00),
  ('Zona 2 - Colonias', 35.00),
  ('Zona 3 - Periferia', 50.00)
) AS v(nombre, tarifa)
WHERE NOT EXISTS (SELECT 1 FROM core.tblzonas_envio);

INSERT INTO core.tblzonas_colonias (zona_id, colonia)
SELECT z.id, c.colonia
FROM (VALUES
  ('Zona 1 - Centro',    'Centro'),
  ('Zona 1 - Centro',    'Zona Centro'),
  ('Zona 2 - Colonias',  'Aviación Civil'),
  ('Zona 2 - Colonias',  'Juárez'),
  ('Zona 2 - Colonias',  'Capte'),
  ('Zona 2 - Colonias',  'Parque de Poblamiento'),
  ('Zona 2 - Colonias',  'Los Fresnos'),
  ('Zona 3 - Periferia', 'Tahuizán'),
  ('Zona 3 - Periferia', 'Chalahuiyapa'),
  ('Zona 3 - Periferia', 'Ixcatlán')
) AS c(zona_nombre, colonia)
JOIN core.tblzonas_envio z ON z.nombre = c.zona_nombre
WHERE NOT EXISTS (SELECT 1 FROM core.tblzonas_colonias);

-- =====================================================================
-- 7. Comentarios para documentar el esquema
-- =====================================================================
COMMENT ON TABLE core.tblzonas_envio IS
  'Zonas de cobertura de envío a domicilio en Huejutla con su tarifa.';
COMMENT ON TABLE core.tblzonas_colonias IS
  'Colonias que pertenecen a cada zona de envío (matching por nombre).';
COMMENT ON TABLE core.tbldirecciones IS
  'Libreta de direcciones de entrega del cliente.';
COMMENT ON TABLE core.tblentregas IS
  'Asignaciones de pedidos a repartidores con evidencia de entrega.';
COMMENT ON COLUMN core.tblpedidos.direccion_entrega IS
  'Snapshot JSONB de la dirección al momento de la compra; inmutable ante cambios en tbldirecciones.';
COMMENT ON COLUMN core.tblusuarios.disponible IS
  'Disponibilidad del repartidor para recibir asignaciones. Sin efecto en otros roles.';

COMMIT;

-- =====================================================================
-- VERIFICACIÓN POST-MIGRACIÓN
-- =====================================================================
-- SELECT table_name FROM information_schema.tables
--  WHERE table_schema = 'core'
--    AND table_name IN ('tblzonas_envio','tblzonas_colonias','tbldirecciones','tblentregas');
--
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema = 'core' AND table_name = 'tblpedidos'
--    AND column_name IN ('tipo_entrega','costo_envio','direccion_entrega','horario_entrega');
--
-- SELECT z.nombre, z.tarifa, COUNT(c.id) AS colonias
--   FROM core.tblzonas_envio z LEFT JOIN core.tblzonas_colonias c ON c.zona_id = z.id
--  GROUP BY z.id ORDER BY z.id;
