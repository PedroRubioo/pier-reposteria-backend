-- ============================================================
-- 008 · Fechas especiales (festividades del negocio)
--
-- Alimenta el modelo de predicción de demanda y el calendario
-- administrativo de Dirección General. Un festivo LARGO se guarda
-- como un RANGO: una fila por día con el mismo nombre y color
-- (p. ej. Xantolo = 31-oct, 1-nov y 2-nov), así la dueña puede
-- extenderlo a la semana completa pintando más días.
-- ============================================================

CREATE TABLE IF NOT EXISTS core.tblfechas_especiales (
  id                 SERIAL PRIMARY KEY,
  fecha              DATE NOT NULL,
  nombre             VARCHAR(60) NOT NULL,
  color              VARCHAR(9),
  dias_anticipacion  INTEGER NOT NULL DEFAULT 3,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Un solo registro por día: pintar dos veces el mismo día actualiza, no duplica
CREATE UNIQUE INDEX IF NOT EXISTS idx_fechas_especiales_fecha
  ON core.tblfechas_especiales (fecha);

CREATE INDEX IF NOT EXISTS idx_fechas_especiales_nombre
  ON core.tblfechas_especiales (nombre);

-- ── Semilla: ciclo completo agosto 2026 → diciembre 2027 ──
-- (las festividades móviles ya vienen con su fecha real de cada año:
--  Día del Padre = tercer domingo de junio)
INSERT INTO core.tblfechas_especiales (fecha, nombre, color, dias_anticipacion) VALUES
  -- 2026
  ('2026-10-31', 'Xantolo',              '#8B5E3C', 5),
  ('2026-11-01', 'Xantolo',              '#8B5E3C', 5),
  ('2026-11-02', 'Xantolo',              '#8B5E3C', 5),
  ('2026-12-12', 'Virgen de Guadalupe',  '#C9A227', 3),
  ('2026-12-24', 'Nochebuena',           '#B3352E', 5),
  ('2026-12-25', 'Navidad',              '#B3352E', 5),
  ('2026-12-31', 'Fin de año',           '#6B7C3E', 3),
  -- 2027
  ('2027-01-01', 'Año Nuevo',            '#6B7C3E', 3),
  ('2027-01-06', 'Día de Reyes',         '#D4A574', 5),
  ('2027-02-14', 'San Valentín',         '#D06A88', 5),
  ('2027-04-30', 'Día del Niño',         '#4E9AC7', 3),
  ('2027-05-10', 'Día de las Madres',    '#D06A88', 7),
  ('2027-06-20', 'Día del Padre',        '#4E7A8C', 5),
  ('2027-10-31', 'Xantolo',              '#8B5E3C', 5),
  ('2027-11-01', 'Xantolo',              '#8B5E3C', 5),
  ('2027-11-02', 'Xantolo',              '#8B5E3C', 5),
  ('2027-12-12', 'Virgen de Guadalupe',  '#C9A227', 3),
  ('2027-12-24', 'Nochebuena',           '#B3352E', 5),
  ('2027-12-25', 'Navidad',              '#B3352E', 5),
  ('2027-12-31', 'Fin de año',           '#6B7C3E', 3)
ON CONFLICT (fecha) DO NOTHING;
