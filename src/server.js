import http from "http" ;
import http2 from "http2" ;
import {Readable} from "stream";
import Router from 'find-my-way';

/**
 * Web server route options
 * @typedef {RouteOptions} ServRouteOptions
 * @property {Array.<(Function|String)>} [middleware] - Array of middlewares to execute on route
 * @property {boolean} [override] - Replace route
 */

/**
 * Representing request context
 */
export class RequestContext {
    /** @type {IncomingMessage} */
    req;
    /** @type {ServerResponse} */
    res;
    params;
    query;
    /** @type {SessionAPI} */
    session;
    store;
    customOptions;
    constructor(opt) {
        Object.assign(this, opt);
    }

    code(c) {
        this.res.statusCode = c;
        return this;
    }

    message(m) {
        this.res.statusMessage = m;
        return this;
    }

    headers(obj) {
        Object.keys(obj).forEach(k => {
            this.res.setHeader(k, obj[k]);
        })
        return this
    }

    send(data, end) {
        if (end === undefined) end = true;

        if (data instanceof Readable) {
            data.once('data',()=>{if (!this.res.headersSent) this.res.writeHead(this.res.statusCode, this.res.statusMessage);});
            data.pipe(this.res, {end});
        } else if (typeof data == 'string' || data instanceof Buffer) {
            if (!this.res.headersSent) this.res.writeHead(this.res.statusCode, this.res.statusMessage);
            this.res.write(data);
            if (end) this.res.end();
        } else {
            if (!this.res.headersSent) this.res.writeHead(this.res.statusCode, this.res.statusMessage || '', {"Content-Type": "application/json; charset=utf-8"});
            this.res.write(JSON.stringify(data));
            if (end) this.res.end();
        }
        return this;
    }

    type(t) {
        this.res.setHeader('Content-Type', t);
        return this;
    }

    end(d) {
        if (!this.res.headersSent) this.res.writeHead(this.res.statusCode, this.res.statusMessage);
        this.res.end(d);
    }
}

// noinspection ExceptionCaughtLocallyJS
export class Server {
    middlewares = {};
    _hooks = {
        before: [],
        after: [],
        error: []
    };
    constructor(opts) {
        this.router = Router({
            // defaultRoute : defaultHandler,//it'll be called when no route matches. If it is not set the we'll set statusCode to 404
            ignoreTrailingSlash: true,
            ignoreLeadingSlash: true,
            allowUnsafeRegex: false
        });

    }
    async _handler(req, res) {
        let headHost = req.headers[':authority'] || req.headers['host'];
        let { host } = headHost?.match(/^(?<host>[\w-.]+)(:(?<port>\d+))?/).groups || {};
        let { path, query } = req.url.match(/(?<path>[^?]*)(?:\?(?<query>.*))?/).groups || {};
        /** @type {object}
         * @property {object} params
         * @property {function(RequestContext)} handler
         * @property {object} store
         **/
        let route = this.router.find(req.method, path, { host });
        if (route?.handler) {
            let context = new RequestContext({
                req,
                res,
                url: path,
                query,
                params: route.params,
                store: route.store.extra
            });
            try {
                // hooks "before"
                for (let hBefore of this._hooks.before) {
                    await hBefore(context);
                }
                // middlewares
                if (route.store?.middleware) {
                    for (let mw of route.store.middleware) {
                        let result;
                        if (mw instanceof Function)
                            result = await mw(context);
                        else if (this.middlewares[mw])
                            result = await this.middlewares[mw](context);
                        else throw Error(`Middleware '${mw}' not found.`);
                        if (result === false)
                            return;
                    }
                }
                await route.handler(context);
                // hooks "after"
                for (let hAfter of this._hooks.after) {
                    await hAfter(context);
                }
            } catch (e) {
                // hooks "error"
                for (let hError of this._hooks.error) {
                    await hError(context, e);
                }
                console.log(e);
                res.statusCode = 500;
                res.end();
            }
        } else {
            res.statusCode = 404;
            res.end();
        }
    }

    /**
     * Register named middleware for future using in routes
     * @param {string} name
     * @param {function(object)} func
     */
    registerMiddleware(name,func) {
        this.middlewares[name] = func;
    }

    /**
     * Register named hook on all requests
     * @param {Function} func
     * @param {string} when?
     */
    registerHook(func,when = 'after') {
        this._hooks[when].push(func);
    }

    /**
     * Add new route to server
     * @param {HTTPMethod} method
     * @param {string} path - route path
     * @param {ServRouteOptions} [options] - router option (see find-may-way) and array of middlewares applying to current route
     * @param {function(RequestContext)} handler - function
     * @param {object} [extra] - will be passed to handler
     */
    on(method, path, options, handler, extra) {
        if (options instanceof Function) {
            this.router.on(method, path,  options, { extra: handler });
        } else {
            let {middleware,override, ...opt} = options || {};
            if (override) this.router.off(method, path);
            this.router.on(method, path, /** @type RouteOptions */ opt, /** @type function */handler, {
                extra,
                middleware: options.middleware
            });
        }
    }

    run(port, secure) {
        if (secure && secure.cert && secure.key ){
            const { cert, key } = secure;
            this.server = http2.createSecureServer(
                { cert, key, allowHTTP1: true },
                this._handler.bind(this)
            )
            this.secure = true;
        } else {
            this.server = http.createServer(this._handler.bind(this));
        }

        this.server.on('clientError', (err, socket) => {
            socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        });
        this.server.listen(port);
        console.log(`Server listen on http${ this.secure ? 's' : '' }://localhost${port !== ( this.secure ? 443 : 80 ) ? `:${port}` : '' }`);
    }
}
