import { AdminAudit } from './common/staff/admin-audit.entity';
import { FraudOutbox } from './events/fraud-outbox.entity';
import { GeoDatabase } from './geo/entities/geo-database.entity';
import { LoginContext } from './geo/entities/login-context.entity';
import { FlaggedTransaction } from './risk/entities/flagged-transaction.entity';
import { FraudTransactionLog } from './risk/entities/fraud-transaction-log.entity';
import { RiskScore } from './risk/entities/risk-score.entity';

/**
 * Todas las tablas de fraud_db. La usan TypeORM al arrancar y
 * scripts/verificar-esquema.js (CI), que comprueba que database/schema.sql y
 * database/backup.sql crean exactamente estas tablas.
 */
export const ENTITIES = [
  FraudTransactionLog,
  RiskScore,
  FlaggedTransaction,
  FraudOutbox,
  AdminAudit,
  GeoDatabase,
  LoginContext,
];
