import { randomUUID } from 'crypto';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { InternalLoginsController } from '../geo/internal-logins.controller';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { FlaggedTransaction } from './entities/flagged-transaction.entity';
import { InternalRiskController } from './internal-risk.controller';

const asAccount = { internalCaller: 'account' } as never;

describeWithDb('Resumen de alertas para cancelar la cuenta (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let repo: Repository<FlaggedTransaction>;
  let controller: InternalRiskController;

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('fraud_cierre', [FlaggedTransaction]));
    repo = dataSource.getRepository(FlaggedTransaction);
    controller = new InternalRiskController(repo);
  });
  afterAll(() => drop?.());
  beforeEach(() => truncateAll(dataSource));

  const flag = (idUser: string, status: 'pending' | 'confirmed' | 'dismissed') =>
    repo.save(
      repo.create({
        transactionId: randomUUID(),
        accountId: randomUUID(),
        idUser,
        score: 90,
        reason: 'Prueba',
        status,
      }),
    );

  it('sin alertas: nada impide cancelar', async () => {
    expect(await controller.resumenCierre(randomUUID(), asAccount)).toEqual({
      alertasAbiertas: 0,
      sinPendientes: true,
    });
  });

  it('solo las alertas pendientes del cliente impiden cancelar', async () => {
    const user = randomUUID();
    await flag(user, 'pending');
    await flag(user, 'pending');
    await flag(user, 'confirmed');
    await flag(user, 'dismissed');
    await flag(randomUUID(), 'pending'); // otro cliente
    expect(await controller.resumenCierre(user, asAccount)).toEqual({ alertasAbiertas: 2, sinPendientes: false });
  });

  it('con alertas ya resueltas (confirmadas o descartadas) puede cancelar', async () => {
    const user = randomUUID();
    await flag(user, 'confirmed');
    await flag(user, 'dismissed');
    expect((await controller.resumenCierre(user, asAccount)).sinPendientes).toBe(true);
  });
});

describe('Permisos: auth y account confían en fraud, cada uno solo en lo suyo', () => {
  const AUTH_KEY = 'a1'.repeat(32);
  const ACCOUNT_KEY = 'b2'.repeat(32);
  const guard = new InternalKeyGuard(
    new ConfigService({ INTERNAL_TRUSTED_KEYS: `auth:${AUTH_KEY},account:${ACCOUNT_KEY}` }),
  );
  const ctx = (key?: string) => {
    const request: any = { headers: key ? { 'x-internal-key': key } : {}, body: {} };
    return { request, context: { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext };
  };

  it('sin clave o desconocida: 401', () => {
    expect(() => guard.canActivate(ctx().context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctx('c3'.repeat(32)).context)).toThrow(UnauthorizedException);
  });

  it('auth no puede pedir el resumen de cierre (403)', async () => {
    const auth = ctx(AUTH_KEY);
    expect(guard.canActivate(auth.context)).toBe(true);
    await expect(
      new InternalRiskController({} as never).resumenCierre(randomUUID(), auth.request),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('account no puede reportar inicios de sesión (403)', async () => {
    const account = ctx(ACCOUNT_KEY);
    expect(guard.canActivate(account.context)).toBe(true);
    const logins = { record: jest.fn() };
    await expect(
      new InternalLoginsController(logins as never).report(
        { idUser: randomUUID(), ip: '190.60.37.10', outcome: 'success' },
        account.request,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(logins.record).not.toHaveBeenCalled();
  });
});
