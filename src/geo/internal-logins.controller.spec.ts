import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { InternalLoginsController } from './internal-logins.controller';
import { LoginContextsService } from './login-contexts.service';
import request = require('supertest');

const AUTH_KEY = 'a1'.repeat(32);
const CARD_KEY = 'b2'.repeat(32);
const body = { idUser: '11111111-1111-4111-8111-111111111111', ip: '190.60.37.10', outcome: 'success' };

describe('POST /internal/fraud/logins', () => {
  let app: INestApplication;
  const logins = { record: jest.fn().mockResolvedValue({ stored: true, rules: [] }) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InternalLoginsController],
      providers: [
        InternalKeyGuard,
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) => (k === 'INTERNAL_TRUSTED_KEYS' ? `auth:${AUTH_KEY},card:${CARD_KEY}` : undefined),
          },
        },
        { provide: LoginContextsService, useValue: logins },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  const post = (key?: string, payload: object = body) => {
    const req = request(app.getHttpServer()).post('/internal/fraud/logins').send(payload);
    return key ? req.set('x-internal-key', key) : req;
  };

  it('auth-service puede reportar (202) y la respuesta no devuelve la IP', async () => {
    const res = await post(AUTH_KEY).expect(202);
    expect(res.body).toEqual({ stored: true });
    expect(logins.record).toHaveBeenCalledWith(expect.objectContaining({ ip: '190.60.37.10', outcome: 'success' }));
  });

  it('sin clave o con clave inválida: 401', async () => {
    await post().expect(401);
    await post('c3'.repeat(32)).expect(401);
    expect(logins.record).not.toHaveBeenCalled();
  });

  it('otro servicio con clave válida (card) no puede: 403', async () => {
    await post(CARD_KEY).expect(403);
    expect(logins.record).not.toHaveBeenCalled();
  });

  it('valida la IP y el resultado', async () => {
    await post(AUTH_KEY, { ...body, ip: 'no-es-ip' }).expect(400);
    await post(AUTH_KEY, { ...body, outcome: 'otro' }).expect(400);
  });
});
