import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffAuthGuard, StaffRoles } from '../common/staff/staff-auth.guard';
import { EventConsumerService } from '../events/event-consumer.service';
import { AdminFraudService } from './admin-fraud.service';
import { AdminFlagsQueryDto, AuditQueryDto, ResolveFlagDto } from './admin.dto';

/** Panel administrativo de Fraud Service: revisión manual de transacciones marcadas por el motor de reglas. */
@Controller('fraud/admin')
@UseGuards(StaffAuthGuard)
export class AdminFraudController {
  constructor(
    private readonly admin: AdminFraudService,
    private readonly audit: AdminAuditService,
    private readonly consumer: EventConsumerService,
  ) {}

  @Get('flags')
  list(@Query() q: AdminFlagsQueryDto) {
    return this.admin.list(q.status, q.accountId, q.page ?? 1, q.limit ?? 25);
  }

  @Get('flags/:id')
  detail(@Param('id') id: string) {
    return this.admin.detail(id);
  }

  @Patch('flags/:id')
  @StaffRoles('admin')
  resolve(@Param('id') id: string, @Body() dto: ResolveFlagDto, @Req() req: any) {
    return this.admin.resolve(id, dto.status, dto.note, req.staff);
  }

  @Get('audit')
  auditLog(@Query() q: AuditQueryDto) {
    return this.audit.list(q.page ?? 1, q.limit ?? 50, q.q);
  }

  @Get('dlq')
  dlq() {
    return this.consumer.deadLetterStats();
  }

  @Get('dlq/messages')
  async dlqMessages() {
    try {
      return await this.consumer.peekDeadLetters(20);
    } catch (e) {
      throw new ServiceUnavailableException((e as Error).message);
    }
  }

  @Post('dlq/requeue')
  @HttpCode(200)
  @StaffRoles('admin')
  async requeue(@Req() req: any) {
    try {
      const result = await this.consumer.requeueDeadLetters(100);
      await this.audit.record(req.staff, {
        action: 'dlq.requeue',
        targetType: 'queue',
        targetId: 'fraud-service',
        details: result,
      });
      return result;
    } catch (e) {
      throw new ServiceUnavailableException((e as Error).message);
    }
  }
}
