import { Cancelable, DebounceSettings } from "lodash";
import debounce from "lodash/debounce";
import merge from "lodash/merge";
import qs from "qs";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import url from "url";

import { Context, RestfulReactProviderProps } from "./Context";
import { GetState } from "./Get";
import { processResponse } from "./util/processResponse";
import { useDeepCompareEffect } from "./util/useDeepCompareEffect";

export type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;

export interface UseGetProps<TData, TQueryParams> {
  /**
   * The path at which to request data,
   * typically composed by parent Gets or the RestfulProvider.
   */
  path: string;
  /** Options passed into the fetch call. */
  requestOptions?: RestfulReactProviderProps["requestOptions"];
  /**
   * Query parameters
   */
  queryParams?: TQueryParams;
  /**
   * Don't send the error to the Provider
   */
  localErrorOnly?: boolean;
  /**
   * A function to resolve data return from the backend, most typically
   * used when the backend response needs to be adapted in some way.
   */
  resolve?: (data: any) => TData;
  /**
   * Should we fetch data at a later stage?
   */
  lazy?: boolean;
  /**
   * An escape hatch and an alternative to `path` when you'd like
   * to fetch from an entirely different URL.
   *
   */
  base?: string;
  /**
   * How long do we wait between subsequent requests?
   * Uses [lodash's debounce](https://lodash.com/docs/4.17.10#debounce) under the hood.
   */
  debounce?:
    | {
        wait?: number;
        options: DebounceSettings;
      }
    | boolean
    | number;
}

export function resolvePath<TQueryParams>(base: string, path: string, queryParams: TQueryParams) {
  const appendedBase = base.endsWith("/") ? base : `${base}/`;
  const trimmedPath = path.startsWith("/") ? path.slice(1) : path;

  return url.resolve(
    appendedBase,
    Object.keys(queryParams).length ? `${trimmedPath}?${qs.stringify(queryParams)}` : trimmedPath,
  );
}

async function _fetchData<TData, TError, TQueryParams>(
  props: UseGetProps<TData, TQueryParams>,
  state: GetState<TData, TError>,
  setState: (newState: GetState<TData, TError>) => void,
  context: RestfulReactProviderProps,
  abortController: React.MutableRefObject<AbortController>,
) {
  const { base = context.base, path, resolve = (d: any) => d as TData, queryParams = {} } = props;

  if (state.loading) {
    // Abort previous requests
    abortController.current.abort();
    abortController.current = new AbortController();
  }
  const signal = abortController.current.signal;

  if (state.error || !state.loading) {
    setState({ ...state, error: null, loading: true });
  }

  const requestOptions =
    (typeof props.requestOptions === "function" ? await props.requestOptions() : props.requestOptions) || {};

  const contextRequestOptions =
    (typeof context.requestOptions === "function" ? await context.requestOptions() : context.requestOptions) || {};

  const request = new Request(
    resolvePath(base, path, { ...context.queryParams, ...queryParams }),
    merge({}, contextRequestOptions, requestOptions, { signal }),
  );

  try {
    const response = await fetch(request);
    const { data, responseError } = await processResponse(response);

    if (signal.aborted) {
      return;
    }

    if (!response.ok || responseError) {
      const error = {
        message: `Failed to fetch: ${response.status} ${response.statusText}${responseError ? " - " + data : ""}`,
        data,
        status: response.status,
      };

      setState({ ...state, loading: false, error });

      if (!props.localErrorOnly && context.onError) {
        context.onError(error, () => _fetchData(props, state, setState, context, abortController), response);
      }
      return;
    }

    setState({ ...state, error: null, loading: false, data: resolve(data) });
  } catch (e) {
    // avoid state updates when component has been unmounted
    // and when fetch/processResponse threw an error
    if (signal.aborted) {
      return;
    }
    setState({
      ...state,
      loading: false,
      error: {
        message: `Failed to fetch: ${e.message}`,
        data: e.message,
      },
    });
  }
}

type FetchData = typeof _fetchData;
type CancellableFetchData = FetchData | (FetchData & Cancelable);
type RefetchOptions<TData, TQueryParams> = Partial<Omit<UseGetProps<TData, TQueryParams>, "lazy">>;

const isCancellable = <T extends (...args: any[]) => any>(func: T): func is T & Cancelable => {
  return typeof (func as any).cancel === "function" && typeof (func as any).flush === "function";
};

export interface UseGetReturn<TData, TError, TQueryParams = {}> extends GetState<TData, TError> {
  /**
   * Absolute path resolved from `base` and `path` (context & local)
   */
  absolutePath: string;
  /**
   * Cancel the current fetch
   */
  cancel: () => void;
  /**
   * Refetch
   */
  refetch: (options?: RefetchOptions<TData, TQueryParams>) => Promise<void>;
}

export function useGet<TData = any, TError = any, TQueryParams = { [key: string]: any }>(
  path: string,
  props?: Omit<UseGetProps<TData, TQueryParams>, "path">,
): UseGetReturn<TData, TError, TQueryParams>;

export function useGet<TData = any, TError = any, TQueryParams = { [key: string]: any }>(
  props: UseGetProps<TData, TQueryParams>,
): UseGetReturn<TData, TError, TQueryParams>;

export function useGet<TData = any, TError = any, TQueryParams = { [key: string]: any }>() {
  const props: UseGetProps<TData, TError> =
    typeof arguments[0] === "object" ? arguments[0] : { ...arguments[1], path: arguments[0] };

  const context = useContext(Context);

  const fetchData = useCallback<CancellableFetchData>(
    typeof props.debounce === "object"
      ? debounce<FetchData>(_fetchData, props.debounce.wait, props.debounce.options)
      : typeof props.debounce === "number"
      ? debounce<FetchData>(_fetchData, props.debounce)
      : props.debounce
      ? debounce<FetchData>(_fetchData)
      : _fetchData,
    [props.debounce],
  );

  // Cancel fetchData on unmount (if debounce)
  useEffect(() => (isCancellable(fetchData) ? () => fetchData.cancel() : undefined), [fetchData]);

  const [state, setState] = useState<GetState<TData, TError>>({
    data: null,
    response: null,
    loading: !props.lazy,
    error: null,
  });

  const abortController = useRef(new AbortController());

  useDeepCompareEffect(() => {
    if (!props.lazy) {
      fetchData(props, state, setState, context, abortController);
    }

    return () => {
      abortController.current.abort();
      abortController.current = new AbortController();
    };
  }, [props.lazy, props.path, props.base, props.resolve, props.queryParams, props.requestOptions]);

  return {
    ...state,
    absolutePath: resolvePath(props.base || context.base, props.path, {
      ...context.queryParams,
      ...props.queryParams,
    }),
    cancel: () => {
      setState({
        ...state,
        loading: false,
      });
      abortController.current.abort();
      abortController.current = new AbortController();
    },
    refetch: (options: RefetchOptions<TData, TQueryParams> = {}) =>
      fetchData({ ...props, ...options }, state, setState, context, abortController),
  };
}
