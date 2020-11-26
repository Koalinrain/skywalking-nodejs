/*!
 *
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import SwPlugin from '../core/SwPlugin';
import { URL } from 'url';
import { ClientRequest, IncomingMessage, RequestOptions, ServerResponse } from 'http';
import ContextManager from '../trace/context/ContextManager';
import { Component } from '../trace/Component';
import Tag from '../Tag';
import { SpanLayer } from '../proto/language-agent/Tracing_pb';
import { ContextCarrier } from '../trace/context/ContextCarrier';
import { createLogger } from '../logging';

const logger = createLogger(__filename);

class HttpPlugin implements SwPlugin {
  readonly module = 'http';
  readonly versions = '*';

  install(): void {
    if (logger.isDebugEnabled()) {
      logger.debug('installing http plugin');
    }
    this.interceptClientRequest();
    this.interceptServerRequest();
  }

  private interceptClientRequest() {
    const http = require('http');

    ((original) => {
      http.request = function () {
        const url: URL | string | RequestOptions = arguments[0];

        const { host, pathname } =
          url instanceof URL
            ? url
            : typeof url === 'string'
            ? new URL(url)
            : {
                host: (url.host || url.hostname || 'unknown') + ':' + url.port,
                pathname: url.path || '/',
              };
        const operation = pathname.replace(/\?.*$/g, '');

        const span = ContextManager.current.newExitSpan(operation, host).start();
        span.component = Component.HTTP;
        span.layer = SpanLayer.HTTP;
        span.tag(Tag.httpURL(host + pathname));

        const request: ClientRequest = original.apply(this, arguments);

        span.extract().items.forEach((item) => {
          request.setHeader(item.key, item.value);
        });

        span.async();

        request.on('close', () => {
          span.await().stop();
        });

        return request;
      };
    })(http.request);
  }

  private interceptServerRequest() {
    const http = require('http');

    ((original) => {
      http.Server.prototype.emit = function () {
        if (arguments[0] !== 'request') {
          return original.apply(this, arguments);
        }

        const args = arguments;
        const self = this;

        return ContextManager.withContext(() => {
          const [req, res] = [args[1] as IncomingMessage, args[2] as ServerResponse];

          const headers = req.rawHeaders || [];
          const headersMap: { [key: string]: string } = {};

          for (let i = 0; i < headers.length / 2; i += 2) {
            headersMap[headers[i]] = headers[i + 1];
          }

          const carrier = ContextCarrier.from(headersMap);

          const span = ContextManager.current.newEntrySpan('/', carrier).start();
          span.operation = (req.url || '/').replace(/\?.*/g, '');
          span.component = Component.HTTP_SERVER;
          span.layer = SpanLayer.HTTP;
          span.tag(Tag.httpURL(req.url));

          span.tag(Tag.httpStatusCode(res.statusCode)).tag(Tag.httpStatusMsg(res.statusMessage));

          res.on('close', () => {
            console.info('jjj');
            span.stop();
          });

          return original.apply(self, args);
        });
      };
    })(http.Server.prototype.emit);
  }
}

// noinspection JSUnusedGlobalSymbols
export default new HttpPlugin();
