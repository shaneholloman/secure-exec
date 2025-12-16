/**
 * Network polyfill code to be injected into isolated-vm context.
 * This provides fetch, http, https, and dns module emulation that bridges to host.
 */

/**
 * Generate the network polyfill code to inject into the isolate.
 * This code runs inside the isolated VM context.
 *
 * The polyfill requires these References to be set up:
 * - _networkFetch: (url: string, options: string) => Promise<string> (JSON-encoded response)
 * - _networkDnsLookup: (hostname: string) => Promise<string> (JSON-encoded result)
 * - _networkHttpRequest: (options: string) => Promise<string> (JSON-encoded response)
 */
export function generateNetworkPolyfill(): string {
  return `
(function() {
  // Fetch polyfill
  async function fetch(url, options = {}) {
    const optionsJson = JSON.stringify({
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body || null
    });

    const responseJson = await _networkFetchRaw.apply(undefined, [String(url), optionsJson], { result: { promise: true } });
    const response = JSON.parse(responseJson);

    // Create Response-like object
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: new Map(Object.entries(response.headers || {})),
      url: response.url || url,
      redirected: response.redirected || false,
      type: 'basic',

      async text() {
        return response.body || '';
      },
      async json() {
        return JSON.parse(response.body || '{}');
      },
      async arrayBuffer() {
        // Not fully supported - return empty buffer
        return new ArrayBuffer(0);
      },
      async blob() {
        // Not supported
        throw new Error('Blob not supported in sandbox');
      },
      clone() {
        return { ...this };
      }
    };
  }

  // Headers class stub
  class Headers {
    constructor(init) {
      this._headers = {};
      if (init && init !== null) {
        if (init instanceof Headers) {
          this._headers = { ...init._headers };
        } else if (Array.isArray(init)) {
          init.forEach(([key, value]) => {
            this._headers[key.toLowerCase()] = value;
          });
        } else if (typeof init === 'object') {
          Object.entries(init).forEach(([key, value]) => {
            this._headers[key.toLowerCase()] = value;
          });
        }
      }
    }
    get(name) { return this._headers[name.toLowerCase()] || null; }
    set(name, value) { this._headers[name.toLowerCase()] = value; }
    has(name) { return name.toLowerCase() in this._headers; }
    delete(name) { delete this._headers[name.toLowerCase()]; }
    entries() { return Object.entries(this._headers); }
    keys() { return Object.keys(this._headers); }
    values() { return Object.values(this._headers); }
    forEach(callback) {
      Object.entries(this._headers).forEach(([k, v]) => callback(v, k, this));
    }
  }

  // Request class stub
  class Request {
    constructor(input, init = {}) {
      this.url = typeof input === 'string' ? input : input.url;
      this.method = init.method || (input.method) || 'GET';
      this.headers = new Headers(init.headers || (input.headers));
      this.body = init.body || null;
      this.mode = init.mode || 'cors';
      this.credentials = init.credentials || 'same-origin';
      this.cache = init.cache || 'default';
      this.redirect = init.redirect || 'follow';
      this.referrer = init.referrer || 'about:client';
      this.integrity = init.integrity || '';
    }
    clone() {
      return new Request(this.url, this);
    }
  }

  // Response class stub
  class Response {
    constructor(body, init = {}) {
      this._body = body;
      this.status = init.status || 200;
      this.statusText = init.statusText || 'OK';
      this.headers = new Headers(init.headers);
      this.ok = this.status >= 200 && this.status < 300;
      this.type = 'default';
      this.url = '';
      this.redirected = false;
    }
    async text() { return String(this._body || ''); }
    async json() { return JSON.parse(this._body || '{}'); }
    clone() { return new Response(this._body, this); }
    static error() { return new Response(null, { status: 0, statusText: '' }); }
    static redirect(url, status = 302) {
      return new Response(null, { status, headers: { Location: url } });
    }
  }

  // DNS module polyfill
  const dns = {
    lookup: function(hostname, options, callback) {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }

      _networkDnsLookupRaw.apply(undefined, [hostname], { result: { promise: true } })
        .then(resultJson => {
          const result = JSON.parse(resultJson);
          if (result.error) {
            const err = new Error(result.error);
            err.code = result.code || 'ENOTFOUND';
            callback(err);
          } else {
            callback(null, result.address, result.family);
          }
        })
        .catch(err => {
          callback(err);
        });
    },

    resolve: function(hostname, rrtype, callback) {
      if (typeof rrtype === 'function') {
        callback = rrtype;
        rrtype = 'A';
      }

      // Simplified - just do lookup for A records
      dns.lookup(hostname, (err, address, family) => {
        if (err) {
          callback(err);
        } else {
          callback(null, [address]);
        }
      });
    },

    resolve4: function(hostname, callback) {
      dns.resolve(hostname, 'A', callback);
    },

    resolve6: function(hostname, callback) {
      dns.resolve(hostname, 'AAAA', callback);
    },

    promises: {
      lookup: function(hostname, options) {
        return new Promise((resolve, reject) => {
          dns.lookup(hostname, options, (err, address, family) => {
            if (err) reject(err);
            else resolve({ address, family });
          });
        });
      },
      resolve: function(hostname, rrtype) {
        return new Promise((resolve, reject) => {
          dns.resolve(hostname, rrtype, (err, addresses) => {
            if (err) reject(err);
            else resolve(addresses);
          });
        });
      }
    }
  };

  // HTTP module polyfill (minimal)
  function createHttpModule(protocol) {
    // IncomingMessage stub - implements Node.js Readable stream interface
    class IncomingMessage {
      constructor(response) {
        this.headers = response?.headers || {};
        this.rawHeaders = [];
        if (this.headers && typeof this.headers === 'object') {
          Object.entries(this.headers).forEach(([k, v]) => {
            this.rawHeaders.push(k, v);
          });
        }
        this.trailers = {};  // HTTP trailers (trailing headers after body)
        this.rawTrailers = [];
        this.httpVersion = '1.1';
        this.httpVersionMajor = 1;
        this.httpVersionMinor = 1;
        this.method = null;
        this.url = response?.url || '';
        this.statusCode = response?.status;
        this.statusMessage = response?.statusText;
        this._body = response?.body || '';
        this._listeners = {};
        this.complete = false;
        this.aborted = false;
        this.socket = null;
        this._bodyConsumed = false;
        this._ended = false;
        this._flowing = false;
        this.readable = true;
        this.readableEnded = false;
        this.readableFlowing = null;
      }

      on(event, listener) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(listener);

        // When 'data' listener is added, start flowing mode
        if (event === 'data' && !this._bodyConsumed && this._body) {
          this._flowing = true;
          this.readableFlowing = true;
          // Emit data in next microtask
          Promise.resolve().then(() => {
            if (!this._bodyConsumed) {
              this._bodyConsumed = true;
              const buf = typeof Buffer !== 'undefined' ? Buffer.from(this._body) : this._body;
              this.emit('data', buf);
              // Emit end after data
              Promise.resolve().then(() => {
                if (!this._ended) {
                  this._ended = true;
                  this.complete = true;
                  this.readable = false;
                  this.readableEnded = true;
                  this.emit('end');
                }
              });
            }
          });
        }

        // If 'end' listener is added after data was already consumed, emit end
        if (event === 'end' && this._bodyConsumed && !this._ended) {
          Promise.resolve().then(() => {
            if (!this._ended) {
              this._ended = true;
              this.complete = true;
              this.readable = false;
              this.readableEnded = true;
              listener();
            }
          });
        }

        return this;
      }

      once(event, listener) {
        const wrapper = (...args) => {
          this.off(event, wrapper);
          listener(...args);
        };
        wrapper._originalListener = listener;
        return this.on(event, wrapper);
      }

      off(event, listener) {
        if (this._listeners[event]) {
          const idx = this._listeners[event].findIndex(fn =>
            fn === listener || fn._originalListener === listener
          );
          if (idx !== -1) this._listeners[event].splice(idx, 1);
        }
        return this;
      }

      removeListener(event, listener) {
        return this.off(event, listener);
      }

      removeAllListeners(event) {
        if (event) {
          delete this._listeners[event];
        } else {
          this._listeners = {};
        }
        return this;
      }

      emit(event, ...args) {
        const handlers = this._listeners[event];
        if (handlers) {
          handlers.slice().forEach(fn => fn(...args));
        }
        return handlers && handlers.length > 0;
      }

      setEncoding(encoding) {
        this._encoding = encoding;
        return this;
      }

      // Stream readable methods
      read(size) {
        if (this._bodyConsumed) return null;
        this._bodyConsumed = true;
        const buf = typeof Buffer !== 'undefined' ? Buffer.from(this._body) : this._body;
        // Schedule end event
        Promise.resolve().then(() => {
          if (!this._ended) {
            this._ended = true;
            this.complete = true;
            this.readable = false;
            this.readableEnded = true;
            this.emit('end');
          }
        });
        return buf;
      }

      pipe(dest) {
        // Pipe body data to destination
        const buf = typeof Buffer !== 'undefined' ? Buffer.from(this._body || '') : (this._body || '');
        if (typeof dest.write === 'function' && buf.length > 0) {
          dest.write(buf);
        }
        if (typeof dest.end === 'function') {
          Promise.resolve().then(() => dest.end());
        }
        this._bodyConsumed = true;
        this._ended = true;
        this.complete = true;
        this.readable = false;
        this.readableEnded = true;
        return dest;
      }

      pause() {
        this._flowing = false;
        this.readableFlowing = false;
        return this;
      }

      resume() {
        this._flowing = true;
        this.readableFlowing = true;
        // If body not consumed, emit data now
        if (!this._bodyConsumed && this._body) {
          Promise.resolve().then(() => {
            if (!this._bodyConsumed) {
              this._bodyConsumed = true;
              const buf = typeof Buffer !== 'undefined' ? Buffer.from(this._body) : this._body;
              this.emit('data', buf);
              Promise.resolve().then(() => {
                if (!this._ended) {
                  this._ended = true;
                  this.complete = true;
                  this.readable = false;
                  this.readableEnded = true;
                  this.emit('end');
                }
              });
            }
          });
        }
        return this;
      }

      unpipe(dest) { return this; }

      destroy(err) {
        this.destroyed = true;
        this.readable = false;
        if (err) this.emit('error', err);
        this.emit('close');
        return this;
      }

      // Make it iterable/async iterable for minipass
      [Symbol.asyncIterator]() {
        const self = this;
        let dataEmitted = false;
        let ended = false;

        return {
          async next() {
            // If already ended, return done
            if (ended || self._ended) {
              return { done: true, value: undefined };
            }

            // If data not emitted yet, return the body
            if (!dataEmitted && !self._bodyConsumed) {
              dataEmitted = true;
              self._bodyConsumed = true;
              const buf = typeof Buffer !== 'undefined' ? Buffer.from(self._body || '') : (self._body || '');
              return { done: false, value: buf };
            }

            // Signal end
            ended = true;
            self._ended = true;
            self.complete = true;
            self.readable = false;
            self.readableEnded = true;
            return { done: true, value: undefined };
          },
          return() {
            ended = true;
            return Promise.resolve({ done: true, value: undefined });
          },
          throw(err) {
            ended = true;
            self.emit('error', err);
            return Promise.resolve({ done: true, value: undefined });
          }
        };
      }
    }

    // ClientRequest stub
    class ClientRequest {
      constructor(options, callback) {
        this._options = options;
        this._callback = callback;
        this._listeners = {};
        this._body = '';
        this._ended = false;
        this.socket = null;
        this.finished = false;
        this.aborted = false;
        this._executePromise = null;

        // Execute request asynchronously using Promise microtask for better isolated-vm compatibility
        this._executePromise = Promise.resolve().then(() => this._execute());
      }

      async _execute() {
        try {
          const url = this._buildUrl();
          const optionsJson = JSON.stringify({
            method: this._options.method || 'GET',
            headers: this._options.headers || {},
            body: this._body || null
          });

          const responseJson = await _networkHttpRequestRaw.apply(undefined, [url, optionsJson], { result: { promise: true } });
          const response = JSON.parse(responseJson);

          const res = new IncomingMessage(response);
          this.finished = true;

          if (this._callback) {
            this._callback(res);
          }
          this._emit('response', res);
        } catch (err) {
          this._emit('error', err);
        }
      }

      _buildUrl() {
        const opts = this._options;
        const protocol = opts.protocol || (opts.port === 443 ? 'https:' : 'http:');
        const host = opts.hostname || opts.host || 'localhost';
        const port = opts.port ? ':' + opts.port : '';
        const path = opts.path || '/';
        return protocol + '//' + host + port + path;
      }

      on(event, listener) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(listener);
        return this;
      }

      once(event, listener) {
        const wrapper = (...args) => {
          this.off(event, wrapper);
          listener(...args);
        };
        return this.on(event, wrapper);
      }

      off(event, listener) {
        if (this._listeners[event]) {
          const idx = this._listeners[event].indexOf(listener);
          if (idx !== -1) this._listeners[event].splice(idx, 1);
        }
        return this;
      }

      _emit(event, ...args) {
        if (this._listeners[event]) {
          this._listeners[event].forEach(fn => fn(...args));
        }
      }

      write(data) {
        this._body += data;
        return true;
      }

      end(data) {
        if (data) this._body += data;
        this._ended = true;
        return this;
      }

      abort() {
        this.aborted = true;
      }

      setTimeout(timeout) { return this; }
      setNoDelay() { return this; }
      setSocketKeepAlive() { return this; }
      flushHeaders() {}
    }

    return {
      request: function(options, callback) {
        if (typeof options === 'string') {
          // Parse URL string
          const url = new URL(options);
          options = {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search
          };
        }
        return new ClientRequest(options, callback);
      },

      get: function(options, callback) {
        if (typeof options === 'string') {
          const url = new URL(options);
          options = {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: 'GET'
          };
        } else {
          options.method = 'GET';
        }
        const req = new ClientRequest(options, callback);
        req.end();
        return req;
      },

      // Server is not supported
      createServer: function() {
        throw new Error('http.createServer is not supported in sandbox');
      },

      Agent: class Agent {
        constructor() {}
      },

      globalAgent: {},

      IncomingMessage,
      ClientRequest,

      METHODS: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
      STATUS_CODES: {
        200: 'OK',
        201: 'Created',
        204: 'No Content',
        301: 'Moved Permanently',
        302: 'Found',
        304: 'Not Modified',
        400: 'Bad Request',
        401: 'Unauthorized',
        403: 'Forbidden',
        404: 'Not Found',
        500: 'Internal Server Error'
      }
    };
  }

  const http = createHttpModule('http');
  const https = createHttpModule('https');

  // Export to global
  globalThis.fetch = fetch;
  globalThis.Headers = Headers;
  globalThis.Request = Request;
  globalThis.Response = Response;
  globalThis._httpModule = http;
  globalThis._httpsModule = https;
  globalThis._dnsModule = dns;
})();
`;
}
