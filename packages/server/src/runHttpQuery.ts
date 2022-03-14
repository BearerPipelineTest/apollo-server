import type { GraphQLServerOptions } from './graphqlOptions';
import { formatApolloErrors } from './errors';
import {
  processGraphQLRequest,
  GraphQLRequest,
  GraphQLRequestContext,
  GraphQLResponse,
} from './requestPipeline';
import type {
  BaseContext,
  HTTPGraphQLRequest,
  HTTPGraphQLResponse,
} from '@apollo/server-types';
import { newCachePolicy } from './cachePolicy';
import type { GraphQLError, GraphQLFormattedError } from 'graphql';

// TODO(AS4): keep rethinking whether Map is what we want or if we just
// do want to use (our own? somebody else's?) Headers class.
// TODO(AS4): probably should do something better if you pass upper-case
// to get/has/delete as well.
export class HeaderMap extends Map<string, string> {
  override set(key: string, value: string): this {
    if (key.toLowerCase() !== key) {
      throw Error(`Headers must be lower-case, unlike ${key}`);
    }
    return super.set(key, value);
  }
}

export class HttpQueryError extends Error {
  public statusCode: number;
  public isGraphQLError: boolean;
  // TODO(AS4): consider making this a map (or whatever type we settle on
  // for headers)
  public headers: Map<string, string>;

  constructor(
    statusCode: number,
    message: string,
    isGraphQLError: boolean = false,
    headers?: Map<string, string>,
  ) {
    super(message);
    this.name = 'HttpQueryError';
    this.statusCode = statusCode;
    this.isGraphQLError = isGraphQLError;
    // This throws if any header names have capital leaders.
    this.headers = new HeaderMap(headers ?? []);
  }

  asHTTPGraphQLResponse(): HTTPGraphQLResponse {
    return {
      statusCode: this.statusCode,
      // Copy to HeaderMap to ensure lower-case keys.
      headers: new HeaderMap([
        ['content-type', 'text/plain'],
        ...this.headers.entries(),
      ]),
      completeBody: this.message,
      bodyChunks: null,
    };
  }
}

export function isHttpQueryError(e: unknown): e is HttpQueryError {
  return (e as any)?.name === 'HttpQueryError';
}

const NODE_ENV = process.env.NODE_ENV ?? '';

// TODO(AS4): this probably can be un-exported once we clean up context function
// error handling
export function debugFromNodeEnv(nodeEnv: string = NODE_ENV) {
  return nodeEnv !== 'production' && nodeEnv !== 'test';
}

function fieldIfString(
  o: Record<string, any>,
  fieldName: string,
): string | undefined {
  if (typeof o[fieldName] === 'string') {
    return o[fieldName];
  }
  return undefined;
}

function jsonParsedFieldIfNonEmptyString(
  o: Record<string, any>,
  fieldName: string,
): Record<string, any> | undefined {
  if (typeof o[fieldName] === 'string' && o[fieldName]) {
    let hopefullyRecord;
    try {
      hopefullyRecord = JSON.parse(o[fieldName]);
    } catch {
      throw new HttpQueryError(
        400,
        `The ${fieldName} search parameter contains invalid JSON.`,
      );
    }
    if (!isStringRecord(hopefullyRecord)) {
      throw new HttpQueryError(
        400,
        `The ${fieldName} search parameter should contain a JSON-encoded object.`,
      );
    }
    return hopefullyRecord;
  }
  return undefined;
}

function fieldIfRecord(
  o: Record<string, any>,
  fieldName: string,
): Record<string, any> | undefined {
  if (isStringRecord(o[fieldName])) {
    return o[fieldName];
  }
  return undefined;
}

function isStringRecord(o: any): o is Record<string, any> {
  return o && typeof o === 'object' && !Buffer.isBuffer(o) && !Array.isArray(o);
}

function isNonEmptyStringRecord(o: any): o is Record<string, any> {
  return isStringRecord(o) && Object.keys(o).length > 0;
}

