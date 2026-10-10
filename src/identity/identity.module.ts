import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { SystemAdminGuard } from './system-admin.guard';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AdminController],
  providers: [AdminService, SystemAdminGuard],
  exports: [SystemAdminGuard],
})
export class IdentityModule {}
