import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { GeoDatabase } from './entities/geo-database.entity';
import { LoginContext } from './entities/login-context.entity';
import { readGeoConfig } from './geo-config';
import { GEO_CONFIG, GeoService } from './geo.service';
import { InternalLoginsController } from './internal-logins.controller';
import { LoginContextsService } from './login-contexts.service';

const GEO_KEYS = [
  'MAXMIND_ACCOUNT_ID',
  'MAXMIND_LICENSE_KEY',
  'FRAUD_IP_HASH_SECRET',
  'FRAUD_GEO_NEW_COUNTRY_POINTS',
  'FRAUD_GEO_IMPOSSIBLE_TRAVEL_POINTS',
  'FRAUD_GEO_TOR_POINTS',
  'FRAUD_GEO_TRAVEL_WINDOW_MIN',
  'FRAUD_GEO_SESSION_HOURS',
  'FRAUD_GEO_RETENTION_DAYS',
  'GEO_AUTO_UPDATE',
];

/** Geolocalización por IP de los inicios de sesión (GeoLite2 local + nodos de Tor). */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([GeoDatabase, LoginContext])],
  controllers: [InternalLoginsController],
  providers: [
    {
      provide: GEO_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        readGeoConfig(Object.fromEntries(GEO_KEYS.map((key) => [key, config.get<string>(key)]))),
    },
    GeoService,
    LoginContextsService,
    InternalKeyGuard,
  ],
  exports: [GeoService, LoginContextsService],
})
export class GeoModule {}
