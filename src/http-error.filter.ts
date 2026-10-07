import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import { FastifyReply } from 'fastify';
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (error instanceof ZodError) return reply.code(422).send({ statusCode: 422, code: 'VALIDATION_ERROR', message: 'Confira os campos informados.',
      issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
    if (error instanceof HttpException) return reply.code(error.getStatus()).send(error.getResponse());
    return reply.code(500).send({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Não foi possível concluir a operação.' });
  }
}
