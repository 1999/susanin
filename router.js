(function(global) {

    var hasOwnProp = Object.prototype.hasOwnProperty;

    /**
     * @constructor
     */
    function Router() {
        this._routes = null;
        this._routesByName = null;
    }

    /**
     * Добавляет роут
     * @param {String} method http метод
     * @param {String} name имя роута
     * @param {String} pattern паттерн соответствия
     * @param {Object} [conditions] условия, накладываемые на параметры
     * @param {Object} [defaults] умалчиваемые значения параметров
     */
    Router.prototype.addRoute = function(method, name, pattern, conditions, defaults) {
        var route;

        route = new Route(method, name, pattern, conditions, defaults);

        this._routes || (this._routes = []);
        this._routes.push(route);

        this._routesByName || (this._routesByName = {});
        this._routesByName[name] = route;

        return route;
    };

    /**
     * Находит первый подходящий роут по пути и методу,
     * возвращает массив с привязанными данными и распарсенными параметрами либо null, если ни один из роутов не подошёл
     * @return {Array}
     */
    Router.prototype.find = function() {
        var ret = null,
            parsed,
            i, size,
            routes = this._routes;

        if (routes) {
            for (i = 0, size = routes.length; i < size; ++i) {
                parsed = routes[i].parse.apply(routes[i], arguments);
                if (parsed !== null) {
                    ret = [ routes[i], parsed ];
                    break;
                }
            }
        }

        return ret;
    };

    /**
     * Возвращает роут по имени
     * @param {String} name
     * @return {Route}
     */
    Router.prototype.getRouteByName = function(name) {
        return (this._routesByName && this._routesByName[name]) || null;
    };

    /**
     * Формирует бандл для прокидывания на клиент
     * @return {Array}
     */
    Router.prototype.bundle = function() {
        return this._routes && this._routes.map(function(route) {   // @todo map
            return route.bundle();
        });
    };

    /**
     * Класс роут
     * @constructor
     * @param {String} method http метод
     * @param {String} name имя роута
     * @param {String} pattern паттерн соответствия
     * @param {Object} [conditions] условия, накладываемые на параметры
     * @param {Object} [defaults] умалчиваемые значения параметров
     */
    function Route(method, name, pattern, conditions, defaults) {
        method = method.toUpperCase();

        if ( ! Route.HTTP_METHODS_REGEXP.test(method)) {
            throw 'Invalid http method "' + method + '"';
        }

        if (typeof name !== 'string') {
            throw 'Argument 2 (name) must be string';
        }

        if (typeof pattern !== 'string') {
            throw 'Argument 3 (pattern) must be string';
        }

        /* Добавим query_string */
        pattern += Route.GROUP_OPENED_CHAR +
            '?' + Route.PARAM_OPENED_CHARS + 'query_string' + Route.PARAM_CLOSED_CHARS +
            Route.GROUP_CLOSED_CHAR;
        conditions || (conditions = {});
        conditions.query_string = '.*';
        /* /Добавим query_string */

        this._method = method;
        this._name = name;
        this._pattern = pattern;
        this._conditions = conditions;
        this._defaults = defaults || null;
        this._data = null;

        this
            .parsePattern()
            .buildParseRegExp()
            .buildBuildFn();
    }

    Route.querystring = require('querystring');

    Route.escape = (function() {
        var SPECIAL_CHARS = [ '/', '.', '*', '+', '?', '|', '(', ')', '[', ']', '{', '}', '\\' ],
            SPECIAL_CHARS_REGEXP = new RegExp('(\\' + SPECIAL_CHARS.join('|\\') + ')', 'g');

        return function(text) {
            return text.replace(SPECIAL_CHARS_REGEXP, '\\$1');
        };
    })();

    Route.HTTP_METHODS = [ 'GET', 'POST', 'DELETE', 'PUT' ];
    Route.HTTP_METHODS_REGEXP = new RegExp('^(' + Route.HTTP_METHODS.join('|') + ')$');

    Route.PARAM_OPENED_CHARS = '<';
    Route.PARAM_CLOSED_CHARS = '>';

    Route.GROUP_OPENED_CHAR = '(';
    Route.GROUP_CLOSED_CHAR = ')';

    Route.PARAM_NAME_REGEXP_SOURCE = '[a-zA-Z_][\\w\\-]*';
    Route.PARAM_VALUE_REGEXP_SOURCE = '[\\w\\-]+';

    Route.PARSE_PARAMS_REGEXP =
        new RegExp(
            '(' +
                Route.escape(Route.PARAM_OPENED_CHARS) + Route.PARAM_NAME_REGEXP_SOURCE +
                Route.escape(Route.PARAM_CLOSED_CHARS) + '|' +
                '[^' + Route.escape(Route.PARAM_OPENED_CHARS) + Route.escape(Route.PARAM_CLOSED_CHARS) + ']+' + '|' +
                Route.escape(Route.PARAM_OPENED_CHARS) + '|' +
                Route.escape(Route.PARAM_CLOSED_CHARS) +
                ')',
            'g');

    /**
     * Парсит паттерн, дробит его на составляющие
     * @return {Route}
     */
    Route.prototype.parsePattern = function() {
        /*jshint maxdepth:10*/
        function parseBrackets(pattern) {
            var parts = [],
                part = '',
                character,
                i = 0, j, size,
                countOpened = 0,
                isFindingClosed = false,
                length = pattern.length;

            while (i < length) {
                character = pattern.charAt(i++);

                if (character === Route.GROUP_OPENED_CHAR) {
                    if (isFindingClosed) {
                        ++countOpened;
                        part += character;
                    } else {
                        parseParams(part, parts);
                        part = '';
                        countOpened = 0;
                        isFindingClosed = true;
                    }
                } else if (character === Route.GROUP_CLOSED_CHAR) {
                    if (isFindingClosed) {
                        if (countOpened === 0) {
                            part = {
                                what : 'optional',
                                dependOnParams : [],
                                parts : parseBrackets(part)
                            };

                            parts.push(part);

                            for (j = 0, size = part.parts.length; j < size; ++j) {
                                if (part.parts[j] && part.parts[j].what === 'param') {
                                    part.dependOnParams.push(part.parts[j].name);
                                }
                            }

                            part = '';
                            isFindingClosed = false;
                        } else {
                            --countOpened;
                            part += character;
                        }
                    } else {
                        part += character;
                    }
                } else {
                    part += character;
                }
            }

            parseParams(part, parts);

            return parts;
        }

        function parseParams(pattern, parts) {
            var matches = pattern.match(Route.PARSE_PARAMS_REGEXP);

            if (matches) {
                matches.forEach(function(part) {
                    if (part.indexOf(Route.PARAM_OPENED_CHARS) === 0 &&
                        part.lastIndexOf(Route.PARAM_CLOSED_CHARS) === part.length - Route.PARAM_CLOSED_CHARS.length) {
                        parts.push({
                            what : 'param',
                            name : part.substr(
                                Route.PARAM_OPENED_CHARS.length,
                                part.length - Route.PARAM_CLOSED_CHARS.length - 1)
                        });
                    } else {
                        parts.push(part);
                    }
                });
            }
        }

        this._parts = parseBrackets(this._pattern);

        return this;
    };

    /**
     * Строит регэксп для проверки
     * @return {Route}
     */
    Route.prototype.buildParseRegExp = function() {
        var route = this;

        function build(parts) {
            var ret = '';

            parts.forEach(function(part) {
                if (typeof part === 'string') {
                    ret += Route.escape(part);
                } else if (part && part.what === 'param') {
                    route._paramsMap.push(part.name);
                    ret += '(' + buildParamValueRegExpSource(part.name) + ')';
                } else if (part && part.what === 'optional') {
                    ret += '(?:' + build(part.parts) + ')?';
                }
            });

            return ret;
        }

        function buildParamValueRegExpSource(paramName) {
            var ret = '',
                condition = route._conditions && route._conditions[paramName];

            if (condition) {
                if (Array.isArray(condition)) {
                    ret = '(?:' + condition.join('|') + ')';
                } else {
                    ret = condition + '';
                }
            } else {
                ret =  Route.PARAM_VALUE_REGEXP_SOURCE;
            }

            return ret;
        }

        this._paramsMap = [];
        this._parseRegExpSource = '^' + build(this._parts) + '$';
        this._parseRegExp = new RegExp(this._parseRegExpSource);

        return this;
    };

    /**
     * Строит функцию для составления пути
     * @return {Route}
     */
    Route.prototype.buildBuildFn = function() {
        /*jshint evil:true */
        var route = this;

        function build(parts) {
            var ret = '""';

            parts.forEach(function(part) {
                if (typeof part === 'string') {
                    ret += '+"' + Route.escape(part) + '"' ;
                } else if (part && part.what === 'param') {
                    ret += '+(h.call(p,"' + Route.escape(part.name) + '")?' +
                        'p["' + Route.escape(part.name) + '"]:' +
                        (route._defaults && hasOwnProp.call(route._defaults, part.name) ?
                            '"' + Route.escape(route._defaults[part.name]) +  '"' :
                            '""') +
                        ')';
                } else if (part && part.what === 'optional') {
                    ret += '+((false';
                    part.dependOnParams.forEach(function(name) {
                        ret += '||(h.call(p,"' + Route.escape(name) + '")' +
                            (route._defaults && hasOwnProp.call(route._defaults, name) ?
                                '&&p["' + Route.escape(name) + '"]!=="' +
                                    Route.escape(route._defaults[name]) + '"' :
                                '') +
                            ')';
                    });
                    ret += ')?(' + build(part.parts) + '):"")';
                }
            });

            return ret;
        }

        this._buildFnSource = 'var h=({}).hasOwnProperty;return ' + build(this._parts) + ';';
        this._buildFn = new Function('p', this._buildFnSource);

        return this;
    };

    /**
     * Парсит переданный путь, возвращает объект с параметрами либо null
     * @param {String} path
     * @param {String} method
     * @return {Object}
     */
    Route.prototype.parse = function(path, method) {
        var ret = null,
            matches,
            i, size,
            key,
            queryParams;

        method = method.toUpperCase();

        if (this._method === method) {
            matches = path.match(this._parseRegExp);

            if (matches) {
                ret = {};

                for (i = 1, size = matches.length; i < size; ++i) {
                    if (typeof matches[i] !== 'undefined') {
                        ret[this._paramsMap[i - 1]] = matches[i];
                    }
                }

                for (key in this._defaults) {
                    if (hasOwnProp.call(this._defaults, key) && ! hasOwnProp.call(ret, key)) {
                        ret[key] = this._defaults[key];
                    }
                }

                queryParams = Route.querystring.parse(ret.query_string);
                for (key in queryParams) {
                    if (hasOwnProp.call(queryParams, key) && ! hasOwnProp.call(ret, key)) {
                        ret[key] = queryParams[key];
                    }
                }
                delete ret.query_string;
            }
        }

        return ret;
    };

    /**
     * Составляет путь по переданным параметрам
     * @param {Object} params
     * @return {String}
     */
    Route.prototype.build = function(params) {
        var newParams = {},
            queryParams = {},
            queryString,
            key;

        for (key in params) {
            if (hasOwnProp.call(params, key)) {
                if (this._paramsMap.indexOf(key) !== -1) {
                    newParams[key] = params[key];
                } else {
                    queryParams[key] = params[key];
                }
            }
        }

        queryString = Route.querystring.stringify(queryParams);
        queryString && (newParams.query_string = queryString);

        return this._buildFn(newParams);
    };

    /**
     * Связывает данные с роутом
     * геттер и сеттер
     * @param {Object} data
     * @return {Route}
     */
    Route.prototype.bind = function(data) {
        if (typeof data === 'undefined') {
            return this._data;
        }

        this._data = data;

        return this;
    };

    Route.prototype.bundle = function() {
        return [
            this._name,
            this._defaults,
            this._paramsMap,
            this._parseRegExpSource,
            this._buildFnSource,
            this._data && this._data.controller
        ];
    };

    global.Router = Router;

})(this);