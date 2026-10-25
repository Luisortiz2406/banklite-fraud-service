import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
import { LoginContextsService } from '../geo/login-contexts.service';
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
    private readonly loginContexts: LoginContextsService,
  ) {}

  @Get('flags')
  @StaffRoles('compliance', 'admin')
  list(@Query() q: AdminFlagsQueryDto) {
    return this.admin.list(q.status, q.accountId, q.page ?? 1, q.limit ?? 25);
  }

  @Get('flags/:id')
  @StaffRoles('compliance', 'admin')
  detail(@Param('id') id: string) {
    return this.admin.detail(id);
  }

  @Patch('flags/:id')
  @StaffRoles('compliance', 'admin')
  resolve(@Param('id') id: string, @Body() dto: ResolveFlagDto, @Req() req: any) {
    return this.admin.resolve(id, dto.status, dto.note, req.staff);
  }

  /**
   * Inicios de sesión recientes de un cliente: país, red recortada (/24 o /48),
   * Tor y reglas geográficas. Nunca la IP completa ni su huella. Cada consulta
   * queda en la auditoría.
   */
  @Get('users/:idUser/logins')
  @StaffRoles('compliance', 'admin')
  async userLogins(@Param('idUser', ParseUUIDPipe) idUser: string, @Req() req: any) {
    const items = await this.loginContexts.listForUser(idUser);
    await this.audit.record(req.staff, {
      action: 'fraud.logins.view',
      targetType: 'user',
      targetId: idUser,
      details: { count: items.length },
    });
    return { items };
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
