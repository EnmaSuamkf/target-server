import { useCallback, useEffect, useState } from "react";

interface ApiState<T> {
	data: T | null;
	error: string | null;
}

/**
 * GET a JSON endpoint and re-poll it on an interval.
 *
 * Pass `path: null` to stand down (the workflow detail does this while no
 * workflow is selected) — the hook clears its data instead of fetching. The
 * previous payload is kept while a refresh is in flight, so the dashboard never
 * blinks back to a loading state between polls.
 */
export function useApi<T>(path: string | null, intervalMs?: number): ApiState<T> {
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
			if (!res.ok) throw new Error(`${path} → ${res.status}`);
			setData((await res.json()) as T);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [path]);

	useEffect(() => {
		void load();
		if (!intervalMs) return;
		const t = setInterval(() => void load(), intervalMs);
		return () => clearInterval(t);
	}, [load, intervalMs]);

	return { data, error };
}
