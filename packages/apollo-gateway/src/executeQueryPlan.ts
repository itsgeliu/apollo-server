import {
  GraphQLExecutionResult,
  GraphQLRequestContext,
} from 'apollo-server-core';
import {
  execute,
  GraphQLError,
  Kind,
  OperationDefinitionNode,
  OperationTypeNode,
  print,
  SelectionSetNode,
  TypeNameMetaFieldDef,
  VariableDefinitionNode,
  GraphQLFieldResolver,
} from 'graphql';
import { GraphQLDataSource } from './datasources/types';
import {
  FetchNode,
  PlanNode,
  QueryPlan,
  ResponsePath,
  OperationContext,
} from './QueryPlan';
import { deepMerge } from './utilities/deepMerge';
import { getResponseName } from './utilities/graphql';

export type ServiceMap = {
  [serviceName: string]: GraphQLDataSource;
};

type ResultMap = Record<string, any>;

interface ExecutionContext<TContext> {
  queryPlan: QueryPlan;
  operationContext: OperationContext;
  serviceMap: ServiceMap;
  requestContext: GraphQLRequestContext<TContext>;
  errors: GraphQLError[];
}

export async function executeQueryPlan<TContext>(
  queryPlan: QueryPlan,
  serviceMap: ServiceMap,
  requestContext: GraphQLRequestContext<TContext>,
  operationContext: OperationContext,
): Promise<GraphQLExecutionResult> {
  const errors: GraphQLError[] = [];

  const context: ExecutionContext<TContext> = {
    queryPlan,
    operationContext,
    serviceMap,
    requestContext,
    errors,
  };

  let data: ResultMap | undefined = Object.create(null);

  if (queryPlan.node) {
    await executeNode(context, queryPlan.node, data!, []);
  }

  // FIXME: Re-executing the query is a pretty heavy handed way of making sure
  // only explicitly requested fields are included and field ordering follows
  // the original query.
  // It is also used to allow execution of introspection queries though.
  try {
    ({ data } = await execute({
      schema: operationContext.schema,
      document: {
        kind: Kind.DOCUMENT,
        definitions: [
          operationContext.operation,
          ...Object.values(operationContext.fragments),
        ],
      },
      rootValue: data,
      variableValues: requestContext.request.variables,
      // FIXME: GraphQL extensions currentl wraps every field and creates
      // a field resolver. Because of this, when using with ApolloServer
      // the defaultFieldResolver isn't called. We keep this here
      // because it is the correct solution and when ApolloServer removes
      // GraphQLExtensions this will be how alias support is maintained
      fieldResolver: defaultFieldResolverWithAliasSupport,
    }));
  } catch (error) {
    return { errors: [error] };
  }

  return errors.length === 0 ? { data } : { errors, data };
}

async function executeNode<TContext>(
  context: ExecutionContext<TContext>,
  node: PlanNode,
  results: ResultMap | ResultMap[],
  path: ResponsePath,
): Promise<void> {
  if (!results) {
    return;
  }

  try {
    switch (node.kind) {
      case 'Sequence':
        for (const childNode of node.nodes) {
          await executeNode(context, childNode, results, path);
        }
        break;
      case 'Parallel':
        await Promise.all(
          node.nodes.map(async childNode =>
            executeNode(context, childNode, results, path),
          ),
        );
        break;
      case 'Flatten':
        await executeNode(
          context,
          node.node,
          flattenResultsAtPath(results, node.path),
          [...path, ...node.path],
        );
        break;
      case 'Fetch':
        await executeFetch(context, node, results, path);
        break;
    }
  } catch (error) {
    context.errors.push(error);
  }
}

async function executeFetch<TContext>(
  context: ExecutionContext<TContext>,
  fetch: FetchNode,
  results: ResultMap | ResultMap[],
  _path: ResponsePath,
): Promise<void> {
  const service = context.serviceMap[fetch.serviceName];
  if (!service) {
    throw new Error(`Couldn't find service with name "${fetch.serviceName}"`);
  }

  const operationType = context.operationContext.operation.operation;

  const entities = Array.isArray(results) ? results : [results];
  if (entities.length < 1) return;

  let variables = Object.create(null);
  if (fetch.variableUsages) {
    for (const variableName of Object.keys(fetch.variableUsages)) {
      const providedVariables = context.requestContext.request.variables;
      if (
        providedVariables &&
        typeof providedVariables[variableName] !== 'undefined'
      ) {
        variables[variableName] = providedVariables[variableName];
      }
    }
  }

  if (!fetch.requires) {
    const dataReceivedFromService = await sendOperation(
      context,
      operationForRootFetch(fetch, operationType),
      variables,
    );

    for (const entity of entities) {
      deepMerge(entity, dataReceivedFromService);
    }
  } else {
    const requires = fetch.requires;

    const representations: ResultMap[] = [];
    const representationToEntity: number[] = [];

    entities.forEach((entity, index) => {
      const representation = executeSelectionSet(entity, requires);
      if (representation && representation[TypeNameMetaFieldDef.name]) {
        representations.push(representation);
        representationToEntity.push(index);
      }
    });

    if ('representations' in variables) {
      throw new Error(`Variables cannot contain key "representations"`);
    }

    const dataReceivedFromService = await sendOperation(
      context,
      operationForEntitiesFetch(fetch),
      { ...variables, representations },
    );

    if (!dataReceivedFromService) {
      return;
    }

    if (
      !(
        dataReceivedFromService._entities &&
        Array.isArray(dataReceivedFromService._entities)
      )
    ) {
      throw new Error(`Expected "data._entities" in response to be an array`);
    }

    const receivedEntities = dataReceivedFromService._entities;

    if (receivedEntities.length !== representations.length) {
      throw new Error(
        `Expected "data._entities" to contain ${representations.length} elements`,
      );
    }

    for (let i = 0; i < entities.length; i++) {
      deepMerge(entities[representationToEntity[i]], receivedEntities[i]);
    }
  }

  async function sendOperation<TContext>(
    context: ExecutionContext<TContext>,
    operation: OperationDefinitionNode,
    variables: Record<string, any>,
  ): Promise<ResultMap | void> {
    const source = print(operation);

    const response = await service.process<TContext>({
      request: {
        query: source,
        variables,
      },
      context: context.requestContext.context,
    });

    if (response.errors) {
      const errors = response.errors.map(error =>
        downstreamServiceError(
          error.message,
          fetch.serviceName,
          source,
          variables,
          error.extensions,
          error.path,
        ),
      );
      context.errors.push(...errors);
    }

    return response.data;
  }
}

