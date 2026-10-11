-- ============================================================
-- 010 · Comandas de pedidos personalizados
--
-- Sustituye el Excel en Dropbox, la bitácora en papel y la nota
-- de remisión con que hoy se toman los pedidos personalizados en
-- el local. Requisitos de la dueña:
--   · hornos y decoración ven la comanda DESDE QUE SE CAPTURA,
--     en paralelo (decoración compra insumos con 2-3 días)
--   · cada uno confirma con un "Enterado" que nadie puede borrar
--   · si la comanda cambia, vuelven a confirmar la versión nueva
--   · solo quien tomó el pedido (o gerencia/dirección) la edita,
--     y nadie después de entregada
--
-- NOTA: los ALTER TYPE ... ADD VALUE no pueden ir dentro de una
-- transacción. Aplicar el archivo tal cual, sentencia por sentencia.
-- ============================================================

-- 1) Roles nuevos del personal de producción
ALTER TYPE public.rol_usuario ADD VALUE IF NOT EXISTS 'hornos';
ALTER TYPE public.rol_usuario ADD VALUE IF NOT EXISTS 'decoracion';

-- 2) Folio propio de la comanda. El negocio venía en el ~4800 con
--    el sistema en papel; se arranca en 5000 para no chocar.
--    Es un contador de una sola fila que se incrementa DENTRO de la
--    transacción que crea la comanda: si algo falla y se revierte, el
--    número no se pierde (una secuencia dejaría huecos, y un hueco se
--    leería como una comanda extraviada, igual que en la libreta).
CREATE TABLE IF NOT EXISTS core.tblcomanda_folio (
  id      SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ultimo  INTEGER NOT NULL
);

INSERT INTO core.tblcomanda_folio (id, ultimo) VALUES (1, 4999)
ON CONFLICT (id) DO NOTHING;

-- 3) Opciones cerradas que la dueña administra (tamaños, sabores,
--    formas y tipos de decoración). Borrar una opción la desactiva:
--    las comandas viejas guardan el texto, no una referencia.
CREATE TABLE IF NOT EXISTS core.tblcomanda_opciones (
  id          SERIAL PRIMARY KEY,
  tipo        VARCHAR(20) NOT NULL CHECK (tipo IN ('tamano', 'sabor', 'forma', 'decoracion')),
  nombre      VARCHAR(80) NOT NULL,
  orden       INTEGER NOT NULL DEFAULT 0,
  activo      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_comanda_opcion_activa
  ON core.tblcomanda_opciones (tipo, LOWER(nombre)) WHERE activo;

-- 4) Cabecera de la comanda
CREATE TABLE IF NOT EXISTS core.tblcomandas (
  id                     SERIAL PRIMARY KEY,
  folio                  INTEGER NOT NULL UNIQUE,
  sucursal               VARCHAR(60) NOT NULL DEFAULT 'Principal',
  cliente_nombre         VARCHAR(120) NOT NULL,
  cliente_telefono       VARCHAR(15) NOT NULL,
  fecha_entrega          DATE NOT NULL,
  hora_entrega           TIME NOT NULL,
  notas                  TEXT,
  -- Presentación de la mesa de postres (sección impresa de la hoja)
  mesa_color_capacillos  VARCHAR(80),
  mesa_color_betun       VARCHAR(80),
  mesa_color_grageas     VARCHAR(80),
  -- Cobro: total ya con descuento; el anticipo mínimo es configurable
  descuento              NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (descuento >= 0),
  total                  NUMERIC(10,2) NOT NULL CHECK (total >= 0),
  anticipo               NUMERIC(10,2) NOT NULL CHECK (anticipo >= 0),
  estado                 VARCHAR(15) NOT NULL DEFAULT 'activa'
                           CHECK (estado IN ('activa', 'entregada', 'cancelada')),
  -- Versión de la especificación de producción. Sube solo cuando
  -- cambia algo que hornos o decoración necesitan saber.
  version                INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  tomado_por             INTEGER NOT NULL REFERENCES core.tblusuarios(id),
  entregada_at           TIMESTAMPTZ,
  entregada_por          INTEGER REFERENCES core.tblusuarios(id),
  saldo_cobrado          NUMERIC(10,2) CHECK (saldo_cobrado >= 0),
  cancelada_at           TIMESTAMPTZ,
  cancelada_por          INTEGER REFERENCES core.tblusuarios(id),
  motivo_cancelacion     VARCHAR(300),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_comanda_anticipo CHECK (anticipo <= total)
);