function ensureQueryIsStringOrMissing(query: any) {
  if (!query || typeof query === 'string') {
    return;
  }
  // Check for a common error first.
  if (query.kind === 'Document') {
    throw new HttpQueryError(
      400,
      "GraphQL queries must be strings. It looks like you're sending the " +
        'internal graphql-js representation of a parsed query in your ' +
        'request instead of a request in the GraphQL query language. You ' +
        'can convert an AST to a string using the `print` function from ' +
        '`graphql`, or use a client like `apollo-client` which converts ' +
        'the internal representation to a string for you.',
    );
  } else {
    throw new HttpQueryError(400, 'GraphQL queries must be strings.');
  }
}

// This function should not throw.
export async function runHttpQuery<TContext extends BaseContext>(
  httpRequest: HTTPGraphQLRequest,
  context: TContext,
  options: GraphQLServerOptions<TContext>,
): Promise<HTTPGraphQLResponse> {
  try {
    if (options.debug === undefined) {
      options.debug = debugFromNodeEnv(options.nodeEnv);
    }

    let graphqlRequest: GraphQLRequest;

    switch (httpRequest.method) {
      case 'POST':
        // TODO(AS4): If it's an array, some error about enabling batching?
        if (!isNonEmptyStringRecord(httpRequest.body)) {
          return new HttpQueryError(
            400,
            'POST body missing, invalid Content-Type, or JSON object has no keys.',
          ).asHTTPGraphQLResponse();
        }

        ensureQueryIsStringOrMissing(httpRequest.body.query);

        graphqlRequest = {
          query: fieldIfString(httpRequest.body, 'query'),
          operationName: fieldIfString(httpRequest.body, 'operationName'),
          variables: fieldIfRecord(httpRequest.body, 'variables'),
          extensions: fieldIfRecord(httpRequest.body, 'extensions'),
          http: httpRequest,
        };

        break;
      case 'GET':
        if (!isNonEmptyStringRecord(httpRequest.searchParams)) {
          return new HttpQueryError(
            400,
            'GET query missing.',
          ).asHTTPGraphQLResponse();
        }

        ensureQueryIsStringOrMissing(httpRequest.searchParams.query);

        graphqlRequest = {
          query: fieldIfString(httpRequest.searchParams, 'query'),
          operationName: fieldIfString(
            httpRequest.searchParams,
            'operationName',
          ),
          variables: jsonParsedFieldIfNonEmptyString(
            httpRequest.searchParams,
            'variables',
          ),
          extensions: jsonParsedFieldIfNonEmptyString(
            httpRequest.searchParams,
            'extensions',
          ),
          http: httpRequest,
        };

        break;
      default:
        return new HttpQueryError(
          405,
          'Apollo Server supports only GET/POST requests.',
          false,
          new HeaderMap([['allow', 'GET, POST']]),
        ).asHTTPGraphQLResponse();
    }

    const plugins = [...(options.plugins ?? [])];

    // GET operations should only be queries (not mutations). We want to throw
    // a particular HTTP error in that case.
    if (httpRequest.method === 'GET') {
      plugins.unshift({
        async requestDidStart() {
          return {
            async didResolveOperation({ operation }) {
              if (operation.operation !== 'query') {
                throw new HttpQueryError(
                  405,
                  `GET supports only query operation`,
                  false,
                  new HeaderMap([['allow', 'POST']]),
                );
              }
            },
          };
        },
      });
    }

    // Create a local copy of `options`, based on global options, but maintaining
    // that appropriate plugins are in place.
    options = {
      ...options,
      plugins,
    };

    const partialResponse: Pick<HTTPGraphQLResponse, 'headers' | 'statusCode'> =
      {
        headers: new HeaderMap([['content-type', 'application/json']]),
        statusCode: undefined,
      };

    const requestContext: GraphQLRequestContext<TContext> = {
      // While `logger` is guaranteed by internal Apollo Server usage of
      // this `processHTTPRequest` method, this method has been publicly
      // exported since perhaps as far back as Apollo Server 1.x.  Therefore,
      // for compatibility reasons, we'll default to `console`.
      // TODO(AS4): Probably when we refactor 'options' this special case will
      // go away.
      logger: options.logger || console,
      schema: options.schema,
      request: graphqlRequest,
      response: { http: partialResponse },
      // We clone the context because there are some assumptions that every operation
      // execution has a brand new context object; specifically, in order to implement
      // willResolveField we put a Symbol on the context that is specific to a particular
      // request pipeline execution. We could avoid this if we had a better way of
      // instrumenting execution.
      //
      // We don't want to do a deep clone here, because one of the main advantages of
      // using batched HTTP requests is to share context across operations for a
      // single request.
      // NOTE: THIS IS DUPLICATED IN ApolloServerBase.prototype.executeOperation.
      context: cloneObject(context),
      // TODO(AS4): fix ! as part of fixing GraphQLServerOptions
      cache: options.cache!,
      debug: options.debug,
      metrics: {},
      overallCachePolicy: newCachePolicy(),
    };
    const response = await processGraphQLRequest(options, requestContext);

    // This code is run on parse/validation errors and any other error that
    // doesn't reach GraphQL execution
    if (response.errors && typeof response.data === 'undefined') {
      // don't include options, since the errors have already been formatted
      return {
        statusCode: response.http?.statusCode || 400,
        headers: new HeaderMap([
          ['content-type', 'application/json'],
          ...response.http?.headers.entries(),
        ]),
        completeBody: prettyJSONStringify({
          // TODO(AS4): Understand why we don't call formatApolloErrors here.
          errors: response.errors,
          extensions: response.extensions,
        }),
        bodyChunks: null,
      };
    }

    const body = prettyJSONStringify(serializeGraphQLResponse(response));

    partialResponse.headers.set(
      'content-length',
      Buffer.byteLength(body, 'utf8').toString(),
    );

    return {
      ...partialResponse,
      completeBody: body,
      bodyChunks: null,
    };
  } catch (error) {
    if (error instanceof HttpQueryError) {
      return error.asHTTPGraphQLResponse();
    }

    return {
      statusCode: 500,
      headers: new HeaderMap([['content-type', 'application/json']]),
      completeBody: prettyJSONStringify({
        errors: formatApolloErrors([error as Error], {
          debug: options.debug,
          formatter: options.formatError,
        }),
      }),
      bodyChunks: null,
    };
  }
}

