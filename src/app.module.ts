import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminAudit } from './common/staff/admin-audit.entity';
import { FraudOutbox } from './events/fraud-outbox.entity';
import { FlaggedTransaction } from './risk/entities/flagged-transaction.entity';
import { FraudTransactionLog } from './risk/entities/fraud-transaction-log.entity';
import { RiskScore } from './risk/entities/risk-score.entity';
import { RiskModule } from './risk/risk.module';
import { HealthController } from './health.controller';
import { validateEnv } from './config/env.validation';
import { GeoDatabase } from './geo/entities/geo-database.entity';
import { LoginContext } from './geo/entities/login-context.entity';
import { readGeoConfig } from './geo/geo-config';
import { GeoModule } from './geo/geo.module';
import { MetricsModule } from './metrics/metrics.module';

const validateCommon = validateEnv(
  [
    { key: 'STAFF_JWT_SECRET', type: 'secret' },
    { key: 'DATABASE_URL', type: 'url' },
    { key: 'RABBITMQ_URL', type: 'url', optional: true },
    // Quién puede reportar inicios de sesión (POST /internal/fraud/logins): "auth:<clave>".
    { key: 'INTERNAL_TRUSTED_KEYS', type: 'trusted-keys', optional: true },
  ],
  ['STAFF_JWT_SECRET', 'FRAUD_IP_HASH_SECRET'],
);

@Module({
  imports: [
    MetricsModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      // Secretos comunes y, de la geolocalización, solo que FRAUD_IP_HASH_SECRET no
      // sea débil: sin llaves de MaxMind el servicio arranca con la geo degradada.
      validate: (config) => {
        const validated = validateCommon(config);
        readGeoConfig(validated);
        return validated;
      },
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('DATABASE_URL'),
        entities: [
          FraudTransactionLog,
          RiskScore,
          FlaggedTransaction,
          FraudOutbox,
          AdminAudit,
          GeoDatabase,
          LoginContext,
        ],
        synchronize: true,
        logging: false,
      }),
    }),
    GeoModule,
    RiskModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
