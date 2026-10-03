import { Controller, Get } from '@nestjs/common';

/** Public on purpose: it exposes release metadata only, never deployment configuration. */
@Controller('version')
export class VersionController {
  @Get()
  getVersion() {
    return {
      version: process.env.npm_package_version ?? '0.3.0',
      ...(process.env.BUILD_ID ? { build: process.env.BUILD_ID } : {}),
    };
  }
}
