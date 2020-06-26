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

type CallbackType = (res: IncomingMessage) => void;

type RequestFunctionType = (
  url: string | URL | RequestOptions,
  options: RequestOptions | CallbackType,
  callback?: (res: IncomingMessage) => void,
) => ClientRequest;

const logger = createLogger(__filename);

class HttpPlugin implements SwPlugin {
  readonly module = 'http';
  readonly versions = '';

  install(): void {
    this.interceptClientRequest();
    this.interceptServerRequest();
  }

  private interceptClientRequest() {
    const http = require('http');

    if (http.request === this.wrapHttpClientRequest) {
      return;
    }

    http.request = this.wrapHttpClientRequest(http.request);
  }

  private wrapHttpClientRequest(originalRequest: RequestFunctionType): RequestFunctionType {
    return (
      url: string | URL | RequestOptions,
      options: RequestOptions | CallbackType,
      callback?: CallbackType,
    ): ClientRequest => {
      logger.debug(`url is ${typeof url}: ${url}`);

      const { host: peer, pathname } =
        url instanceof URL
          ? url
          : typeof url === 'string'
          ? new URL(url)
          : {
              host: url.host || url.hostname || 'unknown',
              pathname: url.path || '/',
            };
      const operation = (pathname || '/').replace(/\?.*$/g, '');

      const span = ContextManager.current.newExitSpan(operation, peer).start();
      span.component = Component.HTTP;
      span.layer = SpanLayer.HTTP;
      span.tag(Tag.httpURL(peer + pathname));

      const snapshot = ContextManager.current.capture();

      const request = originalRequest(url, options, (res) => {
        span.tag(Tag.httpStatusCode(res.statusCode)).tag(Tag.httpStatusMsg(res.statusMessage));

        const callbackSpan = ContextManager.current.newLocalSpan('callback').start();
        callbackSpan.layer = SpanLayer.HTTP;
        callbackSpan.component = Component.HTTP;

        ContextManager.current.restore(snapshot);

        if (typeof options === 'function') {
          options(res);
        }
        if (callback) {
          callback(res);
        }

        callbackSpan.stop();
      });

      span.extract().items.forEach((item) => {
        request.setHeader(item.key, item.value);
      });

      span.stop();

      return request;
    };
  }

  private interceptServerRequest() {
    const http = require('http');

    ((original) => {
      http.Server.prototype.emit = function (event: string | symbol, ...args: any[]): boolean {
        logger.debug('Intercepting http.Server.prototype.emit');
        if (event === 'request') {
          if (!(args[0] instanceof IncomingMessage) && !(args[1] instanceof ServerResponse)) {
            logger.debug('args[0] is not IncomingMessage or args[1] is not ServerResponse');
            return original.apply(this, arguments);
          }
          const req = args[0] as IncomingMessage;
          const res = args[1] as ServerResponse;

          const headers = req.rawHeaders;
          const headersMap: { [key: string]: string } = {};

          for (let i = 0; i < headers.length / 2; i += 2) {
            headersMap[headers[i]] = headers[i + 1];
          }

          const carrier = new ContextCarrier();
          carrier.items.forEach((item) => {
            if (headersMap.hasOwnProperty(item.key)) {
              item.value = headersMap[item.key];
            }
          });

          const span = ContextManager.current.newEntrySpan('/', carrier).start();
          span.operation = (req.url || '/').replace(/\?.*/g, '');
          span.component = Component.HTTP_SERVER;
          span.layer = SpanLayer.HTTP;
          span.tag(Tag.httpURL(req.url));

          res.on('finish', () => {
            span.tag(Tag.httpStatusCode(res.statusCode)).tag(Tag.httpStatusMsg(res.statusMessage)).stop();
          });
        }
        return original.apply(this, arguments);
      };
    })(http.Server.prototype.emit);
  }
}

// noinspection JSUnusedGlobalSymbols
export default new HttpPlugin();
