'use strict';
const SSE = {
  connections: new Map(),

  connect(name, path, handlers = {}) {
    if (this.connections.has(name)) this.disconnect(name);
    const es = new EventSource(path);
    es.onopen = () => {
      if (handlers.onOpen) handlers.onOpen();
    };
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const conn = this.connections.get(name);
        if (conn && conn.paused) {
          if (conn.buffer.length < 1000) conn.buffer.push(data);
        } else {
          if (handlers.onEvent) handlers.onEvent(data);
        }
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };
    es.onerror = () => {
      if (handlers.onError) handlers.onError();
      // EventSource auto-reconnects
    };
    this.connections.set(name, { source: es, handlers, paused: false, buffer: [] });
  },

  disconnect(name) {
    const conn = this.connections.get(name);
    if (conn) {
      conn.source.close();
      this.connections.delete(name);
    }
  },

  disconnectAll() {
    for (const name of this.connections.keys()) this.disconnect(name);
  },

  pause(name) {
    const conn = this.connections.get(name);
    if (conn) conn.paused = true;
  },

  resume(name) {
    const conn = this.connections.get(name);
    if (conn) {
      conn.paused = false;
      conn.buffer.forEach(e => conn.handlers.onEvent?.(e));
      conn.buffer = [];
    }
  },

  isPaused(name) {
    return this.connections.get(name)?.paused || false;
  }
};
