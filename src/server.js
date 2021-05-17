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

    headers(obj) {
        Object.keys(obj).forEach(k => {
            this.res.setHeader(k, obj[k]);
        })
        return this
    }

    send(data, end) {
        if (end === undefined) end = true;

        if (data instanceof Readable) {
            data.once('data',()=>{if (!this.res.headersSent) this.res.writeHead(this.res.statusCode);});
            data.pipe(this.res, {end});
        } else if (typeof data == 'string' || data instanceof Buffer) {
            if (!this.res.headersSent) this.res.writeHead(this.res.statusCode);
            this.res.write(data);
            if (end) this.res.end();
        } else {
            if (!this.res.headersSent) this.res.writeHead(this.res.statusCode);
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
        if (!this.res.headersSent) this.res.writeHead(this.res.statusCode);
        this.res.end(d);
    }
}

// noinspection ExceptionCaughtLocallyJS
export class Server {
    middlewares = {};
    constructor(opts) {
        this.router = Router({
            // defaultRoute : defaultHandler,//it'll be called when no route matches. If it is not set the we'll set statusCode to 404
            ignoreTrailingSlash: true,
            ignoreLeadingSlash: true,
            allowUnsafeRegex: false
        });

    }
    async _handler(req, res) {
        /** @type {object}
         * @property {object} params
         * @property {function(RequestContext)} handler
         * @property {object} store
         **/
        let route = this.router.find(req.method, path);
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
                route.handler(context);
            } catch (e) {
                console.log('MW return',e)
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
