const PAGE_SIZES = [10, 25, 50, 100];

interface PaginationProps {
	/** Unpaged match count, or null while the first page is still loading. */
	total: number | null;
	page: number;
	pageSize: number;
	/** Rows actually on this page — the range readout counts what you can see. */
	shown: number;
	onPage: (page: number) => void;
	onPageSize: (size: number) => void;
	/** Plural noun for the readout, e.g. "workflows". */
	label: string;
}

/**
 * The pager under a paged list: a plain "Showing 1-25 of 134" readout, a page
 * size picker, and Previous/Next.
 *
 * Deliberately not infinite scroll and not numbered page links: the list polls
 * every few seconds and re-sorts by last activity, so the only navigation that
 * stays honest under a moving list is "the next page from here". One row of
 * controls, no hidden state.
 */
export function Pagination({ total, page, pageSize, shown, onPage, onPageSize, label }: PaginationProps) {
	if (total == null) return null;
	const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
	const first = total === 0 ? 0 : page * pageSize + 1;
	const last = page * pageSize + shown;

	return (
		<div className="pager">
			<span className="pager__range">
				{total === 0 ? (
					`No ${label}`
				) : (
					<>
						{"Showing "}
						<strong>{`${first.toLocaleString()}-${last.toLocaleString()}`}</strong>
						{" of "}
						<strong>{total.toLocaleString()}</strong>
						{` ${label}`}
					</>
				)}
			</span>

			<div className="pager__controls">
				<label className="pager__size" htmlFor="page-size">
					{"Rows per page"}
					<select
						id="page-size"
						className="select select--sm"
						value={pageSize}
						onChange={(e) => onPageSize(Number(e.target.value))}
						title="How many workflows to show at once"
					>
						{PAGE_SIZES.map((n) => (
							<option key={n} value={n}>
								{n}
							</option>
						))}
					</select>
				</label>

				<span className="pager__page">{`Page ${(page + 1).toLocaleString()} of ${(lastPage + 1).toLocaleString()}`}</span>

				<button
					type="button"
					className="btn btn--sm"
					disabled={page <= 0}
					onClick={() => onPage(page - 1)}
					title={page <= 0 ? "You are on the first page" : "Show the previous page"}
				>
					{"< Previous"}
				</button>
				<button
					type="button"
					className="btn btn--sm"
					disabled={page >= lastPage}
					onClick={() => onPage(page + 1)}
					title={page >= lastPage ? "You are on the last page" : "Show the next page"}
				>
					{"Next >"}
				</button>
			</div>
		</div>
	);
}
