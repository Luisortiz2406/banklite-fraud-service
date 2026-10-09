import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export class AdminFlagsQueryDto {
  @IsOptional() @IsIn(['pending', 'confirmed', 'dismissed']) status?: string;
  @IsOptional() @IsUUID() accountId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class ResolveFlagDto {
  @IsIn(['confirmed', 'dismissed']) status: 'confirmed' | 'dismissed';
  @IsString() @MinLength(5, { message: 'Escribe el motivo (mínimo 5 caracteres).' }) @MaxLength(300) note: string;
}

export class AuditQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}
