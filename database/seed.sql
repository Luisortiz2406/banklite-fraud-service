-- Datos de ejemplo de fraud_db (fraud-service). Escenario de demo compartido por todos
-- los microservicios (mismos UUID): Ana Pérez y Carlos Gómez, clientes de prueba,
-- y una cuenta de comercio. Datos inventados: no son personas ni documentos reales.
-- Cargar después del esquema:  psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
-- (si la base ya tiene estas filas, ON CONFLICT DO NOTHING las deja como están)

BEGIN;
-- Una alerta pendiente para revisar en el panel (Fraude) con el rol Cumplimiento.
INSERT INTO public.fraud_transaction_log (id, transaction_id, account_id, id_user, type, direction, amount, currency, occurred_at) VALUES
  ('43000000-0000-4000-8000-000000000012', '7b000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'deposit', 'in', 1000000, 'COP', '2026-10-01 10:00:00-05'),
  ('43000000-0000-4000-8000-000000000021', '7b000000-0000-4000-8000-000000000002', '3a000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'transfer', 'out', 150000, 'COP', '2026-10-02 10:00:00-05'),
  ('43000000-0000-4000-8000-000000000022', '7b000000-0000-4000-8000-000000000002', '3a000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'transfer', 'in', 150000, 'COP', '2026-10-02 10:00:00-05'),
  ('43000000-0000-4000-8000-000000000031', '7b000000-0000-4000-8000-000000000003', '3a000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'saving', 'out', 200000, 'COP', '2026-10-03 10:00:00-05'),
  ('43000000-0000-4000-8000-000000000041', '7b000000-0000-4000-8000-000000000004', '3a000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'payment', 'out', 85000, 'COP', '2026-10-04 10:00:00-05')
ON CONFLICT DO NOTHING;

INSERT INTO public.risk_scores (id, transaction_id, account_id, score, model_version, rules_triggered, created_at) VALUES
  ('43000000-0000-4000-8000-0000000000f1', '7b000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000001', 40, 'rules-v1', '[{"rule": "monto_alto", "points": 40, "detail": "Consignación de $1.000.000"}]', '2026-10-01 10:00:00-05')
ON CONFLICT DO NOTHING;

INSERT INTO public.flagged_transactions (id, transaction_id, account_id, id_user, score, reason, status, created_at) VALUES
  ('43000000-0000-4000-8000-0000000000e1', '7b000000-0000-4000-8000-000000000001', '3a000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 40, 'Monto alto para una cuenta nueva', 'pending', '2026-10-01 10:00:00-05')
ON CONFLICT DO NOTHING;

COMMIT;
