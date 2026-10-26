import { Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { Repository } from 'typeorm';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { FlaggedTransaction } from './entities/flagged-transaction.entity';

/** Endpoints entre servicios (red interna, x-internal-key). El gateway responde 404 a /internal desde afuera. */
@Controller('internal/fraud')
@UseGuards(InternalKeyGuard)
export class InternalRiskController {
  constructor(@InjectRepository(FlaggedTransaction) private readonly flags: Repository<FlaggedTransaction>) {}

  /**
   * Lo que impediría cancelar la cuenta del cliente (solo account-service):
   * alertas de fraude todavía sin resolver por cumplimiento. Solo dice cuántas,
   * nunca el detalle (eso lo ven cumplimiento y administrador en el panel).
   */
  @Get('users/:idUser/resumen-cierre')
  async resumenCierre(@Param('idUser', ParseUUIDPipe) idUser: string, @Req() request: Request) {
    if ((request as any).internalCaller !== 'account') {
      throw new ForbiddenException('Solo account-service puede pedir este resumen.');
    }
    const alertasAbiertas = await this.flags.count({ where: { idUser, status: 'pending' } });
    return { alertasAbiertas, sinPendientes: alertasAbiertas === 0 };
  }
}
