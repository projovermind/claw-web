import EventEmitter from 'node:events';

export function createEventBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);

  return {
    publish(topic, payload) {
      emitter.emit('event', { topic, payload, ts: new Date().toISOString() });
    },
    subscribe(cb) {
      emitter.on('event', cb);
      return () => emitter.off('event', cb);
    }
  };
}
