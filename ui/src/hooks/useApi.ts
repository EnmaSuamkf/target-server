import { useCallback, useEffect, useState } from "react";
import { useUnauthorized } from "../components/AuthGate.tsx";

interface ApiState<T> {
	data: T | null;
	error: string | null;
}

/**
 * GET a JSON endpoint and re-poll it on an interval.
 * A 401 invokes `onUnauthorized` from AuthGate instead of setting an error string.
 */
export function useApi<T>(path: string | null, intervalMs?: number): ApiState<T> {
	const onUnauthorized = useUnauthorized();
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (!path) {
			setData(null);
			setError(null);
			return;
		}
		try {
			const res = await fetch(path);
			if (res.status === 401) {
				onUnauthorized?.();
				return;
			}
			if (!res.ok) throw new Error(`${path} → ${res.status}`);
			setData((await res.json()) as T);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [path, onUnauthorized]);

	useEffect(() => {
		void load();
		if (!intervalMs) return;
		const t = setInterval(() => void load(), intervalMs);
		return () => clearInterval(t);
	}, [load, intervalMs]);

	return { data, error };
}

/** POST JSON and return the parsed body (or throw). */
export async function postJson<T>(path: string, body: unknown): Promise<{ res: Response; data: T }> {
	const res = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = (await res.json()) as T;
	return { res, data };
}

export function usePost<TBody, TResult>() {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const run = useCallback(async (path: string, body: TBody): Promise<{ ok: true; data: TResult; res: Response } | { ok: false; res: Response; data: TResult }> => {
		setBusy(true);
		setError(null);
		try {
			const { res, data } = await postJson<TResult>(path, body);
			if (!res.ok) return { ok: false, res, data };
			return { ok: true, data, res };
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			throw e;
		} finally {
			setBusy(false);
		}
	}, []);

	return { run, busy, error };
}
