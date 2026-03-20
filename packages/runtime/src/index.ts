import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { registerRoutes } from './server/routes';
import { ProviderManager } from './providers/manager';

const fastify = Fastify({
  logger: true
});

const PORT = process.env.PORT || 3421;

const providerManager = new ProviderManager({
  ollama: {
    baseUrl: process.env.OLLAMA_HOST || 'http://localhost:11434'
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY
  },
  defaultToOpenRouter: true
});

async function start() {
  try {
    await providerManager.initialize();
    
    const status = providerManager.getStatus();
    console.log(`Provider status: ${status.primary} (primary)${status.fallback ? `, ${status.fallback} (fallback)` : ''}`);
    
    await registerRoutes(fastify, providerManager);
    
    await fastify.register(fastifyStatic, {
      root: path.join(__dirname, 'public'),
      prefix: '/',
    });
    
    fastify.setNotFoundHandler((request, reply) => {
      reply.sendFile('index.html');
    });
    
    await fastify.listen({ port: Number(PORT), host: '0.0.0.0' });
    console.log(`Atlas Runtime server running on http://localhost:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
