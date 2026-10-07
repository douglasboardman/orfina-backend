import { Controller, Get } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Both src/ (development) and dist/ (production) sit next to package.json.
const packageVersion = (JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string }).version;

/** Public on purpose: it exposes release metadata only, never deployment configuration. */
@Controller('version')
export class VersionController {
  @Get()
  getVersion() {
    return {
      version: packageVersion,
      ...(process.env.BUILD_ID ? { build: process.env.BUILD_ID } : {}),
    };
  }
}
