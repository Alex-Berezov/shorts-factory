import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { ErrorBodySchema } from "@sf/contracts";
import type { FastifyInstance } from "fastify";
import {
  createJsonSchemaTransformObject,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { z } from "zod";

/**
 * The named schemas of the document: every shape a route inlines and that is
 * worth one name for a generated client. It lives with the document it
 * describes, not with the first schema that went into it, so the next named
 * component (`Channel`, `Idea` in E1) is added here rather than to a module
 * about errors. Read-only: this is the registry of the whole document, and a
 * caller has no business adding to it at runtime.
 */
const DOCUMENT_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  ErrorBody: ErrorBodySchema,
};

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
 *
 * `transformObject` is what fills `components.schemas`: the per-route
 * transform inlines every shape it is given, so a schema shared by all routes
 * - the error envelope - would be repeated in each of them and named nowhere.
 * The object transform converts the named schemas once and replaces every
 * inlined copy of them with a `$ref`, which is what a generated client needs
 * to have one error type instead of one per status.
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
    transformObject: createJsonSchemaTransformObject({
      schemas: { ...DOCUMENT_SCHEMAS },
    }),
  });

  app.register(swaggerUi, { routePrefix: DOCS_ROUTE });

  // Hidden from the document it serves: a path describing the document itself
  // is noise for a generated client.
  app.get(OPENAPI_ROUTE, { schema: { hide: true } }, async () => app.swagger());
}
