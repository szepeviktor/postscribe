//     postscribe.js 1.1.2
//     (c) Copyright 2012 to the present, Krux
//     postscribe is freely distributable under the MIT license.
//     For all details and documentation:
//     http://krux.github.com/postscribe

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(['htmlParser'], factory);
    } else {
        // Browser globals
        root.postscribe = factory(root.htmlParser);
    }
}(this, function (htmlParser) {
    var global = this,

    // Debug write tasks.
    DEBUG = true,

    // Turn on to debug how each chunk affected the DOM.
    DEBUG_CHUNK = false,

    // # Helper Functions

    slice = Array.prototype.slice,

    WriteStream;

    if (global.postscribe) {
        return;
    }

    // A function that intentionally does nothing.
    function doNothing() {}


    // Is this a function?
    function isFunction(x) {
        return "function" === typeof x;
    }

    // Loop over each item in an array-like value.
    function each(arr, fn, _this) {
        var i, len = (arr && arr.length) || 0;
        for (i = 0; i < len; i += 1) {
            fn.call(_this, arr[i], i);
        }
    }

    // Loop over each key/value pair in a hash.
    function eachKey(obj, fn, _this) {
        var key;
        for (key in obj) {
            if (obj.hasOwnProperty(key)) {
                fn.call(_this, key, obj[key]);
            }
        }
    }

    // Set properties on an object.
    function set(obj, props) {
        eachKey(props, function (key, value) {
            obj[key] = value;
        });
        return obj;
    }

    // Set default options where some option was not specified.
    function defaults(options, _defaults) {
        options = options || {};
        eachKey(_defaults, function (key, val) {
            if (options[key] == null) {
                options[key] = val;
            }
        });
        return options;
    }

    // Convert value (e.g., a NodeList) to an array.
    function toArray(obj) {
        try {
            return slice.call(obj);
        } catch (e) {
            var ret = [];
            each(obj, function (val) {
                ret.push(val);
            });
            return ret;
        }
    }

    // Test if token is a script tag.
    function isScript(tok) {
        return (/^script$/i).test(tok.tagName);
    }

    // # Class WriteStream

    // Stream static html to an element, where "static html" denotes "html without scripts".

    // This class maintains a *history of writes devoid of any attributes* or "proxy history".
    // Injecting the proxy history into a temporary div has no side-effects,
    // other than to create proxy elements for previously written elements.

    // Given the `staticHtml` of a new write, a `tempDiv`'s innerHTML is set to `proxy_history + staticHtml`.
    // The *structure* of `tempDiv`'s contents, (i.e., the placement of new nodes beside or inside of proxy elements),
    // reflects the DOM structure that would have resulted if all writes had been squashed into a single write.

    // For each descendent `node` of `tempDiv` whose parentNode is a *proxy*, `node` is appended to the corresponding *real* element within the DOM.

    // Proxy elements are mapped to *actual* elements in the DOM by injecting a data-id attribute into each start tag in `staticHtml`.
    WriteStream = (function () {

        // Prefix for data attributes on DOM elements.
        var BASEATTR = 'data-ps-';

        // get / set data attributes
        function data(el, name, value) {
            var attr = BASEATTR + name,
                val;

            if (arguments.length === 2) {
                // Get
                val = el.getAttribute(attr);

                // IE 8 returns a number if it's a number
                return val === null ? val : String(val);

            } else if (value !== null && value !== '') {
                // Set
                el.setAttribute(attr, value);

            } else {
                // Remove
                el.removeAttribute(attr);
            }
        }

        function WriteStream(root, options) {
            var doc = root.ownerDocument;

            set(this, {
                root: root,

                options: options,

                win: doc.defaultView || doc.parentWindow,

                doc: doc,

                parser: global.htmlParser('', {
                    autoFix: true
                }),

                // Actual elements by id.
                actuals: [root],

                // Embodies the "structure" of what's been written so far, devoid of attributes.
                proxyHistory: '',

                // Create a proxy of the root element.
                proxyRoot: doc.createElement(root.nodeName),

                scriptStack: [],

                writeQueue: []
            });

            data(this.proxyRoot, 'proxyof', 0);

        }


        WriteStream.prototype.write = function () {
            [].push.apply(this.writeQueue, arguments);
            // Process writes
            // When new script gets pushed or pending this will stop
            // because new writeQueue gets pushed
            var arg;
            while (!this.deferredRemote &&
                this.writeQueue.length) {
                arg = this.writeQueue.shift();

                if (isFunction(arg)) {
                    this.callFunction(arg);
                } else {
                    this.writeImpl(arg);
                }
            }
        };

        WriteStream.prototype.callFunction = function (fn) {
            var tok = {
                type: "function",
                value: fn.name || fn.toString()
            };
            this.onScriptStart(tok);
            fn.call(this.win, this.doc);
            this.onScriptDone(tok);
        };

        WriteStream.prototype.writeImpl = function (html) {
            this.parser.append(html);

            var tok, tokens = [];

            // stop if we see a script token
            while ((tok = this.parser.readToken()) && !isScript(tok)) {
                tokens.push(tok);
            }

            this.writeStaticTokens(tokens);

            if (tok) {
                this.handleScriptToken(tok);
            }
        };


        // ## Contiguous non-script tokens (a chunk)
        WriteStream.prototype.writeStaticTokens = function (tokens) {

            var chunk = this.buildChunk(tokens);

            if (!chunk.actual) {
                // e.g., no tokens, or a noscript that got ignored
                return;
            }
            chunk.html = this.proxyHistory + chunk.actual;
            this.proxyHistory += chunk.proxy;

            this.proxyRoot.innerHTML = chunk.html;

            if (DEBUG_CHUNK) {
                chunk.proxyInnerHTML = this.proxyRoot.innerHTML;
            }

            this.walkChunk();

            if (DEBUG_CHUNK) {
                //root
                chunk.actualInnerHTML = this.root.innerHTML;
            }

            return chunk;
        };


        WriteStream.prototype.buildChunk = function (tokens) {
            var nextId = this.actuals.length,

                // The raw html of this chunk.
                raw = [],

                // The html to create the nodes in the tokens (with id's injected).
                actual = [],

                // Html that can later be used to proxy the nodes in the tokens.
                proxy = [];

            each(tokens, function (tok) {

                raw.push(tok.text);

                if (tok.attrs) { // tok.attrs <==> startTag or atomicTag or cursor
                    // Ignore noscript tags. They are atomic, so we don't have to worry about children.
                    if (!(/^noscript$/i).test(tok.tagName)) {
                        var id = nextId++;

                        // Actual: inject id attribute: replace '>' at end of start tag with id attribute + '>'
                        actual.push(
                            tok.text.replace(/(\/?>)/, ' ' + BASEATTR + 'id=' + id + ' $1')
                        );

                        // Don't proxy scripts: they have no bearing on DOM structure.
                        if (tok.attrs.id !== "ps-script") {
                            // Proxy: strip all attributes and inject proxyof attribute
                            proxy.push(
                                // ignore atomic tags (e.g., style): they have no "structural" effect
                                tok.type === 'atomicTag' ? '' :
                                '<' + tok.tagName + ' ' + BASEATTR + 'proxyof=' + id + (tok.unary ? '/>' : '>')
                            );
                        }
                    }

                } else {
                    // Visit any other type of token
                    // Actual: append.
                    actual.push(tok.text);
                    // Proxy: append endTags. Ignore everything else.
                    proxy.push(tok.type === 'endTag' ? tok.text : '');
                }
            });

            return {
                tokens: tokens,
                raw: raw.join(''),
                actual: actual.join(''),
                proxy: proxy.join('')
            };
        };

        WriteStream.prototype.walkChunk = function () {
            var node,
                stack = [this.proxyRoot],
                isElement,
                isProxy,
                parentIsProxyOf;

            // use shift/unshift so that children are walked in document order

            while ((node = stack.shift()) != null) {

                isElement = node.nodeType === 1;
                isProxy = isElement && data(node, 'proxyof');

                // Ignore proxies
                if (!isProxy) {

                    if (isElement) {
                        // New actual element: register it and remove the the id attr.
                        this.actuals[data(node, 'id')] = node;
                        data(node, 'id', null);
                    }

                    // Is node's parent a proxy?
                    parentIsProxyOf = node.parentNode && data(node.parentNode, 'proxyof');
                    if (parentIsProxyOf) {
                        // Move node under actual parent.
                        this.actuals[parentIsProxyOf].appendChild(node);
                    }
                }
                // prepend childNodes to stack
                stack.unshift.apply(stack, toArray(node.childNodes));
            }
        };

        // ### Script tokens
        WriteStream.prototype.handleScriptToken = function (tok) {
            var remainder = this.parser.clear(),
                _this;

            if (remainder) {
                // Write remainder immediately behind this script.
                this.writeQueue.unshift(remainder);
            }

            tok.src = tok.attrs.src || tok.attrs.SRC;

            if (tok.src && this.scriptStack.length) {
                // Defer this script until scriptStack is empty.
                // Assumption 1: This script will not start executing until
                // scriptStack is empty.
                this.deferredRemote = tok;
            } else {
                this.onScriptStart(tok);
            }

            // Put the script node in the DOM.
            _this = this;
            this.writeScriptToken(tok, function () {
                _this.onScriptDone(tok);
            });

        };

        WriteStream.prototype.onScriptStart = function (tok) {
            tok.outerWrites = this.writeQueue;
            this.writeQueue = [];
            this.scriptStack.unshift(tok);
        };

        WriteStream.prototype.onScriptDone = function (tok) {
            // Pop script and check nesting.
            if (tok !== this.scriptStack[0]) {
                this.options.error({
                    message: "Bad script nesting or script finished twice"
                });
                return;
            }
            this.scriptStack.shift();

            // Append outer writes to queue and process them.
            this.write.apply(this, tok.outerWrites);

            // Check for pending remote

            // Assumption 2: if remote_script1 writes remote_script2 then
            // the we notice remote_script1 finishes before remote_script2 starts.
            // I think this is equivalent to assumption 1
            if (!this.scriptStack.length && this.deferredRemote) {
                this.onScriptStart(this.deferredRemote);
                this.deferredRemote = null;
            }
        };

        // Build a script and insert it into the DOM.
        // Done is called once script has executed.
        WriteStream.prototype.writeScriptToken = function (tok, done) {
            var el = this.buildScript(tok);

            if (tok.src) {
                // Fix for attribute "SRC" (capitalized). IE does not recognize it.
                el.src = tok.src;
                this.scriptLoadHandler(el, done);
            }

            try {
                this.insertScript(el);
                if (!tok.src) {
                    done();
                }
            } catch (e) {
                this.options.error(e);
                done();
            }
        };

        // Build a script element from an atomic script token.
        WriteStream.prototype.buildScript = function (tok) {
            var el = this.doc.createElement(tok.tagName);

            // Set attributes
            eachKey(tok.attrs, function (name, value) {
                el.setAttribute(name, value);
            });

            // Set content
            if (tok.content) {
                el.text = tok.content;
            }

            return el;
        };


        // Insert script into DOM where it would naturally be written.
        WriteStream.prototype.insertScript = function (el) {
            var cursor;

            // Append a span to the stream. That span will act as a cursor
            // (i.e. insertion point) for the script.
            this.writeImpl('<span id="ps-script"/>');

            // Grab that span from the DOM.
            cursor = this.doc.getElementById("ps-script");

            // Replace cursor with script.
            cursor.parentNode.replaceChild(el, cursor);
        };


        WriteStream.prototype.scriptLoadHandler = function (el, done) {
            var error;

            function cleanup() {
                el = el.onload = el.onreadystatechange = el.onerror = null;
                done();
            }

            // Error handler
            error = this.options.error;

            // Set handlers
            set(el, {
                onload: function () {
                    cleanup();
                },

                onreadystatechange: function () {
                    if (/^(loaded|complete)$/.test(el.readyState)) {
                        cleanup();
                    }
                },

                onerror: function () {
                    error({
                        message: 'remote script failed ' + el.src
                    });
                    cleanup();
                }
            });
        };

        return WriteStream;

    }());


    // Public-facing interface and queuing
    var postscribe = (function () {
        var nextId = 0,
            queue = [],
            active = null;

        function nextStream() {
            var args = queue.shift();

            if (args) {
                args.stream = runStream.apply(null, args);
            }
        }


        function runStream(el, html, options) {
            var doc,
                stash;
            active = new WriteStream(el, options);

            // Identify this stream.
            active.id = nextId++;
            active.name = options.name || active.id;
            postscribe.streams[active.name] = active;

            // Override document.write.
            doc = el.ownerDocument;

            stash = {
                write: doc.write,
                writeln: doc.writeln
            };

            function write(str) {
                str = options.beforeWrite(str);
                active.write(str);
                options.afterWrite(str);
            }

            set(doc, {
                write: function () {
                    return write(toArray(arguments).join(''));
                },
                writeln: function (str) {
                    return write(toArray(arguments).join('') + '\n');
                }
            });

            // Override window.onerror
            var oldOnError = active.win.onerror || doNothing;

            // This works together with the try/catch around WriteStream::insertScript
            // In modern browsers, exceptions in tag scripts go directly to top level
            active.win.onerror = function (msg, url, line) {
                options.error({
                    msg: msg + ' - ' + url + ':' + line
                });
                oldOnError.apply(active.win, arguments);
            };

            // Write to the stream
            active.write(html, function streamDone() {
                // restore document.write
                set(doc, stash);

                // restore window.onerror
                active.win.onerror = oldOnError;

                options.done();
                active = null;
                nextStream();
            });

            return active;
        }


        function postscribe(el, html, options) {
            if (isFunction(options)) {
                options = {
                    done: options
                };
            }
            options = defaults(options, {
                done: doNothing,
                error: function (e) {
                    throw e;
                },
                beforeWrite: function (str) {
                    return str;
                },
                afterWrite: doNothing
            });

            el =
            // id selector
            (/^#/).test(el) ? global.document.getElementById(el.substr(1)) :
            // jquery object. TODO: loop over all elements.
            el.jquery ? el[0] : el;


            var args = [el, html, options];

            el.postscribe = {
                cancel: function () {
                    if (args.stream) {
                        // TODO: implement this
                        args.stream.abort();
                    } else {
                        args[1] = doNothing;
                    }
                }
            };

            queue.push(args);
            if (!active) {
                nextStream();
            }

            return el.postscribe;
        }

        return set(postscribe, {
            // Streams by name.
            streams: {},
            // Queue of streams.
            queue: queue,
            // Expose internal classes.
            WriteStream: WriteStream
        });

    }());

    return postscribe;

}));