CREATE INDEX IF NOT EXISTS idx_comandas_agenda ON core.tblcomandas (estado, fecha_entrega, hora_entrega);
CREATE INDEX IF NOT EXISTS idx_comandas_cliente ON core.tblcomandas (LOWER(cliente_nombre));

-- 5) Líneas: un pastel personalizado o un producto del catálogo
CREATE TABLE IF NOT EXISTS core.tblcomanda_items (
  id               SERIAL PRIMARY KEY,
  comanda_id       INTEGER NOT NULL REFERENCES core.tblcomandas(id) ON DELETE CASCADE,
  orden            SMALLINT NOT NULL DEFAULT 0,
  tipo             VARCHAR(10) NOT NULL CHECK (tipo IN ('pastel', 'producto')),
  -- Producto del catálogo (entra tal cual)
  producto_id      INTEGER REFERENCES core.tblproductos(id) ON DELETE SET NULL,
  nombre           VARCHAR(200) NOT NULL,
  tamano_catalogo  VARCHAR(10) CHECK (tamano_catalogo IN ('chico', 'grande')),
  indicaciones     VARCHAR(500),
  -- Pastel personalizado (texto de la opción elegida al capturar)
  sabor            VARCHAR(80),
  tamano           VARCHAR(80),
  forma            VARCHAR(80),
  num_pisos        SMALLINT CHECK (num_pisos BETWEEN 1 AND 6),
  decoracion       VARCHAR(80),
  color_fondo      VARCHAR(120),
  leyenda          VARCHAR(200),
  descripcion      TEXT,
  insumos          VARCHAR(500),
  cantidad         INTEGER NOT NULL CHECK (cantidad > 0),
  precio_unitario  NUMERIC(10,2) NOT NULL CHECK (precio_unitario >= 0),
  subtotal         NUMERIC(10,2) NOT NULL CHECK (subtotal >= 0),
  CONSTRAINT chk_item_pastel_completo CHECK (
    tipo = 'producto'
    OR (sabor IS NOT NULL AND tamano IS NOT NULL AND forma IS NOT NULL
        AND num_pisos IS NOT NULL AND decoracion IS NOT NULL)
  ),
  CONSTRAINT chk_item_producto_ref CHECK (tipo = 'pastel' OR tamano_catalogo IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_comanda_items_comanda ON core.tblcomanda_items (comanda_id, orden);

-- 6) Imágenes de referencia (Cloudinary). Al quitar una imagen de la
--    comanda no se borra de Cloudinary: las versiones anteriores la
--    siguen citando en su historial.
CREATE TABLE IF NOT EXISTS core.tblcomanda_imagenes (
  id          SERIAL PRIMARY KEY,
  comanda_id  INTEGER NOT NULL REFERENCES core.tblcomandas(id) ON DELETE CASCADE,
  url         VARCHAR(500) NOT NULL,
  public_id   VARCHAR(255),
  orden       SMALLINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comanda_imagenes_comanda ON core.tblcomanda_imagenes (comanda_id, orden);

-- 7) "Enterado" de hornos y decoración, ligado a la versión que vieron
CREATE TABLE IF NOT EXISTS core.tblcomanda_confirmaciones (
  id          SERIAL PRIMARY KEY,
  comanda_id  INTEGER NOT NULL REFERENCES core.tblcomandas(id),
  area        VARCHAR(12) NOT NULL CHECK (area IN ('hornos', 'decoracion')),
  version     INTEGER NOT NULL,
  usuario_id  INTEGER NOT NULL REFERENCES core.tblusuarios(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_confirmacion_area_version UNIQUE (comanda_id, area, version)
);

-- 8) Historial: quién hizo qué y cuándo. Cuando nace una versión de
--    producción se guarda su contenido completo (snapshot), así se
--    puede mostrar exactamente qué confirmó cada quien.
CREATE TABLE IF NOT EXISTS core.tblcomanda_historial (
  id          SERIAL PRIMARY KEY,
  comanda_id  INTEGER NOT NULL REFERENCES core.tblcomandas(id),
  version     INTEGER NOT NULL,
  evento      VARCHAR(20) NOT NULL
                CHECK (evento IN ('creada', 'modificada', 'cancelada', 'entregada')),
  usuario_id  INTEGER NOT NULL REFERENCES core.tblusuarios(id),
  cambios     JSONB,
  snapshot    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comanda_historial_comanda ON core.tblcomanda_historial (comanda_id, created_at);

-- 9) Confirmaciones e historial son de solo inserción: ni la app ni
--    un error de programación pueden borrar o alterar una firma.
CREATE OR REPLACE FUNCTION core.fn_registro_inmutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'El registro de % no se puede % (es inmutable)', TG_TABLE_NAME, LOWER(TG_OP);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_confirmaciones_inmutables ON core.tblcomanda_confirmaciones;
CREATE TRIGGER trg_confirmaciones_inmutables
  BEFORE UPDATE OR DELETE ON core.tblcomanda_confirmaciones
  FOR EACH ROW EXECUTE FUNCTION core.fn_registro_inmutable();

DROP TRIGGER IF EXISTS trg_historial_inmutable ON core.tblcomanda_historial;
CREATE TRIGGER trg_historial_inmutable
  BEFORE UPDATE OR DELETE ON core.tblcomanda_historial
  FOR EACH ROW EXECUTE FUNCTION core.fn_registro_inmutable();

-- TRUNCATE no dispara los triggers por fila: se bloquea aparte, por
-- sentencia (también aplica a un TRUNCATE ... CASCADE desde comandas).
DROP TRIGGER IF EXISTS trg_confirmaciones_sin_truncate ON core.tblcomanda_confirmaciones;
CREATE TRIGGER trg_confirmaciones_sin_truncate
  BEFORE TRUNCATE ON core.tblcomanda_confirmaciones
  FOR EACH STATEMENT EXECUTE FUNCTION core.fn_registro_inmutable();

DROP TRIGGER IF EXISTS trg_historial_sin_truncate ON core.tblcomanda_historial;
CREATE TRIGGER trg_historial_sin_truncate
  BEFORE TRUNCATE ON core.tblcomanda_historial
  FOR EACH STATEMENT EXECUTE FUNCTION core.fn_registro_inmutable();

-- 10) updated_at automático, igual que el resto de las tablas
DROP TRIGGER IF EXISTS trg_updated_at_comandas ON core.tblcomandas;
CREATE TRIGGER trg_updated_at_comandas
  BEFORE UPDATE ON core.tblcomandas
  FOR EACH ROW EXECUTE FUNCTION core.fn_actualizar_updated_at();

