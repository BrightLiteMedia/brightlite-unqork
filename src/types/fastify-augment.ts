// src/types/fastify-augment.ts
// Extends Fastify's request type so every route handler gets a typed clientConfig.
// The preHandler hook in server.ts populates this on every request.

import { ClientConfig } from './index'

declare module 'fastify' {
  interface FastifyRequest {
    clientConfig: ClientConfig
  }
}
