import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffPrincipal } from '../common/staff/staff-auth.guard';
import { FlaggedStatus, FlaggedTransaction } from '../risk/entities/flagged-transaction.entity';
import { RiskScore } from '../risk/entities/risk-score.entity';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Transacciones marcadas por el motor de reglas, vistas desde el panel. */
@Injectable()
export class AdminFraudService {
  constructor(
    @InjectRepository(FlaggedTransaction) private readonly flags: Repository<FlaggedTransaction>,
    @InjectRepository(RiskScore) private readonly scores: Repository<RiskScore>,
    private readonly audit: AdminAuditService,
  ) {}

  async list(status?: string, accountId?: string, page = 1, limit = 25) {
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (accountId) where.accountId = accountId;
    const [items, total] = await this.flags.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, page, limit };
  }

  async detail(id: string) {
    const flag = await this.find(id);
    const score = await this.scores.findOne({
      where: { transactionId: flag.transactionId, accountId: flag.accountId },
    });
    return { ...flag, rulesTriggered: score?.rulesTriggered ?? [] };
  }

  async resolve(id: string, status: Exclude<FlaggedStatus, 'pending'>, note: string, actor: StaffPrincipal) {
    const flag = await this.find(id);
    if (flag.status !== 'pending') {
      throw new BadRequestException(`Esta alerta ya fue resuelta (estado actual: '${flag.status}').`);
    }
    flag.status = status;
    flag.reviewedBy = actor.username;
    flag.resolutionNote = note;
    flag.reviewedAt = new Date();
    await this.flags.manager.transaction(async (manager) => {
      await manager.save(flag);
      await this.audit.record(
        actor,
        {
          action: `fraud.${status}`,
          targetType: 'flagged_transaction',
          targetId: id,
          reason: note,
          details: { transactionId: flag.transactionId, accountId: flag.accountId, score: flag.score },
        },
        manager,
      );
    });
    return flag;
  }

  private async find(id: string) {
    const flag = UUID.test(id) ? await this.flags.findOne({ where: { id } }) : null;
    if (!flag) throw new NotFoundException('Alerta no encontrada.');
    return flag;
  }
}
