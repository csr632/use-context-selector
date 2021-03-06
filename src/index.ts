import {
  ComponentType,
  Context as ContextOrig,
  FC,
  MutableRefObject,
  Provider,
  createElement,
  createContext as createContextOrig,
  useContext as useContextOrig,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
} from 'react';
import {
  unstable_NormalPriority as NormalPriority,
  unstable_runWithPriority as runWithPriority,
} from 'scheduler';

import { batchedUpdates } from './batchedUpdates';

const CONTEXT_VALUE = Symbol();
const ORIGINAL_PROVIDER = Symbol();

const isSSR = typeof window === 'undefined'
  || /ServerSideRendering/.test(window.navigator && window.navigator.userAgent);

const useIsomorphicLayoutEffect = isSSR ? useEffect : useLayoutEffect;

type ContextValue<Value> = {
  [CONTEXT_VALUE]: {
    /* "v"alue     */ v: MutableRefObject<Value>;
    /* versio"n"   */ n: MutableRefObject<number>;
    /* "l"isteners */ l: Set<(action: [number] | [number, Value]) => void>;
    /* "u"pdate    */ u: <T>(thunk: () => T) => void;
  };
};

export interface Context<Value> {
  Provider: ComponentType<{ value: Value }>;
  displayName?: string;
}

const createProvider = <Value>(
  ProviderOrig: Provider<ContextValue<Value>>,
): FC<{ value: Value }> => ({ value, children }) => {
    const valueRef = useRef(value);
    const versionRef = useRef(0);
    const contextValue = useRef<ContextValue<Value>>();
    if (!contextValue.current) {
      const listeners = new Set<(action: [number] | [number, Value]) => void>();
      const update = (thunk: () => void) => {
        batchedUpdates(() => {
          versionRef.current += 1;
          listeners.forEach((listener) => listener([versionRef.current]));
          thunk();
        });
      };
      contextValue.current = {
        [CONTEXT_VALUE]: {
          /* "v"alue     */ v: valueRef,
          /* versio"n"   */ n: versionRef,
          /* "l"isteners */ l: listeners,
          /* "u"pdate    */ u: update,
        },
      };
    }
    useIsomorphicLayoutEffect(() => {
      valueRef.current = value;
      versionRef.current += 1;
      runWithPriority(NormalPriority, () => {
        (contextValue.current as ContextValue<Value>)[CONTEXT_VALUE].l.forEach((listener) => {
          listener([versionRef.current, value]);
        });
      });
    }, [value]);
    return createElement(ProviderOrig, { value: contextValue.current }, children);
  };

const identity = <T>(x: T) => x;

/**
 * This creates a special context for `useContextSelector`.
 *
 * @example
 * import { createContext } from 'use-context-selector';
 *
 * const PersonContext = createContext({ firstName: '', familyName: '' });
 */
export function createContext<Value>(defaultValue: Value) {
  const context = createContextOrig<ContextValue<Value>>({
    [CONTEXT_VALUE]: {
      /* "v"alue     */ v: { current: defaultValue },
      /* versio"n"   */ n: { current: -1 },
      /* "l"isteners */ l: new Set(),
      /* "u"pdate    */ u: (f) => f(),
    },
  });
  (context as unknown as {
    [ORIGINAL_PROVIDER]: Provider<ContextValue<Value>>;
  })[ORIGINAL_PROVIDER] = context.Provider;
  (context as unknown as Context<Value>).Provider = createProvider(context.Provider);
  delete (context as any).Consumer; // no support for Consumer
  return context as unknown as Context<Value>;
}

/**
 * This hook returns context selected value by selector.
 *
 * It will only accept context created by `createContext`.
 * It will trigger re-render if only the selected value is referentially changed.
 *
 * The selector should return referentially equal result for same input for better performance.
 *
 * @example
 * import { useContextSelector } from 'use-context-selector';
 *
 * const firstName = useContextSelector(PersonContext, state => state.firstName);
 */
