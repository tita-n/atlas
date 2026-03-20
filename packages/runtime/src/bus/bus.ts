type MessageHandler = (message: Message) => void | Promise<void>;

export interface Message {
  id: string;
  type: 'user' | 'agent' | 'system';
  sender: string;
  target?: string;
  content: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

class MessageBus {
  private handlers: Map<string, MessageHandler[]> = new Map();
  
  subscribe(type: string, handler: MessageHandler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type)!.push(handler);
  }

  publish(message: Message) {
    const handlers = this.handlers.get(message.type) || [];
    handlers.forEach(handler => handler(message));
    const globalHandlers = this.handlers.get('*') || [];
    globalHandlers.forEach(handler => handler(message));
  }
}

export const bus = new MessageBus();
