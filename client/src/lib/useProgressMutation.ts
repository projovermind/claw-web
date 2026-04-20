import { useMutation, useQueryClient, QueryKey } from '@tanstack/react-query';
import { useProgressToastStore } from '../store/progress-toast-store';

interface UseProgressMutationOptions<TData, TError, TVariables, TContext> {
  title: string;
  successMessage: string;
  errorMessage?: string;
  invalidateKeys?: QueryKey[];
  optimistic?: {
    queryKey: QueryKey;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updater: (old: any, variables: TVariables) => any;
  };
  mutationFn: (variables: TVariables) => Promise<TData>;
  onSuccess?: (data: TData, variables: TVariables, context: TContext | undefined) => void | Promise<void>;
  onError?: (error: TError, variables: TVariables, context: TContext | undefined) => void;
  onSettled?: (data: TData | undefined, error: TError | null, variables: TVariables, context: TContext | undefined) => void;
}

let _taskCounter = 0;
function nextTaskId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++_taskCounter}`;
}

export function useProgressMutation<TData = unknown, TError = Error, TVariables = void, TContext = unknown>(
  options: UseProgressMutationOptions<TData, TError, TVariables, TContext>
) {
  const qc = useQueryClient();

  return useMutation<TData, TError, TVariables, { taskId: string; snapshot?: unknown }>({
    mutationFn: options.mutationFn,
    onMutate: async (variables) => {
      const { startTask } = useProgressToastStore.getState();
      const taskId = nextTaskId('task');
      startTask({ id: taskId, title: options.title });
      let snapshot: unknown;

      if (options.optimistic) {
        await qc.cancelQueries({ queryKey: options.optimistic.queryKey });
        snapshot = qc.getQueryData(options.optimistic.queryKey);
        qc.setQueryData(
          options.optimistic.queryKey,
          (old: unknown) => options.optimistic!.updater(old, variables)
        );
      }

      return { taskId, snapshot };
    },
    onSuccess: async (data, variables, context) => {
      const { completeTask } = useProgressToastStore.getState();
      if (options.invalidateKeys && options.invalidateKeys.length > 0) {
        await Promise.all(
          options.invalidateKeys.map((key) => qc.invalidateQueries({ queryKey: key }))
        );
      }
      requestAnimationFrame(() => {
        completeTask(context!.taskId, options.successMessage);
      });
      if (options.onSuccess) {
        await options.onSuccess(data, variables, context as any);
      }
    },
    onError: (error, variables, context) => {
      const { failTask } = useProgressToastStore.getState();
      if (context?.taskId) {
        failTask(context.taskId, options.errorMessage || '오류가 발생했습니다.');
      }
      if (options.optimistic && context?.snapshot !== undefined) {
        qc.setQueryData(options.optimistic.queryKey, context.snapshot);
      }
      if (options.onError) {
        options.onError(error, variables, context as any);
      }
    },
    onSettled: options.onSettled as any,
  });
}
