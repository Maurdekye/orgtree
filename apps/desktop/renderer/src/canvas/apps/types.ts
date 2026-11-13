export type AppState = Record<string, unknown>
export type AppPlacement = { mode:'float'|'window'|'popout'; x:number; y:number; width:number; height:number }
export interface AppEventDeclaration { name:string; description?:string }
/** sites: HTTPS sites net.fetch may ask for (host, host:port, *.domain or * for any
 * site). Declarations travel with the app and grant nothing. */
export interface AppDefinition { name:string; description:string; html:string; initial_state:AppState; capabilities:string[]; events?:AppEventDeclaration[]; sites?:string[]; width:number; height:number }
export interface CustomApp { id:string; name:string; description:string; capabilities:string[]; events?:AppEventDeclaration[]; width:number; height:number; rev:number; permission_rev?:number; is_new?:boolean; permissions:Record<string,string>; default_permissions?:Record<string,string>; sites?:string[]; site_permissions?:Record<string,string|SiteRow>; origin?:string; created_by:string; created_at?:string; updated_at:string; definition?:AppDefinition }
/** open is visibility; running is execution intent. A visible panel always runs. */
export interface CustomPanel { id:string; app:string; label:string; rev:number; open:boolean; running?:boolean; run_generation?:number; placement:AppPlacement; created_at?:string; updated_at:string; used_at:string; state?:AppState; event_seq?:number }
/** One running copy with its actual desktop state (orgtree_apps runtime). */
export interface PanelRuntime { panel:string; app:string; app_name:string; label:string; visible:boolean; run_generation:number; status:'running'|'error'|'not hosted'; error:string|null; cpu_percent:number|null; cpu_method:string|null; measured_at:string|null }
export interface AppPage<T> { kind:string; items:T[]; next_cursor:string|null; new_count?:number }
/** `body`: a fire's data exactly as it was sent (JSON text), null when not kept. */
export interface PanelEvent {seq:number;name:string;payload:unknown;body?:string|null;actor:string;at:string}
export interface PanelEvents {panel:string;events:PanelEvent[];next_cursor:number|null;oldest_retained:number|null}
/** One app-level Permission history entry (orgtree_apps permission_history). */
export interface PermissionHistoryPage {app:string;entries:PermissionHistoryEntry[];next_cursor:number|null}
/** A private-network row the engine stored: the user's allow, with the addresses pinned then (spec 3.4). */
/** One saved login as the desktop learns it: where, what kind and when. The value never comes back (spec 4.2). */
export interface SiteLogin {site:string;kind:'bearer'|'header';set_at:string}
export interface SiteRow {value:string;addresses?:string[]}
/** What the engine sees resolving one declared site now (net_classify). */
export interface SiteClass {site:string;class:'private'|'public'|'never'|'mixed'|'unresolved';addresses:string[];pinned:string[];allowed:boolean;moved:boolean;tailscale:boolean}
export interface PermissionHistoryEntry {seq:number;capability:string;site:string|null;permission:'ask'|'allow'|'deny'|'default'|'once'|'allow-private'|'repin'|'login-saved'|'login-replaced'|'login-removed';detail?:string|null;via:'change'|'prompt'|'code';actor:string;panel:string|null;at:string}
