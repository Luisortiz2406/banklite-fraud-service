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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv(
        [
          { key: 'STAFF_JWT_SECRET', type: 'secret' },
          { key: 'DATABASE_URL', type: 'url' },
          { key: 'RABBITMQ_URL', type: 'url', optional: true },
        ],
        [],
      ),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('DATABASE_URL'),
        entities: [FraudTransactionLog, RiskScore, FlaggedTransaction, FraudOutbox, AdminAudit],
        synchronize: true,
        logging: false,
      }),
    }),
    RiskModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
