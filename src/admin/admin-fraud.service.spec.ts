import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffPrincipal } from '../common/staff/staff-auth.guard';
import { FlaggedTransaction } from '../risk/entities/flagged-transaction.entity';
import { RiskScore } from '../risk/entities/risk-score.entity';
import { AdminFraudService } from './admin-fraud.service';

/**
 * Resolver una alerta de fraude: solo una vez, con nota, y queda en la auditoría en la
 * misma transacción de la base (si la auditoría falla, la alerta no cambia).
 */
const ID = '11111111-1111-4111-8111-111111111111';
const staff = { id: 'emp-1', username: 'laura', role: 'compliance', docHash: null, issuedAt: null } as StaffPrincipal;

describe('AdminFraudService', () => {
  const manager = { save: jest.fn(async (row: unknown) => row) };
  const flags = {
    findAndCount: jest.fn(),
    findOne: jest.fn(),
    manager: { transaction: jest.fn(async (work: (m: typeof manager) => Promise<void>) => work(manager)) },
  };
  const scores = { findOne: jest.fn() };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminFraudService(
    flags as unknown as Repository<FlaggedTransaction>,
    scores as unknown as Repository<RiskScore>,
    audit as unknown as AdminAuditService,
  );
  const pending = () => ({ id: ID, transactionId: 'tx-1', accountId: 'acc-1', score: 85, status: 'pending' });

  beforeEach(() => {
    jest.clearAllMocks();
    flags.findOne.mockResolvedValue(pending());
  });

  it('lista con filtros por estado y cuenta, paginada y de la más reciente a la más antigua', async () => {
    flags.findAndCount.mockResolvedValue([[pending()], 1]);

    expect(await service.list('pending', 'acc-1', 2, 10)).toMatchObject({ total: 1, page: 2, limit: 10 });
    expect(flags.findAndCount).toHaveBeenCalledWith({
      where: { status: 'pending', accountId: 'acc-1' },
      order: { createdAt: 'DESC' },
      skip: 10,
      take: 10,
    });
    await service.list();
    expect(flags.findAndCount).toHaveBeenLastCalledWith(expect.objectContaining({ where: {}, skip: 0, take: 25 }));
  });

  it('el detalle trae las reglas que dispararon el puntaje (o ninguna si no hay)', async () => {
    scores.findOne.mockResolvedValueOnce({ rulesTriggered: [{ rule: 'high_amount', points: 40 }] });
    expect((await service.detail(ID)).rulesTriggered).toEqual([{ rule: 'high_amount', points: 40 }]);

    scores.findOne.mockResolvedValueOnce(null);
    expect((await service.detail(ID)).rulesTriggered).toEqual([]);
  });

  it('un id mal formado o inexistente da 404', async () => {
    await expect(service.detail('no-es-uuid')).rejects.toBeInstanceOf(NotFoundException);
    expect(flags.findOne).not.toHaveBeenCalled();

    flags.findOne.mockResolvedValueOnce(null);
    await expect(service.resolve(ID, 'confirmed', 'nota', staff)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('confirmar o descartar guarda quién, cuándo y por qué, y lo deja en la auditoría en la misma transacción', async () => {
    const resolved = await service.resolve(ID, 'confirmed', 'Cliente confirmó el fraude', staff);

    expect(resolved).toMatchObject({
      status: 'confirmed',
      reviewedBy: 'laura',
      resolutionNote: 'Cliente confirmó el fraude',
    });
    expect(resolved.reviewedAt).toBeInstanceOf(Date);
    expect(flags.manager.transaction).toHaveBeenCalledTimes(1);
    expect(manager.save).toHaveBeenCalledWith(resolved);
    expect(audit.record).toHaveBeenCalledWith(
      staff,
      expect.objectContaining({
        action: 'fraud.confirmed',
        targetType: 'flagged_transaction',
        targetId: ID,
        reason: 'Cliente confirmó el fraude',
        details: { transactionId: 'tx-1', accountId: 'acc-1', score: 85 },
      }),
      manager,
    );

    flags.findOne.mockResolvedValueOnce(pending());
    expect((await service.resolve(ID, 'dismissed', 'Falsa alarma', staff)).status).toBe('dismissed');
  });

  it('una alerta ya resuelta no se vuelve a resolver y no deja otra auditoría', async () => {
    flags.findOne.mockResolvedValue({ ...pending(), status: 'dismissed' });

    await expect(service.resolve(ID, 'confirmed', 'tarde', staff)).rejects.toThrow("estado actual: 'dismissed'");
    await expect(service.resolve(ID, 'confirmed', 'tarde', staff)).rejects.toBeInstanceOf(BadRequestException);

    expect(flags.manager.transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