DROP TRIGGER IF EXISTS trg_updated_at_comanda_opciones ON core.tblcomanda_opciones;
CREATE TRIGGER trg_updated_at_comanda_opciones
  BEFORE UPDATE ON core.tblcomanda_opciones
  FOR EACH ROW EXECUTE FUNCTION core.fn_actualizar_updated_at();

-- 11) Valores iniciales que dio la dueña (editables desde el panel)
INSERT INTO core.tblcomanda_opciones (tipo, nombre, orden)
SELECT v.tipo, v.nombre, v.orden
FROM (VALUES
  ('tamano', '12 personas', 1), ('tamano', '25 personas', 2), ('tamano', '35 personas', 3),
  ('tamano', '50 personas', 4), ('tamano', '70 personas', 5),
  ('sabor', 'Doble chocolate', 1), ('sabor', 'Tres leches', 2),
  ('sabor', 'Tradicional fresas con crema', 3), ('sabor', 'Zanahoria', 4),
  ('sabor', 'Dulce de leche', 5),
  ('forma', 'Circular', 1), ('forma', 'Rectangular', 2), ('forma', 'Plancha', 3),
  ('decoracion', 'Sencilla', 1), ('decoracion', 'Elaborada', 2),
  ('decoracion', 'Oblea', 3), ('decoracion', 'Especial', 4)
) AS v(tipo, nombre, orden)
WHERE NOT EXISTS (
  SELECT 1 FROM core.tblcomanda_opciones o
  WHERE o.tipo = v.tipo AND LOWER(o.nombre) = LOWER(v.nombre) AND o.activo
);

-- 12) Ajustes del módulo (anticipo mínimo y umbrales del semáforo)
INSERT INTO core.tblconfiguracion_sistema (seccion, clave, valor)
SELECT 'comandas', v.clave, v.valor::jsonb
FROM (VALUES
  ('anticipo_minimo_pct', '20'),
  ('dias_anticipacion_minima', '3'),
  ('semaforo_rojo_dias', '1'),
  ('semaforo_naranja_dias', '3'),
  ('semaforo_amarillo_dias', '7')
) AS v(clave, valor)
WHERE NOT EXISTS (
  SELECT 1 FROM core.tblconfiguracion_sistema c
  WHERE c.seccion = 'comandas' AND c.clave = v.clave
);
