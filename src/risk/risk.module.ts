import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminFraudController } from '../admin/admin-fraud.controller';
import { AdminFraudService } from '../admin/admin-fraud.service';
import { AdminAudit } from '../common/staff/admin-audit.entity';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { StaffAuthGuard } from '../common/staff/staff-auth.guard';
import { EventConsumerService } from '../events/event-consumer.service';
import { EventPublisherService } from '../events/event-publisher.service';
import { FraudOutbox } from '../events/fraud-outbox.entity';
import { OutboxService } from '../events/outbox.service';
import { FlaggedTransaction } from './entities/flagged-transaction.entity';
import { FraudTransactionLog } from './entities/fraud-transaction-log.entity';
import { RiskScore } from './entities/risk-score.entity';
import { RiskScoringService } from './risk-scoring.service';
import { InternalRiskController } from './internal-risk.controller';

@Module({
  imports: [
    ConfigModule,
    JwtModule.register({}),
    TypeOrmModule.forFeature([FraudTransactionLog, RiskScore, FlaggedTransaction, FraudOutbox, AdminAudit]),
  ],
  controllers: [AdminFraudController, InternalRiskController],
  providers: [
    RiskScoringService,
    EventConsumerService,
    EventPublisherService,
    OutboxService,
    AdminFraudService,
    AdminAuditService,
    StaffAuthGuard,
    InternalKeyGuard,
  ],
})
export class RiskModule {}
