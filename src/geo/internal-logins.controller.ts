import { Body, Controller, ForbiddenException, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsIP, IsOptional, IsUUID } from 'class-validator';
import { Request } from 'express';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { LoginOutcome } from './entities/login-context.entity';
import { LoginContextsService } from './login-contexts.service';

export class LoginReportDto {
  @IsUUID()
  idUser: string;

  @IsOptional()
  @IsUUID()
  sessionId?: string;

  @IsIP()
  ip: string;

  @IsIn(['success', 'failed'])
  outcome: LoginOutcome;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  occurredAt?: Date;
}

/** Inicios de sesión que reporta auth-service (red interna, clave propia de auth). */
@Controller('internal/fraud')
@UseGuards(InternalKeyGuard)
export class InternalLoginsController {
  constructor(private readonly logins: LoginContextsService) {}

  @Post('logins')
  @HttpCode(202)
  async report(@Body() dto: LoginReportDto, @Req() request: Request) {
    if ((request as any).internalCaller !== 'auth') {
      throw new ForbiddenException('Solo auth-service puede reportar inicios de sesión.');
    }
    const { stored } = await this.logins.record(dto);
    return { stored };
  }
}
