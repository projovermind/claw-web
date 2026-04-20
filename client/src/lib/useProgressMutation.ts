import { useMutation, useQueryClient, UseMutationResult } from '@tanstack/react-query';
import { useProgressToastStore } from '../store/progress-toast-store';

interface UseProgressMutationOptions<TData, TVariables> {
  title: string;
  successMessage?: string;
  errorMessage?: string;
  invalidateKeys?: readonly (readonly unknown[])[];
  optimistic?: {
    queryKey: readonly unknown[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updater: (old: any, vars: TVariables) => any;
  };
  mutationFn: (vars: TVariables) => Promise<TData>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSuccess?: (data: TData, variables: TVariables, context: any) => void | Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onError?: (error: Error, variables: TVariables, context: any) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSettled?: (data: TData | undefined, error: Error | null, variables: TVariables, context: any) => void;
}

export function useProgressMutation<TData = unknown, _TError = Error, TVariables = void, _TContext = unknown>(
  options: UseProgressMutationOptions<TData, TVariables>
): UseMutationResult<TData, Error, TVariables> {
  const qc = useQueryClient();

  return useMutation<TData, Error, TVariables, { taskId: string; prev?: unknown }>({
    mutationFn: options.mutationFn,

    onMutate: async (vars) => {
      const taskId = crypto.randomUUID();
      useProgressToastStore.getState().startTask({ id: taskId, title: options.title });

      if (options.optimistic) {
        await qc.cancelQueries({ queryKey: options.optimistic.queryKey });
        const prev = qc.getQueryData(options.optimistic.queryKey);
        qc.setQueryData(
          options.optimistic.queryKey,
          (old: unknown) => options.optimistic!.updater(old, vars)
        );
        return { taskId, prev };
      }

      return { taskId };
    },

    onSuccess: async (data, vars, context) => {
      const keys = options.invalidateKeys ?? [];
      await Promise.all(
        keys.map((k) => qc.invalidateQueries({ queryKey: k }))
      );
      requestAnimationFrame(() => {
        useProgressToastStore.getState().completeTask(context!.taskId, options.successMessage);
      });
      if (options.onSuccess) {
        await options.onSuccess(data, vars, context);
      }
    },

    onError: (err, vars, context) => {
      if (!context) return;
      if (options.optimistic && context.prev !== undefined) {
        qc.setQueryData(options.optimistic.queryKey, context.prev);
      }
      useProgressToastStore.getState().failTask(context.taskId, options.errorMessage ?? err.message);
      if (options.onError) {
        options.onError(err, vars, context);
      }
    },

    onSettled: options.onSettled as Parameters<typeof useMutation>[0]['onSettled'],
  }) as UseMutationResult<TData, Error, TVariables>;
}
