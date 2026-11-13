import { Module } from '@nestjs/common';
import { FraudMetrics } from './fraud-metrics';
import { MetricsService } from './metrics.service';

@Module({
  providers: [MetricsService, FraudMetrics],
  exports: [MetricsService, FraudMetrics],
})
export class MetricsModule {}