function serializeGraphQLResponse(
  response: GraphQLResponse,
): Pick<GraphQLResponse, 'errors' | 'data' | 'extensions'> {
  // See https://github.com/facebook/graphql/pull/384 for why
  // errors comes first.
  return {
    errors: response.errors,
    data: response.data,
    extensions: response.extensions,
  };
}

// The result of a curl does not appear well in the terminal, so we add an extra new line
function prettyJSONStringify(value: any) {
  return JSON.stringify(value) + '\n';
}

export function cloneObject<T extends Object>(object: T): T {
  return Object.assign(Object.create(Object.getPrototypeOf(object)), object);
}

type ContextFunctionExecutionResult<TContext extends BaseContext> =
  | { errorHTTPGraphQLResponse: HTTPGraphQLResponse }
  | { errorHTTPGraphQLResponse: null; context: TContext };
// TODO(AS4): Move this into ApolloServer.
// TODO(AS4): Errors here should get into plugins somehow.
export async function executeContextFunction<TContext extends BaseContext>(
  contextFunction: () => Promise<TContext>,
  // TODO(AS4): These won't be necessary once it's on ApolloServer.
  options: {
    formatter?: (error: GraphQLError) => GraphQLFormattedError;
    debug?: boolean;
  },
): Promise<ContextFunctionExecutionResult<TContext>> {
  try {
    return { context: await contextFunction(), errorHTTPGraphQLResponse: null };
  } catch (e: any) {
    // XXX `any` isn't ideal, but this is the easiest thing for now, without
    // introducing a strong `instanceof GraphQLError` requirement.
    e.message = `Context creation failed: ${e.message}`;
    // For errors that are not internal, such as authentication, we
    // should provide a 400 response
    const statusCode =
      e.extensions &&
      e.extensions.code &&
      e.extensions.code !== 'INTERNAL_SERVER_ERROR'
        ? 400
        : 500;
    return {
      errorHTTPGraphQLResponse: {
        statusCode,
        headers: new HeaderMap([['content-type', 'application/json']]),
        completeBody: prettyJSONStringify({
          errors: formatApolloErrors([e as Error], options),
        }),
        bodyChunks: null,
      },
    };
  }
}