/**
 *
 * @param source Result of GraphQL execution.
 * @param selectionSet
 */
function executeSelectionSet(
  source: Record<string, any>,
  selectionSet: SelectionSetNode,
): Record<string, any> {
  const result: Record<string, any> = Object.create(null);

  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD:
        const responseName = getResponseName(selection);
        const selectionSet = selection.selectionSet;

        // Null is a valid value for a response, provided that the types match.
        // Presumably the underlying service has validated that result, so we
        // can pass it through here
        if (typeof source[responseName] === 'undefined') {
          throw new Error(`Field "${responseName}" was not found in response.`);
        }
        if (Array.isArray(source[responseName])) {
          result[responseName] = source[responseName].map((value: any) =>
            selectionSet ? executeSelectionSet(value, selectionSet) : value,
          );
        } else if (selectionSet) {
          result[responseName] = executeSelectionSet(
            source[responseName],
            selectionSet,
          );
        } else {
          result[responseName] = source[responseName];
        }
        break;
      case Kind.INLINE_FRAGMENT:
        if (!selection.typeCondition) continue;

        const typename = source && source['__typename'];
        if (!typename) continue;

        if (typename === selection.typeCondition.name.value) {
          deepMerge(
            result,
            executeSelectionSet(source, selection.selectionSet),
          );
        }
        break;
    }
  }

  return result;
}

function flattenResultsAtPath(value: any, path: ResponsePath): any {
  if (path.length === 0) return value;
  if (value === undefined || value === null) return value;

  const [current, ...rest] = path;
  if (current === '@') {
    return value.flatMap((element: any) => flattenResultsAtPath(element, rest));
  } else {
    return flattenResultsAtPath(value[current], rest);
  }
}

function downstreamServiceError(
  message: string | undefined,
  serviceName: string,
  query: string,
  variables?: Record<string, any>,
  extensions?: Record<string, any>,
  path?: ReadonlyArray<string | number> | undefined,
) {
  if (!message) {
    message = `Error while fetching subquery from service "${serviceName}"`;
  }
  extensions = {
    code: 'DOWNSTREAM_SERVICE_ERROR',
    serviceName,
    query,
    variables,
    ...extensions,
  };
  return new GraphQLError(
    message,
    undefined,
    undefined,
    undefined,
    path,
    undefined,
    extensions,
  );
}

function mapFetchNodeToVariableDefinitions(
  node: FetchNode,
): VariableDefinitionNode[] {
  return node.variableUsages ? Object.values(node.variableUsages) : [];
}

function operationForRootFetch(
  fetch: FetchNode,
  operation: OperationTypeNode = 'query',
): OperationDefinitionNode {
  return {
    kind: Kind.OPERATION_DEFINITION,
    operation,
    selectionSet: fetch.selectionSet,
    variableDefinitions: mapFetchNodeToVariableDefinitions(fetch),
  };
}

function operationForEntitiesFetch(fetch: FetchNode): OperationDefinitionNode {
  const representationsVariable = {
    kind: Kind.VARIABLE,
    name: { kind: Kind.NAME, value: 'representations' },
  };

  return {
    kind: Kind.OPERATION_DEFINITION,
    operation: 'query',
    variableDefinitions: ([
      {
        kind: Kind.VARIABLE_DEFINITION,
        variable: representationsVariable,
        type: {
          kind: Kind.NON_NULL_TYPE,
          type: {
            kind: Kind.LIST_TYPE,
            type: {
              kind: Kind.NON_NULL_TYPE,
              type: {
                kind: Kind.NAMED_TYPE,
                name: { kind: Kind.NAME, value: '_Any' },
              },
            },
          },
        },
      },
    ] as VariableDefinitionNode[]).concat(
      mapFetchNodeToVariableDefinitions(fetch),
    ),
    selectionSet: {
      kind: Kind.SELECTION_SET,
      selections: [
        {
          kind: Kind.FIELD,
          name: { kind: Kind.NAME, value: '_entities' },
          arguments: [
            {
              kind: Kind.ARGUMENT,
              name: {
                kind: Kind.NAME,
                value: representationsVariable.name.value,
              },
              value: representationsVariable,
            },
          ],
          selectionSet: fetch.selectionSet,
        },
      ],
    },
  };
}

export const defaultFieldResolverWithAliasSupport: GraphQLFieldResolver<
  any,
  any
> = function(source, args, contextValue, info) {
  // ensure source is a value for which property access is acceptable.
  if (typeof source === 'object' || typeof source === 'function') {
    // if this is an alias, check it first because a downstream service
    // would have returned the data *already cast* to an alias responseName
    const property = source[info.path.key];
    if (typeof property === 'function') {
      return source[info.fieldName](args, contextValue, info);
    }
    return property;
  }
};
