import { createProvider } from '../src/providers/provider-factory.js';
import { loadConfig } from '../src/config/config.js';
import { Conversation } from '../src/conversation/conversation.js';

const config = await loadConfig();
const provider = createProvider(config);
const conversation = new Conversation({ model: config.model });
const question =
  process.argv.slice(2).join(' ') || 'Hello from the Atlas library example.';

const response = await conversation.send(provider, question);
console.log(response.content);
