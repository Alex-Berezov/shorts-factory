import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

/** Where the browsable documentation is mounted. */
export const DOCS_ROUTE = "/docs";
/** Where the raw document is served. */
export const OPENAPI_ROUTE = "/openapi.json";
/** Said when the process was not told which build it is. */
const UNKNOWN_VERSION = "unknown";

/**
 * Zod schemas declared on routes become both the runtime validation and the
 * OpenAPI document.
 *
 * `transform: jsonSchemaTransform` is what converts a Zod schema into the
 * JSON Schema the document needs; without it the paths appear with no request
 * or response shape at all, which reads as a working `/docs` and documents
 * nothing. Both this and the compilers must be in place before any route is
 * registered - `@fastify/swagger` collects routes as they are added.
 */
export interface OpenapiOptions {
  /**
   * Version of the running build, the same one `/system/status` reports; a
   * build that was not told which version it is says `unknown` rather than a
   * number a generated client would believe.
   */
  version: string | null;
}

export function registerOpenapi(
  app: FastifyInstance,
  options: OpenapiOptions,
): void {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(swagger, {
    openapi: {
      info: {
        title: "AI Shorts Factory API",
        description:
          "Internal API. Every route except /health requires basic auth.",
        version: options.version ?? UNKNOWN_VERSION,
      },
      servers: [{ url: "/", description: "This instance" }],
    },
    transform: jsonSchemaTransform,
  });

  app.register(swaggerUi, { routePrefix: DOCS_ROUTE });

  // Hidden from the document it serves: a path describing the document itself
  // is noise for a generated client.
  app.get(OPENAPI_ROUTE, { schema: { hide: true } }, async () => app.swagger());
}
