import type { CatalogSyncRole, CatalogSyncRolesResponse } from "../api/types.ts";
import { useApi } from "../hooks/useApi.ts";

export const CATALOG_ADMIN_ROLE_ID = "admin";

export function syncRolesCardMeta(syncRoleIds: string[] | undefined): string {
	const count = (syncRoleIds ?? []).filter((id) => id !== CATALOG_ADMIN_ROLE_ID).length;
	return count === 0 ? "Sync: admins only" : `Sync: ${count} role${count === 1 ? "" : "s"}`;
}

function rolesForPicker(roles: CatalogSyncRole[] | undefined): CatalogSyncRole[] {
	const list = roles ?? [];
	if (list.some((role) => role.id === CATALOG_ADMIN_ROLE_ID)) return list;
	return [{ id: CATALOG_ADMIN_ROLE_ID, name: "Administrator" }, ...list];
}

export function SyncRolesPicker({
	selectedIds,
	onChange,
	disabled,
	permissionHint,
}: {
	selectedIds: string[];
	onChange: (ids: string[]) => void;
	disabled: boolean;
	permissionHint: string;
}) {
	const { data } = useApi<CatalogSyncRolesResponse>(disabled ? null : "/api/catalog/sync-roles");
	const roles = rolesForPicker(data?.roles);

	return (
		<div className="catalog-block">
			<span className="catalog-field-label">Roles that can sync this resource</span>
			<p className="hint">{permissionHint}</p>
			<div className="catalog-picker">
				{roles.map((role) => {
					const isAdmin = role.id === CATALOG_ADMIN_ROLE_ID;
					return (
						<label key={role.id} className={`users-check${disabled || isAdmin ? " users-check--disabled" : ""}`}>
							<input
								type="checkbox"
								checked={isAdmin || selectedIds.includes(role.id)}
								disabled={disabled || isAdmin}
								onChange={(event) => {
									if (isAdmin) return;
									onChange(
										event.target.checked
											? [...new Set([...selectedIds, role.id])]
											: selectedIds.filter((id) => id !== role.id && id !== CATALOG_ADMIN_ROLE_ID),
									);
								}}
							/>
							<span>
								{role.name}
								{isAdmin ? <span className="hint">Administrators can always sync</span> : null}
							</span>
						</label>
					);
				})}
			</div>
		</div>
	);
}
