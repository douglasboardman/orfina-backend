import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { SystemAdminGuard } from './system-admin.guard';
import { PrismaService } from '../prisma/prisma.service';

@Module({ controllers: [AdminController], providers: [AdminService, SystemAdminGuard, PrismaService], exports: [SystemAdminGuard] })
export class IdentityModule {}
