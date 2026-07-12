export interface SharedAbortableOperation<T> {
	readonly promise: Promise<T>;
	readonly controller: AbortController;
	readonly onAbandoned: () => void;
	waiterCount: number;
	settled: boolean;
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function releaseSharedOperationWaiter<T>(operation: SharedAbortableOperation<T>): void {
	operation.waiterCount -= 1;
	if (operation.waiterCount > 0 || operation.settled) return;
	operation.controller.abort();
	operation.onAbandoned();
	void operation.promise.catch(() => undefined);
}

export function createSharedAbortableOperation<T>(
	run: (signal: AbortSignal) => Promise<T>,
	onSettled: () => void,
	onAbandoned: () => void,
): SharedAbortableOperation<T> {
	const controller = new AbortController();
	let operation: SharedAbortableOperation<T>;
	const promise = run(controller.signal).finally(() => {
		operation.settled = true;
		onSettled();
	});
	operation = {
		controller,
		promise,
		onAbandoned,
		waiterCount: 0,
		settled: false,
	};
	void promise.catch(() => undefined);
	return operation;
}

export function awaitSharedAbortableOperation<T>(
	operation: SharedAbortableOperation<T>,
	signal: AbortSignal | undefined,
): Promise<T> {
	signal?.throwIfAborted();
	operation.waiterCount += 1;
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			releaseSharedOperationWaiter(operation);
			reject(signal === undefined ? new DOMException("Aborted", "AbortError") : abortReason(signal));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		operation.promise.then(
			(value) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				releaseSharedOperationWaiter(operation);
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				releaseSharedOperationWaiter(operation);
				reject(error);
			},
		);
	});
}
