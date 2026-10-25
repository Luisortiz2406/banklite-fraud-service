import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffAuthGuard, StaffRole } from '../common/staff/staff-auth.guard';
import { EventConsumerService } from '../events/event-consumer.service';
import { LoginContextsService } from '../geo/login-contexts.service';
import { AdminFraudController } from './admin-fraud.controller';
import { AdminFraudService } from './admin-fraud.service';
import request = require('supertest');

const SECRET = 'secreto-de-prueba-para-tokens-de-empleado-0123456789';
const FLAG_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

describe('Permisos del panel de fraude (403 por rol)', () => {
  let app: INestApplication;
  const jwt = new JwtService({});
  const admin = {
    list: jest.fn().mockResolvedValue({ items: [] }),
    detail: jest.fn().mockResolvedValue({ id: FLAG_ID }),
    resolve: jest.fn().mockResolvedValue({ id: FLAG_ID, status: 'dismissed' }),
  };
  const consumer = { deadLetterStats: jest.fn().mockResolvedValue({}) };
  const loginContexts = { listForUser: jest.fn().mockResolvedValue([{ country: 'CO', ipPrefix: '190.60.37.0/24' }]) };
  const audit = { list: jest.fn().mockResolvedValue({ items: [] }), record: jest.fn().mockResolvedValue(undefined) };

  const token = (role: StaffRole) =>
    `Bearer ${jwt.sign({ sub: `staff-${role}`, type: 'staff', role, username: role }, { secret: SECRET })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminFraudController],
      providers: [
        StaffAuthGuard,
        { provide: JwtService, useValue: jwt },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === 'STAFF_JWT_SECRET' ? SECRET : undefined) },
        },
        { provide: AdminFraudService, useValue: admin },
        { provide: AdminAuditService, useValue: audit },
        { provide: LoginContextsService, useValue: loginContexts },
        { provide: EventConsumerService, useValue: consumer },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  const resolveBody = { status: 'dismissed', note: 'Compra reconocida por el cliente' };

  it('Soporte NO ve las alertas (403)', async () => {
    await request(app.getHttpServer()).get('/fraud/admin/flags').set('Authorization', token('support')).expect(403);
    await request(app.getHttpServer())
      .get(`/fraud/admin/flags/${FLAG_ID}`)
      .set('Authorization', token('support'))
      .expect(403);
  });

  it('Soporte NO puede resolver una alerta (403)', async () => {
    await request(app.getHttpServer())
      .patch(`/fraud/admin/flags/${FLAG_ID}`)
      .set('Authorization', token('support'))
      .send(resolveBody)
      .expect(403);
    expect(admin.resolve).not.toHaveBeenCalled();
  });

  it.each<StaffRole>(['compliance', 'admin'])('%s puede ver y resolver alertas', async (role) => {
    await request(app.getHttpServer()).get('/fraud/admin/flags').set('Authorization', token(role)).expect(200);
    await request(app.getHttpServer())
      .patch(`/fraud/admin/flags/${FLAG_ID}`)
      .set('Authorization', token(role))
      .send(resolveBody)
      .expect(200);
    // El servicio recibe al empleado con su rol: así queda en la auditoría quién resolvió
    expect(admin.resolve).toHaveBeenCalledWith(
      FLAG_ID,
      'dismissed',
      resolveBody.note,
      expect.objectContaining({ role }),
    );
  });

  it('Soporte NO ve los inicios de sesión (país y red) de un cliente (403)', async () => {
    await request(app.getHttpServer())
      .get(`/fraud/admin/users/${USER_ID}/logins`)
      .set('Authorization', token('support'))
      .expect(403);
    expect(loginContexts.listForUser).not.toHaveBeenCalled();
  });

  it.each<StaffRole>(['compliance', 'admin'])('%s ve los inicios de sesión y queda en la auditoría', async (role) => {
    const res = await request(app.getHttpServer())
      .get(`/fraud/admin/users/${USER_ID}/logins`)
      .set('Authorization', token(role))
      .expect(200);
    expect(res.body.items[0]).toEqual({ country: 'CO', ipPrefix: '190.60.37.0/24' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ role }),
      expect.objectContaining({ action: 'fraud.logins.view', targetId: USER_ID }),
    );
  });

  it('Soporte sí ve el estado de la cola (Monitoreo)', async () => {
    await request(app.getHttpServer()).get('/fraud/admin/dlq').set('Authorization', token('support')).expect(200);
  });
});