export function useContextSelector<Value, Selected>(
  context: Context<Value>,
  selector: (value: Value) => Selected,
) {
  const contextValue = useContextOrig(
    context as unknown as ContextOrig<ContextValue<Value>>,
  )[CONTEXT_VALUE];
  if (typeof process === 'object' && process.env.NODE_ENV !== 'production') {
    if (!contextValue) {
      throw new Error('useContextSelector requires special context');
    }
  }
  const {
    /* "v"alue     */ v: { current: value },
    /* versio"n"   */ n: { current: version },
    /* "l"isteners */ l: listeners,
  } = contextValue;
  const selected = selector(value);
  const [, dispatch] = useReducer((
    prev: { value: Value; selected: Selected },
    next: [number] | [number, Value],
  ) => {
    if (version < next[0]) {
      try {
        if (next.length === 2 && (
          Object.is(prev.value, next[1]) || Object.is(prev.selected, selector(next[1])))
        ) {
          return prev; // do not update
        }
      } catch (e) {
        // ignored (stale props or some other reason)
      }
      return { value, selected }; // schedule update
    }
    if (Object.is(prev.value, value) || Object.is(prev.selected, selected)) {
      return prev; // bail out
    }
    return { value, selected };
  }, { value, selected });
  useIsomorphicLayoutEffect(() => {
    listeners.add(dispatch);
    return () => {
      listeners.delete(dispatch);
    };
  }, [listeners]);
  return selected;
}

/**
 * This hook returns the entire context value.
 * Use this instead of React.useContext for consistent behavior.
 *
 * @example
 * import { useContext } from 'use-context-selector';
 *
 * const person = useContext(PersonContext);
 */
export function useContext<Value>(context: Context<Value>) {
  return useContextSelector(context, identity);
}

/**
 * This hook returns an update function that accepts a thunk function
 *
 * Use this for a function that will change a value.
 *
 * @example
 * import { useContextUpdate } from 'use-context-selector';
 *
 * const update = useContextUpdate();
 * update(() => setState(...));
 */
export function useContextUpdate<Value>(context: Context<Value>) {
  const contextValue = useContextOrig(
    context as unknown as ContextOrig<ContextValue<Value>>,
  )[CONTEXT_VALUE];
  if (typeof process === 'object' && process.env.NODE_ENV !== 'production') {
    if (!contextValue) {
      throw new Error('useContextUpdate requires special context');
    }
  }
  const { u: update } = contextValue;
  return update;
}

/**
 * This is a Provider component for bridging multiple react roots
 *
 * @example
 * const valueToBridge = useBridgeValue(PersonContext);
 * return (
 *   <Renderer>
 *     <BridgeProvider context={PersonContext} value={valueToBridge}>
 *       {children}
 *     </BridgeProvider>
 *   </Renderer>
 * );
 */
export const BridgeProvider: FC<{
  context: Context<any>;
  value: any;
}> = ({ context, value, children }) => {
  const { [ORIGINAL_PROVIDER]: ProviderOrig } = context as unknown as {
    [ORIGINAL_PROVIDER]: Provider<unknown>;
  };
  if (typeof process === 'object' && process.env.NODE_ENV !== 'production') {
    if (!ProviderOrig) {
      throw new Error('BridgeProvider requires special context');
    }
  }
  return createElement(ProviderOrig, { value }, children);
};

/**
 * This hook return a value for BridgeProvider
 */
export const useBridgeValue = (context: Context<any>) => {
  const bridgeValue = useContextOrig(context as unknown as ContextOrig<ContextValue<unknown>>);
  const contextValue = bridgeValue[CONTEXT_VALUE];
  if (typeof process === 'object' && process.env.NODE_ENV !== 'production') {
    if (!contextValue) {
      throw new Error('useBridgeValue requires special context');
    }
  }
  const { l: listeners } = contextValue;
  const [, forceUpdate] = useReducer((c) => c + 1, 0);
  useIsomorphicLayoutEffect(() => {
    listeners.add(forceUpdate);
    return () => {
      listeners.delete(forceUpdate);
    };
  }, [listeners]);
  return bridgeValue as any;
};
